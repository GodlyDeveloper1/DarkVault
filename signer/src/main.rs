// Dark Vault signer. TESTNET ONLY.
//
// The only part of Dark Vault that holds keys. It keeps one wallet seed, gives
// every auction its own account (a "vault") and every bid its own deposit
// address, watches for deposits, and settles an auction in one shielded
// transaction.
//
// It has no authentication. It listens on 127.0.0.1 unless told otherwise, and
// must only ever be reachable by the Dark Vault web app.
//
// The seed file lives in ./data (gitignored). Never commit it.

mod wallet;

use axum::{
    extract::{Path as UrlPath, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    net::SocketAddr,
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};

#[derive(Serialize, Deserialize)]
struct WalletFile {
    mnemonic: String,
}

struct AppState {
    sync_status: Arc<wallet::SyncStatus>,
    wallet_tx: tokio::sync::mpsc::UnboundedSender<wallet::Command>,
}

type ApiError = (StatusCode, String);

fn data_dir() -> PathBuf {
    std::env::var("SIGNER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data"))
}

fn load_or_create_wallet(path: &PathBuf) -> WalletFile {
    if let Ok(text) = fs::read_to_string(path) {
        return serde_json::from_str(&text).expect("wallet file is corrupt");
    }
    let mut entropy = [0u8; 32];
    getrandom::getrandom(&mut entropy).expect("rng");
    let mnemonic = bip39::Mnemonic::from_entropy(&entropy).expect("mnemonic");
    let wallet = WalletFile { mnemonic: mnemonic.to_string() };
    fs::create_dir_all(path.parent().unwrap()).expect("create data dir");
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string_pretty(&wallet).unwrap()).expect("write wallet");
    fs::rename(&tmp, path).expect("save wallet"); // atomic replace
    println!("created new testnet wallet at {}", path.display());
    wallet
}

async fn health() -> &'static str {
    "ok"
}

#[derive(Serialize)]
struct Status {
    chain_tip: u32,
    scanned_height: u32,
    sync_error: Option<String>,
}

async fn status(State(s): State<Arc<AppState>>) -> Json<Status> {
    let st = &s.sync_status;
    Json(Status {
        chain_tip: st.chain_tip.load(Ordering::Relaxed),
        scanned_height: st.scanned_height.load(Ordering::Relaxed),
        sync_error: st.last_error.lock().unwrap().clone(),
    })
}

/// Sends a command to the wallet thread and waits for its answer.
async fn ask<T>(
    s: &AppState,
    make: impl FnOnce(tokio::sync::oneshot::Sender<anyhow::Result<T>>) -> wallet::Command,
) -> Result<T, ApiError> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    s.wallet_tx
        .send(make(reply))
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "wallet thread is not running".to_string()))?;
    rx.await
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "wallet thread dropped the request".to_string()))?
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("{e:#}")))
}

fn check_id(id: &str) -> Result<(), ApiError> {
    if id.len() == 16 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err((StatusCode::BAD_REQUEST, "bad vault id".into()))
    }
}

// A vault for a new auction.
async fn create_vault(State(s): State<Arc<AppState>>) -> Result<Json<wallet::NewVault>, ApiError> {
    ask(&s, |reply| wallet::Command::CreateVault { reply }).await.map(Json)
}

#[derive(Serialize)]
struct NewAddress {
    address: String,
}

