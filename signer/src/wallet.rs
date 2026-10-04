//! The wallet worker: one background thread that owns the wallet database and
//! the lightwalletd connection, and does everything that touches the chain.
//!
//! - Sync: every 30s, `zcash_client_backend::sync::run` scans new blocks into
//!   `data/wallet.sqlite`, using a small in-memory block cache implemented here.
//! - Vaults: every auction gets its own ZIP 32 account (a "vault"), so one
//!   auction's deposits can never be spent by another auction's settlement.
//!   Each bid gets its own never-reused deposit address in that account.
//! - Settlement: one shielded transaction that pays everyone an auction owes and
//!   leaves the vault empty. It is refused unless the payments add up to
//!   exactly what the vault holds.
//!
//! Keeping all of this on one thread means the SQLite handle is never shared.

use std::{
    fmt,
    num::{NonZeroU32, NonZeroUsize},
    path::PathBuf,
    str::FromStr,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use anyhow::{anyhow, Context};
use async_trait::async_trait;
use rand::rngs::OsRng;
use secrecy::SecretVec;
use tokio::sync::{mpsc, oneshot};
use tonic::{
    transport::{Channel, ClientTlsConfig},
    Code,
};
use zcash_address::ZcashAddress;
use zcash_client_backend::{
    data_api::{
        chain::{error::Error as ChainError, BlockCache, BlockSource},
        error::Error as WalletError,
        scanning::ScanRange,
        wallet::{
            create_proposed_transactions, decrypt_and_store_transaction,
            input_selection::{
                GreedyInputSelector, GreedyInputSelectorError, SpendPolicy,
            },
            propose_transfer, ConfirmationsPolicy, SpendingKeys,
        },
        Account, AccountBalance, AccountBirthday, TransactionDataRequest,
        TransactionStatus, WalletRead, WalletWrite,
    },
    fees::{standard::MultiOutputChangeStrategy, DustOutputPolicy, SplitPolicy, StandardFeeRule},
    proto::{
        compact_formats::CompactBlock,
        service::{self, compact_tx_streamer_client::CompactTxStreamerClient, RawTransaction},
    },
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{
    error::SqliteClientError, util::SystemClock, wallet::commitment_tree,
    wallet::init::init_wallet_db, AccountUuid, ReceivedNoteId, WalletDb,
};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedSpendingKey};
use zcash_primitives::transaction::{fees::zip317, Transaction, TxId};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, TestNetwork},
    memo::{Memo, MemoBytes},
    value::Zatoshis,
    ShieldedPool,
};
use zip32::AccountId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zip321::{Payment, TransactionRequest};

const SYNC_INTERVAL: Duration = Duration::from_secs(30);
const BATCH_SIZE: u32 = 1_000;

type Db = WalletDb<rusqlite::Connection, TestNetwork, SystemClock, OsRng>;

/// The concrete error type of the transfer APIs for a SQLite wallet
/// (same instantiation ECC's zcash-devtool uses).
type TransferError = WalletError<
    SqliteClientError,
    commitment_tree::Error,
    GreedyInputSelectorError,
    zip317::FeeError,
    zip317::FeeError,
    ReceivedNoteId,
>;

// ---------------------------------------------------------------------------
// In-memory block cache
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct CacheError(String);

impl fmt::Display for CacheError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "block cache error: {}", self.0)
    }
}

impl std::error::Error for CacheError {}

/// Holds downloaded compact blocks between download and scan. Blocks are
/// deleted by the sync engine once scanned, so this stays small.
#[derive(Default)]
pub struct MemoryBlockCache {
    blocks: Mutex<Vec<CompactBlock>>,
}

fn height_of(block: &CompactBlock) -> BlockHeight {
    BlockHeight::from_u32(block.height as u32)
}

impl BlockSource for MemoryBlockCache {
    type Error = CacheError;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        // Copy out under the lock, then call back without holding it.
        let mut blocks: Vec<CompactBlock> = self
            .blocks
            .lock()
            .map_err(|_| ChainError::BlockSource(CacheError("lock poisoned".into())))?
            .iter()
            .filter(|b| from_height.map_or(true, |h| height_of(b) >= h))
            .cloned()
            .collect();
        blocks.sort_by_key(|b| b.height);