// A fresh deposit address for one bid. Never reused.
async fn new_address(
    State(s): State<Arc<AppState>>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<NewAddress>, ApiError> {
    check_id(&id)?;
    let address = ask(&s, |reply| wallet::Command::NewAddress { vault_id: id, reply }).await?;
    Ok(Json(NewAddress { address }))
}

// What a vault holds: its deposits (with the address each arrived at) and its settlement, if any.
async fn vault_info(
    State(s): State<Arc<AppState>>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<wallet::VaultInfo>, ApiError> {
    check_id(&id)?;
    ask(&s, |reply| wallet::Command::VaultInfo { vault_id: id, reply }).await.map(Json)
}

#[derive(Deserialize)]
struct SettleBody {
    payments: Vec<wallet::SettlePayment>,
}

// Pay out everything the vault holds, in one shielded transaction.
async fn settle(
    State(s): State<Arc<AppState>>,
    UrlPath(id): UrlPath<String>,
    Json(body): Json<SettleBody>,
) -> Result<Json<wallet::Settlement>, ApiError> {
    check_id(&id)?;
    if body.payments.len() > 200 {
        return Err((StatusCode::BAD_REQUEST, "too many payments for one settlement".into()));
    }
    ask(&s, |reply| wallet::Command::Settle { vault_id: id, payments: body.payments, reply })
        .await
        .map(Json)
}

#[derive(Deserialize)]
struct CheckBody {
    address: String,
}

#[derive(Serialize)]
struct CheckResult {
    ok: bool,
    reason: Option<String>,
}

// Can this address be paid by a settlement? (Shielded, with an Orchard receiver.)
async fn check_address(Json(body): Json<CheckBody>) -> Json<CheckResult> {
    match wallet::check_payout_address(&body.address) {
        Ok(()) => Json(CheckResult { ok: true, reason: None }),
        Err(reason) => Json(CheckResult { ok: false, reason: Some(reason) }),
    }
}

#[tokio::main]
async fn main() {
    let dir = data_dir();
    let path = dir.join("wallet.json");
    let wallet_file = load_or_create_wallet(&path);

    let mnemonic = bip39::Mnemonic::parse(&wallet_file.mnemonic).expect("mnemonic in wallet file is invalid");
    let seed = mnemonic.to_seed("");

    let sync_status = Arc::new(wallet::SyncStatus::default());
    let server = std::env::var("LIGHTWALLETD_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://testnet.zec.rocks:443".to_string());
    let birthday = std::env::var("SIGNER_BIRTHDAY").ok().and_then(|s| s.parse().ok());
    // Deposits from other wallets need 10 confirmations by default (ZIP 315),
    // about 12 minutes on testnet. A lower number makes demos quicker and is
    // less safe against chain reorganisations.
    let min_confirmations = std::env::var("VAULT_MIN_CONFIRMATIONS").ok().and_then(|s| s.parse().ok());
    println!("syncing against {server}");
    if let Some(n) = min_confirmations {
        println!("deposits are spendable after {n} confirmation(s) (VAULT_MIN_CONFIRMATIONS)");
    }
    let wallet_tx = wallet::spawn(
        wallet::SyncConfig {
            seed: seed.to_vec(),
            db_path: dir.join("wallet.sqlite"),
            server,
            birthday,
            vaults_path: dir.join("vaults.json"),
            min_confirmations,
        },
        sync_status.clone(),
    );

    let state = Arc::new(AppState { sync_status, wallet_tx });

    let app = Router::new()
        .route("/health", get(health))
        .route("/status", get(status))
        .route("/addresses/check", post(check_address))
        .route("/vaults", post(create_vault))
        .route("/vaults/{id}", get(vault_info))
        .route("/vaults/{id}/addresses", post(new_address))
        .route("/vaults/{id}/settle", post(settle))
        .with_state(state);

    // Loopback-only unless told otherwise. SIGNER_BIND_ADDR exists for
    // containers, where the web app is a separate container on a private
    // network. Whatever can reach this port can move the money in the vaults.
    let port: u16 = std::env::var("SIGNER_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8082);
    let ip: std::net::IpAddr = match std::env::var("SIGNER_BIND_ADDR") {
        Ok(v) if !v.trim().is_empty() => v.trim().parse().expect("SIGNER_BIND_ADDR must be an IP address, e.g. 0.0.0.0"),
        _ => std::net::IpAddr::from([127, 0, 0, 1]),
    };
    let addr = SocketAddr::new(ip, port);
    if !ip.is_loopback() {
        println!("WARNING: listening beyond this machine's loopback ({addr}). Only the web app must be able to reach this port: never publish it.");
    }
    println!("vault signer listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