        for block in blocks.into_iter().take(limit.unwrap_or(usize::MAX)) {
            with_block(block)?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemoryBlockCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        let blocks = self.blocks.lock().map_err(|_| CacheError("lock poisoned".into()))?;
        Ok(blocks
            .iter()
            .map(height_of)
            .filter(|h| range.map_or(true, |r| r.block_range().contains(h)))
            .max())
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let blocks = self.blocks.lock().map_err(|_| CacheError("lock poisoned".into()))?;
        let mut out: Vec<CompactBlock> = blocks
            .iter()
            .filter(|b| range.block_range().contains(&height_of(b)))
            .cloned()
            .collect();
        out.sort_by_key(|b| b.height);
        Ok(out)
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut blocks = self.blocks.lock().map_err(|_| CacheError("lock poisoned".into()))?;
        // Replace any existing block at the same height (e.g. after a reorg).
        let new_heights: Vec<u64> = compact_blocks.iter().map(|b| b.height).collect();
        blocks.retain(|b| !new_heights.contains(&b.height));
        blocks.extend(compact_blocks);
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        let mut blocks = self.blocks.lock().map_err(|_| CacheError("lock poisoned".into()))?;
        blocks.retain(|b| !range.block_range().contains(&height_of(b)));
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Worker: status, config, commands
// ---------------------------------------------------------------------------

/// Shared, read-only-to-HTTP view of the worker's progress.
#[derive(Default)]
pub struct SyncStatus {
    pub scanned_height: AtomicU32,
    pub chain_tip: AtomicU32,
    pub last_error: Mutex<Option<String>>,
}

pub struct SyncConfig {
    pub seed: Vec<u8>,
    pub db_path: PathBuf,
    pub server: String,
    /// Height to start scanning from when the wallet DB is first created.
    /// If None, starts 1000 blocks (~20 hours on testnet) below the chain tip.
    pub birthday: Option<u32>,
    /// Where the vault registry (public bookkeeping, no keys) is kept.
    pub vaults_path: PathBuf,
    /// Confirmations a deposit needs before it can be spent. None means the
    /// ZIP 315 default: 10 for money received from other wallets.
    pub min_confirmations: Option<u32>,
}

/// One payment of a settlement, as the web app asks for it.
#[derive(Deserialize, Clone)]
pub struct SettlePayment {
    pub to: String,
    pub zatoshis: u64,
    #[serde(default)]
    pub memo: Option<String>,
    /// The network fee is taken, in equal shares, from the payments marked here.
    #[serde(default)]
    pub pays_fee: bool,
}

#[derive(Serialize)]
pub struct NewVault {
    pub vault_id: String,
    pub birthday_height: u32,
}

#[derive(Serialize)]
pub struct Deposit {
    pub txid: String,
    pub mined_height: Option<u32>,
    pub confirmations: u32,
    pub pool: String,
    pub value_zatoshis: u64,
    /// The deposit address this arrived at: that is how a deposit is matched to a bid.
    pub to_address: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PaidOut {
    pub to: String,
    pub zatoshis: u64,
}

#[derive(Serialize)]
pub struct Settlement {
    pub txid: String,
    /// "pending", "mined" or "expired"
    pub status: String,
    pub mined_height: Option<u32>,
    pub fee_zatoshis: u64,
    pub payments: Vec<PaidOut>,
}

#[derive(Serialize)]
pub struct VaultInfo {
    pub vault_id: String,
    pub birthday_height: u32,
    pub chain_tip: u32,
    pub scanned_height: u32,
    pub min_confirmations: u32,
    pub balance_total_zatoshis: u64,
    pub balance_spendable_zatoshis: u64,
    pub deposits: Vec<Deposit>,
    /// The most recent settlement, if any.
    pub settlement: Option<Settlement>,
    /// Every settlement, oldest first. There is more than one only when money
    /// arrived after the first (a late deposit, returned in a later settlement).
    pub settlements: Vec<Settlement>,
}

pub enum Command {
    CreateVault {
        reply: oneshot::Sender<anyhow::Result<NewVault>>,
    },
    NewAddress {
        vault_id: String,
        reply: oneshot::Sender<anyhow::Result<String>>,
    },
    VaultInfo {
        vault_id: String,
        reply: oneshot::Sender<anyhow::Result<VaultInfo>>,
    },
    Settle {
        vault_id: String,
        payments: Vec<SettlePayment>,
        reply: oneshot::Sender<anyhow::Result<Settlement>>,
    },
}

/// What the signer remembers about a vault. Bookkeeping only: the keys are
/// derived from the wallet seed and the account index when needed.
#[derive(Serialize, Deserialize, Clone)]
struct VaultRecord {
    account_index: u32,
    birthday_height: u32,
    /// Oldest first. Usually one; see `VaultInfo::settlements`.
    #[serde(default)]
    settlements: Vec<SettlementRecord>,
    /// Read from files written before `settlements` existed.
    #[serde(default, skip_serializing)]
    settlement: Option<SettlementRecord>,
}

#[derive(Serialize, Deserialize, Clone)]
struct SettlementRecord {
    txid: String,
    fee_zatoshis: u64,
    payments: Vec<PaidOut>,
}

/// Starts the worker on its own thread and returns the queue for commands.
pub fn spawn(config: SyncConfig, status: Arc<SyncStatus>) -> mpsc::UnboundedSender<Command> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Command>();
    std::thread::Builder::new()
        .name("zcash-wallet".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("wallet runtime");
            rt.block_on(async move {
                let cache = MemoryBlockCache::default();
                run_sync(&config, &cache, &status).await;
                // A ticker, not a sleep inside the loop: a sleep would start again
                // every time a request arrived, so a steady stream of requests
                // (a page polling every few seconds) would stop the wallet from
                // ever scanning a new block.
                let mut ticker = tokio::time::interval(SYNC_INTERVAL);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                ticker.tick().await; // the first tick is immediate, and we have just synced
                loop {
                    tokio::select! {
                        _ = ticker.tick() => {
                            run_sync(&config, &cache, &status).await;
                        }
                        cmd = rx.recv() => match cmd {
                            Some(Command::CreateVault { reply }) => {
                                let result = create_vault(&config).await;
                                if let Err(e) = &result {
                                    eprintln!("create vault error: {e:#}");
                                } else {
                                    // A new account adds a scan range; scan it now so
                                    // deposits show up without waiting for the next pass.
                                    run_sync(&config, &cache, &status).await;
                                }
                                let _ = reply.send(result);
                            }
                            Some(Command::NewAddress { vault_id, reply }) => {
                                let result = new_address(&config, &vault_id);
                                if let Err(e) = &result {
                                    eprintln!("new address for vault {vault_id} error: {e:#}");
                                }
                                let _ = reply.send(result);
                            }
                            Some(Command::VaultInfo { vault_id, reply }) => {
                                let _ = reply.send(vault_info(&config, &status, &vault_id));
                            }
                            Some(Command::Settle { vault_id, payments, reply }) => {
                                // Build against the real chain tip, so the transaction's
                                // expiry height is not already in the past.
                                run_sync(&config, &cache, &status).await;
                                let result = settle(&config, &vault_id, &payments).await;
                                if let Err(e) = &result {
                                    eprintln!("settle vault {vault_id} error: {e:#}");
                                }
                                let _ = reply.send(result);
                            }
                            None => break, // HTTP side has shut down
                        },
                    }
                }
            });
        })
        .expect("spawn wallet thread");
    tx
}

const SYNC_PASS_LIMIT: Duration = Duration::from_secs(600);

async fn run_sync(config: &SyncConfig, cache: &MemoryBlockCache, status: &SyncStatus) {
    let result = match tokio::time::timeout(SYNC_PASS_LIMIT, sync_once(config, cache, status)).await {
        Ok(r) => r,
        Err(_) => Err(anyhow!("sync pass took longer than {}s; will retry", SYNC_PASS_LIMIT.as_secs())),
    };
    match result {
        Ok(()) => {
            *status.last_error.lock().unwrap() = None;
            println!(
                "synced to {} (tip {})",
                status.scanned_height.load(Ordering::Relaxed),
                status.chain_tip.load(Ordering::Relaxed),
            );
        }
        Err(e) => {
            eprintln!("sync error: {e:#}");
            *status.last_error.lock().unwrap() = Some(format!("{e:#}"));
        }
    }
}

async fn connect(server: &str) -> anyhow::Result<CompactTxStreamerClient<Channel>> {
    let mut endpoint = Channel::from_shared(server.to_string())
        .with_context(|| format!("bad lightwalletd URL: {server}"))?
        // Never wait forever on the server: bound connecting and each request.
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120));
    if let Some(rest) = server.strip_prefix("https://") {
        let host = rest.split(':').next().unwrap_or(rest).to_string();
        endpoint = endpoint.tls_config(
            ClientTlsConfig::new()
                .domain_name(host)
                .assume_http2(true)
                .with_webpki_roots(),
        )?;
    }
    let channel = endpoint
        .connect()
        .await
        .with_context(|| format!("connecting to {server}"))?;
    Ok(CompactTxStreamerClient::new(channel))
}

fn open_db(config: &SyncConfig) -> anyhow::Result<Db> {
    let mut db = WalletDb::for_path(&config.db_path, TestNetwork, SystemClock, OsRng)?;
    init_wallet_db(&mut db, None).map_err(|e| anyhow!("init wallet db: {e:?}"))?;
    Ok(db)
}

// ---------------------------------------------------------------------------
// Proof 2 + step C: sync and enhance
// ---------------------------------------------------------------------------

// Sync and enhance
// ---------------------------------------------------------------------------

async fn sync_once(
    config: &SyncConfig,
    cache: &MemoryBlockCache,
    status: &SyncStatus,
) -> anyhow::Result<()> {
    let mut client = connect(&config.server).await?;

    let latest = client
        .get_latest_block(service::ChainSpec::default())
        .await?
        .into_inner();
    let tip = u32::try_from(latest.height)?;
    status.chain_tip.store(tip, Ordering::Relaxed);

    let mut db = open_db(config)?;

    // First run: register the seed's account 0 with a birthday, so scanning
    // starts there and not at genesis. Account 0 holds no auction money; each
    // auction gets its own account (1, 2, 3, ...).
    if house_account(config, &db)?.is_none() {
        let birthday_height = config.birthday.unwrap_or(tip.saturating_sub(1_000));
        let tree_state = client
            .get_tree_state(service::BlockId {
                height: u64::from(birthday_height.saturating_sub(1)),
                ..Default::default()
            })
            .await?
            .into_inner();
        let birthday = AccountBirthday::from_treestate(tree_state, None)
            .map_err(|e| anyhow!("building birthday: {e:?}"))?;
        db.create_account("house", &SecretVec::new(config.seed.clone()), &birthday, None)?;
        println!("wallet db created; scanning from height {birthday_height}");
    }

    zcash_client_backend::sync::run(&mut client, &TestNetwork, cache, &mut db, BATCH_SIZE)
        .await
        .map_err(|e| anyhow!("{e}"))?;

    if let Some(meta) = db.block_max_scanned()? {
        status
            .scanned_height
            .store(u32::from(meta.block_height()), Ordering::Relaxed);
    }

    enhance(&mut client, &mut db).await?;
    rebroadcast_pending(&mut client, &db, &config.db_path).await;
    Ok(())
}

/// Fetch a full transaction from lightwalletd. `None` if the server doesn't know it.
async fn fetch_transaction(
    client: &mut CompactTxStreamerClient<Channel>,
    chain_tip: BlockHeight,
    txid: TxId,
) -> anyhow::Result<Option<(Transaction, Option<BlockHeight>)>> {
    let request = service::TxFilter {
        hash: txid.as_ref().to_vec(),
        ..Default::default()
    };
    let raw = match client.get_transaction(request).await {
        Ok(response) => response.into_inner(),
        Err(status) if status.code() == Code::NotFound => return Ok(None),
        Err(status) => return Err(status.into()),
    };
    let mined_height = (raw.height > 0 && raw.height <= u64::from(u32::MAX))
        .then(|| BlockHeight::from_u32(raw.height as u32));
    let tx = Transaction::read(
        &raw.data[..],
        BranchId::for_height(&TestNetwork, mined_height.unwrap_or(chain_tip)),
    )?;
    Ok(Some((tx, mined_height)))
}

/// Step C: download full transactions the wallet asks for, so memos (which
/// compact blocks don't carry) are decrypted and stored, and track the status
/// of transactions we sent.
async fn enhance(client: &mut CompactTxStreamerClient<Channel>, db: &mut Db) -> anyhow::Result<()> {
    let Some(chain_tip) = db.chain_height()? else {
        return Ok(());
    };
    let requests = db.transaction_data_requests()?;
    if !requests.is_empty() {
        println!("  {} transaction data request(s)", requests.len());
    }
    for request in requests {
        match request {
            TransactionDataRequest::GetStatus(txid) => {
                let status = match fetch_transaction(client, chain_tip, txid).await? {
                    None => TransactionStatus::TxidNotRecognized,
                    Some((_, Some(h))) => TransactionStatus::Mined(h),
                    Some((_, None)) => TransactionStatus::NotInMainChain,
                };
                db.set_transaction_status(txid, status)?;
            }
            TransactionDataRequest::Enhancement(txid) => {
                match fetch_transaction(client, chain_tip, txid).await? {
                    None => db.set_transaction_status(txid, TransactionStatus::TxidNotRecognized)?,
                    Some((tx, mined_height)) => {
                        decrypt_and_store_transaction(&TestNetwork, db, &tx, mined_height)?
                    }
                }
            }
            // Other request kinds concern transparent addresses, which we don't use.
            #[allow(unreachable_patterns)]
            _ => {}
        }
    }
    Ok(())
}

/// Sends a raw transaction to lightwalletd. Errors if the node rejects it.
async fn broadcast(
    client: &mut CompactTxStreamerClient<Channel>,
    tx: &Transaction,
) -> anyhow::Result<()> {
    let mut raw = RawTransaction::default();
    tx.write(&mut raw.data)?;
    let response = client.send_transaction(raw).await?.into_inner();
    if response.error_code != 0 {
        return Err(anyhow!(
            "node rejected transaction ({}): {}",
            response.error_code,
            response.error_message
        ));
    }
    Ok(())
}

/// Re-sends our own transactions that are neither mined nor expired, the way
/// wallets normally do, in case an earlier broadcast was lost.
async fn rebroadcast_pending(
    client: &mut CompactTxStreamerClient<Channel>,
    db: &Db,
    db_path: &std::path::Path,
) {
    let pending: Vec<[u8; 32]> = match (|| -> anyhow::Result<Vec<[u8; 32]>> {
        let conn = rusqlite::Connection::open_with_flags(
            db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        rusqlite::vtab::array::load_module(&conn)?;
        let mut stmt = conn.prepare(
            "SELECT txid FROM v_transactions
             WHERE account_balance_delta < 0 AND mined_height IS NULL
               AND COALESCE(expired_unmined, 0) = 0",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, Vec<u8>>(0))?;
        let mut out = Vec::new();
        for r in rows {
            if let Ok(arr) = <[u8; 32]>::try_from(r?) {
                out.push(arr);
            }
        }
        Ok(out)
    })() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("rebroadcast: could not list pending transactions: {e:#}");
            return;
        }
    };

    for bytes in pending {
        let txid = TxId::from_bytes(bytes);
        match db.get_transaction(txid) {
            Ok(Some(tx)) => match broadcast(client, &tx).await {
                Ok(()) => println!("rebroadcast {txid}: accepted"),
                Err(e) if format!("{e:#}").contains("already in state") => {
                    println!("rebroadcast {txid}: node already has it (mined or in mempool)")
                }
                Err(e) => println!("rebroadcast {txid}: {e:#}"),
            },
            Ok(None) => {}
            Err(e) => eprintln!("rebroadcast {txid}: {e}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
/// Connects only now (proving can take a while, and a connection opened before
/// proving gets closed by the server), and retries with a fresh connection.
async fn broadcast_with_retries(config: &SyncConfig, txid: TxId, tx: &Transaction) -> anyhow::Result<()> {
    let mut last_err = None;
    for attempt in 1..=3 {
        println!("broadcasting {txid} via {} (attempt {attempt})", config.server);
        let result: anyhow::Result<()> = async {
            let mut client = connect(&config.server).await?;
            broadcast(&mut client, tx).await
        }
        .await;
        match result {
            Ok(()) => {
                println!("broadcast {txid} accepted");
                return Ok(());
            }
            Err(e) => {
                eprintln!("broadcast attempt {attempt} failed: {e:#}");
                last_err = Some(e);
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
    // The transaction is saved; the sync loop keeps rebroadcasting it until it
    // is mined or expires.
    Err(last_err.unwrap().context(format!(
        "transaction {txid} was created but broadcast failed; it will be retried automatically"
    )))
}

// ---------------------------------------------------------------------------
// Accounts and vault bookkeeping
// ---------------------------------------------------------------------------

fn spendable_of(balance: &AccountBalance) -> u64 {
    balance.sapling_balance().spendable_value().into_u64()
        + balance.orchard_balance().spendable_value().into_u64()
        + balance.ironwood_balance().spendable_value().into_u64()
}

fn spending_key(config: &SyncConfig, account_index: u32) -> anyhow::Result<UnifiedSpendingKey> {
    let index = AccountId::try_from(account_index).map_err(|_| anyhow!("bad account index"))?;
    UnifiedSpendingKey::from_seed(&TestNetwork, &config.seed, index)
        .map_err(|e| anyhow!("deriving account key: {e:?}"))
}

fn account_for(config: &SyncConfig, db: &Db, account_index: u32) -> anyhow::Result<Option<AccountUuid>> {
    let usk = spending_key(config, account_index)?;
    Ok(db
        .get_account_for_ufvk(&usk.to_unified_full_viewing_key())?
        .map(|a| a.id()))
}

/// The seed's account 0, if registered yet. It only anchors the wallet's
/// birthday; auction money never goes there.
fn house_account(config: &SyncConfig, db: &Db) -> anyhow::Result<Option<AccountUuid>> {
    account_for(config, db, 0)
}

fn load_vaults(config: &SyncConfig) -> BTreeMap<String, VaultRecord> {
    let mut vaults: BTreeMap<String, VaultRecord> = std::fs::read_to_string(&config.vaults_path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    for record in vaults.values_mut() {
        if let Some(old) = record.settlement.take() {
            record.settlements.insert(0, old);
        }
    }
    vaults
}

fn save_vaults(config: &SyncConfig, vaults: &BTreeMap<String, VaultRecord>) -> anyhow::Result<()> {
    let tmp = config.vaults_path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(vaults)?)?;
    std::fs::rename(&tmp, &config.vaults_path)?; // atomic replace
    Ok(())
}

fn vault_record(config: &SyncConfig, vault_id: &str) -> anyhow::Result<VaultRecord> {
    load_vaults(config)
        .get(vault_id)
        .cloned()
        .ok_or_else(|| anyhow!("unknown vault {vault_id}"))
}

fn confirmations_policy(config: &SyncConfig) -> ConfirmationsPolicy {
    match config.min_confirmations.and_then(NonZeroU32::new) {
        Some(n) => ConfirmationsPolicy::new_symmetrical(n),
        None => ConfirmationsPolicy::default(),
    }
}

/// How many confirmations a deposit from another wallet needs before it can be spent.
fn min_confirmations(config: &SyncConfig) -> u32 {
    config.min_confirmations.filter(|n| *n > 0).unwrap_or(10)
}

fn pool_name(code: i64) -> String {
    match code {
        0 => "transparent".into(),
        2 => "sapling".into(),
        3 => "orchard".into(),
        4 => "ironwood".into(),
        other => format!("pool {other}"),
    }
}

// ---------------------------------------------------------------------------
// Vaults: one account per auction
// ---------------------------------------------------------------------------

/// Opens a vault for a new auction: a fresh ZIP 32 account derived from the
/// wallet seed. Its birthday is the current tip, since nothing can have been
/// paid to it before now.
async fn create_vault(config: &SyncConfig) -> anyhow::Result<NewVault> {
    let mut client = connect(&config.server).await?;
    let tip = u32::try_from(
        client
            .get_latest_block(service::ChainSpec::default())
            .await?
            .into_inner()
            .height,
    )?;
    let birthday_height = tip.saturating_sub(1);
    let tree_state = client
        .get_tree_state(service::BlockId {
            height: u64::from(birthday_height.saturating_sub(1)),
            ..Default::default()
        })
        .await?
        .into_inner();
    let birthday = AccountBirthday::from_treestate(tree_state, None)
        .map_err(|e| anyhow!("building birthday: {e:?}"))?;

    let mut id_bytes = [0u8; 8];
    getrandom::getrandom(&mut id_bytes).map_err(|e| anyhow!("rng: {e}"))?;
    let vault_id: String = id_bytes.iter().map(|b| format!("{b:02x}")).collect();

    let mut db = open_db(config)?;
    if house_account(config, &db)?.is_none() {
        return Err(anyhow!("wallet not initialised yet; wait for the first sync"));
    }
    let (account, _usk) = db.create_account(
        &format!("vault-{vault_id}"),
        &SecretVec::new(config.seed.clone()),
        &birthday,
        None,
    )?;
    let account_index = db
        .get_account(account)?
        .and_then(|a| a.source().key_derivation().map(|d| u32::from(d.account_index())))
        .ok_or_else(|| anyhow!("new vault account has no derivation"))?;

    let mut vaults = load_vaults(config);
    vaults.insert(
        vault_id.clone(),
        VaultRecord { account_index, birthday_height, settlements: vec![], settlement: None },
    );
    save_vaults(config, &vaults)?;
    println!("vault {vault_id} opened (account {account_index}, birthday {birthday_height})");
    Ok(NewVault { vault_id, birthday_height })
}

/// A fresh deposit address in a vault: one per bid, never reused. It has an
/// Orchard receiver and nothing else, so every deposit lands in the same
/// shielded pool and a settlement never has to move value between pools
/// (which would show the amount moved on the public chain).
fn new_address(config: &SyncConfig, vault_id: &str) -> anyhow::Result<String> {
    let record = vault_record(config, vault_id)?;
    if !record.settlements.is_empty() {
        return Err(anyhow!("vault {vault_id} has been settled; it takes no new deposits"));
    }
    let mut db = open_db(config)?;
    let account = account_for(config, &db, record.account_index)?
        .ok_or_else(|| anyhow!("vault {vault_id} is not in the wallet database"))?;
    let (address, _index) = db
        .get_next_available_address(account, UnifiedAddressRequest::ORCHARD)?
        .ok_or_else(|| anyhow!("could not derive a new address for vault {vault_id}"))?;
    Ok(address.encode(&TestNetwork))
}

fn read_only(config: &SyncConfig) -> anyhow::Result<rusqlite::Connection> {
    let conn = rusqlite::Connection::open_with_flags(
        &config.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    rusqlite::vtab::array::load_module(&conn)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(conn)
}

/// Money that arrived in a vault from outside it, with the address it came to.
fn read_deposits(config: &SyncConfig, account: AccountUuid, tip: u32) -> anyhow::Result<Vec<Deposit>> {
    let conn = read_only(config)?;
    let mut stmt = conn.prepare(
        "SELECT txid, tx_mined_height, output_pool, value, to_address
         FROM v_tx_outputs
         WHERE to_account_uuid = ?1
           AND from_account_uuid IS NULL
           AND is_change = 0
         ORDER BY tx_mined_height IS NULL, tx_mined_height, txid",
    )?;
    let uuid = account.expose_uuid();
    let rows = stmt.query_map([uuid.as_bytes().to_vec()], |row| {
        Ok((
            row.get::<_, Vec<u8>>(0)?,
            row.get::<_, Option<u32>>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (txid, mined_height, pool, value, to_address) = row?;
        let txid: [u8; 32] = txid.try_into().map_err(|_| anyhow!("txid is not 32 bytes"))?;
        out.push(Deposit {
            txid: TxId::from_bytes(txid).to_string(),
            mined_height,
            confirmations: mined_height.map_or(0, |h| tip.saturating_sub(h) + 1),
            pool: pool_name(pool),
            value_zatoshis: u64::try_from(value).unwrap_or(0),
            to_address,
        });
    }
    Ok(out)
}

/// "pending", "mined" or "expired" for one of our own transactions.
fn transaction_status(config: &SyncConfig, txid: &str) -> anyhow::Result<(String, Option<u32>)> {
    let bytes = TxId::from_hex(txid).ok_or_else(|| anyhow!("bad txid"))?;
    let conn = read_only(config)?;
    let mut stmt = conn.prepare(
        "SELECT mined_height, COALESCE(expired_unmined, 0) FROM v_transactions WHERE txid = ?1 LIMIT 1",
    )?;
    let row = stmt
        .query_map([bytes.as_ref().to_vec()], |r| Ok((r.get::<_, Option<u32>>(0)?, r.get::<_, bool>(1)?)))?
        .next()
        .transpose()?;
    Ok(match row {
        Some((Some(height), _)) => ("mined".into(), Some(height)),
        Some((None, true)) => ("expired".into(), None),
        _ => ("pending".into(), None),
    })
}

fn settlements_of(config: &SyncConfig, record: &VaultRecord) -> anyhow::Result<Vec<Settlement>> {
    record
        .settlements
        .iter()
        .map(|s| {
            let (status, mined_height) = transaction_status(config, &s.txid)?;
            Ok(Settlement {
                txid: s.txid.clone(),
                status,
                mined_height,
                fee_zatoshis: s.fee_zatoshis,
                payments: s.payments.clone(),
            })
        })
        .collect()
}

fn vault_info(config: &SyncConfig, status: &SyncStatus, vault_id: &str) -> anyhow::Result<VaultInfo> {
    let record = vault_record(config, vault_id)?;
    let db = open_db(config)?;
    let account = account_for(config, &db, record.account_index)?
        .ok_or_else(|| anyhow!("vault {vault_id} is not in the wallet database"))?;
    let (total, spendable) = db
        .get_wallet_summary(confirmations_policy(config))?
        .and_then(|s| {
            s.account_balances()
                .get(&account)
                .map(|b| (b.total().into_u64(), spendable_of(b)))
        })
        .unwrap_or((0, 0));
    let scanned = status.scanned_height.load(Ordering::Relaxed);
    let mut settlements = settlements_of(config, &record)?;
    Ok(VaultInfo {
        vault_id: vault_id.to_string(),
        birthday_height: record.birthday_height,
        chain_tip: status.chain_tip.load(Ordering::Relaxed),
        scanned_height: scanned,
        min_confirmations: min_confirmations(config),
        balance_total_zatoshis: total,
        balance_spendable_zatoshis: spendable,
        deposits: read_deposits(config, account, scanned)?,
        settlement: settlements.last().map(|s| Settlement {
            txid: s.txid.clone(),
            status: s.status.clone(),
            mined_height: s.mined_height,
            fee_zatoshis: s.fee_zatoshis,
            payments: s.payments.clone(),
        }),
        settlements: std::mem::take(&mut settlements),
    })
}

// ---------------------------------------------------------------------------
// Settlement: one shielded transaction that empties a vault
// ---------------------------------------------------------------------------

/// Shielded recipients with an Orchard receiver only. Anything else would
/// either land in a public address or cross shielded pools.
pub fn check_payout_address(address: &str) -> Result<(), String> {
    match zcash_keys::address::Address::decode(&TestNetwork, address.trim()) {
        Some(zcash_keys::address::Address::Unified(ua)) if ua.has_orchard() => Ok(()),
        Some(zcash_keys::address::Address::Unified(_)) => {
            Err("this unified address has no Orchard receiver; please use one that does".into())
        }
        Some(_) => Err("please use a shielded unified address (it starts with utest1)".into()),
        None => Err("that is not a valid Zcash testnet address".into()),
    }
}

const ALL_POOLS: [zcash_protocol::PoolType; 4] = [
    zcash_protocol::PoolType::TRANSPARENT,
    zcash_protocol::PoolType::SAPLING,
    zcash_protocol::PoolType::ORCHARD,
    zcash_protocol::PoolType::IRONWOOD,
];

/// Splits the fee equally across the payments that pay it; the first of them
/// takes any remainder. Returns the amounts actually paid.
fn apply_fee(payments: &[SettlePayment], fee: u64) -> anyhow::Result<Vec<u64>> {
    let payers: Vec<usize> = payments.iter().enumerate().filter(|(_, p)| p.pays_fee).map(|(i, _)| i).collect();
    if payers.is_empty() {
        return Err(anyhow!("no payment is marked to pay the network fee"));
    }
    let share = fee / payers.len() as u64;
    let remainder = fee % payers.len() as u64;
    let mut amounts: Vec<u64> = payments.iter().map(|p| p.zatoshis).collect();
    for (n, &i) in payers.iter().enumerate() {
        let cut = share + if n == 0 { remainder } else { 0 };
        amounts[i] = amounts[i]
            .checked_sub(cut)
            .filter(|left| *left > 0)
            .ok_or_else(|| anyhow!("payment {i} is too small to pay its share of the network fee ({cut} zat)"))?;
    }
    Ok(amounts)
}

/// Pays out everything a vault holds in one shielded transaction, then locks
/// the vault.
///
/// The rules enforced here, whatever the web app asks for:
/// - every recipient is a shielded address with an Orchard receiver;
/// - the payments add up to exactly the vault's balance: nothing stays behind
///   with the coordinator, and nothing is paid that wasn't deposited;
/// - every deposit is confirmed enough to spend;
/// - the transaction stays inside one shielded pool;
/// - one settlement at a time: a new one is refused while the last is waiting to
///   be mined. After that, a vault can settle again only if it holds money
///   again (a deposit that arrived late), and the same rules apply.
#[allow(deprecated)]
async fn settle(config: &SyncConfig, vault_id: &str, payments: &[SettlePayment]) -> anyhow::Result<Settlement> {
    let mut vaults = load_vaults(config);
    let record = vaults
        .get(vault_id)
        .cloned()
        .ok_or_else(|| anyhow!("unknown vault {vault_id}"))?;
    if let Some(previous) = record.settlements.last() {
        let (status, _) = transaction_status(config, &previous.txid)?;
        if status == "pending" {
            return Err(anyhow!(
                "vault {vault_id} has a settlement waiting to be mined (transaction {}); it can't settle again yet",
                previous.txid
            ));
        }
        println!("vault {vault_id}: last settlement {} is {status}; settling what the vault holds now", previous.txid);
    }

    if payments.is_empty() {
        return Err(anyhow!("a settlement needs at least one payment"));
    }
    for (i, p) in payments.iter().enumerate() {
        check_payout_address(&p.to).map_err(|e| anyhow!("payment {i}: {e}"))?;
        if p.zatoshis == 0 {
            return Err(anyhow!("payment {i} is for nothing"));
        }
    }

    let mut db = open_db(config)?;
    let account = account_for(config, &db, record.account_index)?
        .ok_or_else(|| anyhow!("vault {vault_id} is not in the wallet database"))?;
    let policy = confirmations_policy(config);
    let (total, spendable) = db
        .get_wallet_summary(policy)?
        .and_then(|s| {
            s.account_balances()
                .get(&account)
                .map(|b| (b.total().into_u64(), spendable_of(b)))
        })
        .unwrap_or((0, 0));
    let asked: u64 = payments.iter().map(|p| p.zatoshis).sum();
    if asked != total {
        return Err(anyhow!(
            "the payments add up to {asked} zat but the vault holds {total} zat; a settlement must pay out exactly what was deposited"
        ));
    }
    if spendable != total {
        return Err(anyhow!(
            "only {spendable} of {total} zat is confirmed enough to spend; try again when every deposit has {} confirmations",
            min_confirmations(config)
        ));
    }

    let change_strategy = MultiOutputChangeStrategy::new(
        StandardFeeRule::Zip317,
        None,
        ShieldedPool::Ironwood,
        DustOutputPolicy::default(),
        SplitPolicy::with_min_output_value(NonZeroUsize::new(1).unwrap(), Zatoshis::from_u64(10_000_000)?),
    );

    // ZIP 317 charges 5000 zat per action. With every note spent and no change,
    // a transaction needs at least max(inputs, outputs, 2) actions, and the
    // library may pad it with dummy actions for privacy. The fee comes out of
    // the payments marked `pays_fee`, so the right fee is the smallest one for
    // which the proposal balances with nothing left over.
    //
    // The search starts from the outputs alone and goes up one action at a
    // time. It must not start from the number of deposits the vault has ever
    // received: a vault that settles a second time (a late deposit, a payment
    // that arrived after the first payout) has already spent most of those,
    // and a fee that is too high leaves change and can never balance.
    let lower_bound = 5_000 * (payments.len().max(2) as u64);
    let mut chosen = None;
    let mut last_problem = String::from("no fee was tried");
    for extra_actions in 0..=128u64 {
        let fee = lower_bound + 5_000 * extra_actions;
        let amounts = match apply_fee(payments, fee) {
            Ok(a) => a,
            Err(e) => {
                last_problem = format!("{e:#}");
                break;
            }
        };
        let mut requested = Vec::with_capacity(payments.len());
        for (i, (p, amount)) in payments.iter().zip(&amounts).enumerate() {
            let to = ZcashAddress::from_str(p.to.trim()).map_err(|_| anyhow!("payment {i}: invalid address"))?;
            let memo = p
                .memo
                .as_deref()
                .map(Memo::from_str)
                .transpose()
                .map_err(|_| anyhow!("payment {i}: memo is too long (max 512 bytes)"))?
                .map(MemoBytes::from);
            requested.push(
                Payment::new(to, Some(Zatoshis::from_u64(*amount)?), memo, None, None, vec![])
                    .map_err(|e| anyhow!("payment {i} is invalid: {:?}", e.with_index(i)))?,
            );
        }
        let request = TransactionRequest::new(requested).map_err(|e| anyhow!("invalid request: {e:?}"))?;
        let attempt: Result<_, TransferError> = propose_transfer(
            &mut db,
            &TestNetwork,
            account,
            &GreedyInputSelector::new(),
            &change_strategy,
            request,
            policy,
            &SpendPolicy::default(),
            None,
            None,
        );
        match attempt {
            Ok(proposal) => {
                let step = proposal.steps().first();
                let required = step.balance().fee_required().into_u64();
                let change: u64 = step.balance().proposed_change().iter().map(|c| c.value().into_u64()).sum();
                if proposal.steps().len() == 1 && required == fee && change == 0 {
                    chosen = Some((proposal, fee, amounts));
                    break;
                }
                last_problem = format!("with a {fee} zat fee the proposal needs {required} zat and leaves {change} zat of change");
            }
            // Usually "insufficient funds": the fee for this many actions is
            // too low. Try one more action; the last problem is reported if
            // nothing balances.
            Err(e) => {
                last_problem = format!("with a {fee} zat fee: {e}");
            }
        }
    }
    let (proposal, fee, amounts) = chosen
        .ok_or_else(|| anyhow!("could not build a settlement that empties the vault exactly ({last_problem})"))?;

    // One pool only. Moving value between shielded pools shows the amount moved
    // on the public chain.
    let step = proposal.steps().first();
    let pools: Vec<String> = ALL_POOLS.iter().filter(|p| step.involves(**p)).map(|p| p.to_string()).collect();
    if pools.len() != 1 {
        return Err(anyhow!(
            "this settlement would touch more than one pool ({}), which would reveal amounts on chain; refusing",
            pools.join(", ")
        ));
    }

    let usk = spending_key(config, record.account_index)?;
    let prover = LocalTxProver::bundled();
    let txids = create_proposed_transactions(
        &mut db,
        &TestNetwork,
        &prover,
        &prover,
        &SpendingKeys::from_unified_spending_key(usk),
        OvkPolicy::Sender,
        &proposal,
        None,
    )
    .map_err(|e: TransferError| anyhow!("could not create the settlement: {e}"))?;
    if txids.len() > 1 {
        return Err(anyhow!("multi-transaction settlements are not supported"));
    }
    let txid = *txids.first();

    // Lock the vault before broadcasting: the transaction exists now, and the
    // sync loop keeps rebroadcasting it even if this first broadcast fails.
    let paid: Vec<PaidOut> = payments
        .iter()
        .zip(&amounts)
        .map(|(p, amount)| PaidOut { to: p.to.trim().to_string(), zatoshis: *amount })
        .collect();
    if let Some(r) = vaults.get_mut(vault_id) {
        r.settlements.push(SettlementRecord { txid: txid.to_string(), fee_zatoshis: fee, payments: paid.clone() });
    }
    save_vaults(config, &vaults)?;
    println!("vault {vault_id} settled in {txid}: {} payments, fee {fee} zat, pool {}", paid.len(), pools[0]);

    let tx = db
        .get_transaction(txid)?
        .ok_or_else(|| anyhow!("created settlement {txid} not found in wallet"))?;
    // A failed first broadcast is not a failed settlement: it is retried on every sync.
    if let Err(e) = broadcast_with_retries(config, txid, &tx).await {
        eprintln!("vault {vault_id}: {e:#}");
    }
    Ok(Settlement { txid: txid.to_string(), status: "pending".into(), mined_height: None, fee_zatoshis: fee, payments: paid })
}
