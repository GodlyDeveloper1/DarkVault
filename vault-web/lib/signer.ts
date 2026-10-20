// Server-only client for the Dark Vault signer. The signer is never public;
// browsers reach it only through our API routes.
//
// There can be two signers. The main one holds the auctions' vaults. The
// optional "house" one (HOUSE_SIGNER_URL) is a separate wallet with its own
// seed: it pays practice deposits and the house bidders' deposits, exactly as
// any outside wallet would (see lib/house/). Both speak the same API.
import "server-only";

const SIGNER_URL = process.env.SIGNER_URL ?? "http://127.0.0.1:8082";
export const HOUSE_SIGNER_URL = (process.env.HOUSE_SIGNER_URL ?? "").trim().replace(/\/+$/, "");

export class SignerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export interface ChainStatus {
  chain_tip: number;
  scanned_height: number;
  sync_error: string | null;
}

export interface Deposit {
  txid: string;
  mined_height: number | null;
  confirmations: number;
  pool: string;
  value_zatoshis: number;
  to_address: string | null;
}

export interface SignerSettlement {
  txid: string;
  status: "pending" | "mined" | "expired";
  mined_height: number | null;
  fee_zatoshis: number;
  payments: { to: string; zatoshis: number }[];
}

export interface VaultInfo {
  vault_id: string;
  birthday_height: number;
  chain_tip: number;
  scanned_height: number;
  min_confirmations: number;
  /** Network fees already spent merging the vault's notes are counted in: the next payout pays them. */
  balance_total_zatoshis: number;
  balance_spendable_zatoshis: number;
  /** Fees of merges the next payout owes (a vault holding more payments than one payout spends is merged first). */
  merge_fees_zatoshis?: number;
  /** A merge is waiting for a block. */
  merging?: boolean;
  deposits: Deposit[];
  settlement: SignerSettlement | null;
  settlements: SignerSettlement[];
}

export interface SettlePayment {
  to: string;
  zatoshis: number;
  memo?: string;
  pays_fee: boolean;
}

/**
 * The network's fee rules make a note of 5,000 zatoshis or less worth less
 * than it costs to spend. The wallet under the signer leaves such notes out of
 * a vault's balance, and no settlement can ever move them, but the signer
 * still lists them among a vault's deposits.
 *
 * So they are dropped here, where every answer about a vault comes in: for
 * this site such a note never arrived. Otherwise anyone could send one to a
 * deposit address and make the deposits add up to more than the vault holds,
 * which stops that vault from ever being paid out.
 */
export const DUST_ZATOSHIS = 5_000;
function withoutDust(info: VaultInfo): VaultInfo {
  return { ...info, deposits: info.deposits.filter((d) => d.value_zatoshis > DUST_ZATOSHIS) };
}

/**
 * What a visitor is told when the signer can't be reached or fails. Never a
 * technical message: those go to the server's log for the operator.
 */
export const SIGNER_BUSY = "Dark Vault's wallet service is busy for a moment. Please try again in a minute.";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tries a signer call again when the signer is unreachable or failed inside
 * (a 5xx: the testnet server briefly out of reach, a wallet hiccup). Never
 * used for a payout: a payout is only ever asked for once per pass, and the
 * engine works out on its next pass whether it happened.
 */
async function again<T>(what: string, f: () => Promise<T>, waits = [1500, 4000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      const retryable = e instanceof SignerError && e.status >= 500;
      if (!retryable || i >= waits.length) throw e;
      console.error(`signer: ${what} failed (${(e as Error).message.slice(0, 300)}); trying again`);
      await pause(waits[i]!);
    }
  }
}

/** One signer, reached at `url`. `name` is used in the log when it can't be reached. */
function client(url: string, name: string) {
  // A payout is the slow call: the signer builds a shielded transaction, which can take minutes on a small machine.
  async function call<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${url}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      console.error(`signer: the ${name} at ${url} isn't reachable. Is it running (cargo run --release)?`);
      throw new SignerError(503, SIGNER_BUSY);
    }
    if (!res.ok) {
      const text = (await res.text()) || `${name} returned ${res.status}`;
      if (res.status >= 500) console.error(`signer: ${name} ${path} answered ${res.status}: ${text.slice(0, 500)}`);
      throw new SignerError(res.status, text);
    }
    return (await res.json()) as T;
  }

  const cache = new Map<string, { at: number; value: Promise<VaultInfo> }>();

  return {
    chainStatus: (): Promise<ChainStatus> => call<ChainStatus>("/status"),

    checkAddress: (address: string): Promise<{ ok: boolean; reason: string | null }> => again("address check", () => call("/addresses/check", json({ address }))),

    createVault: (): Promise<{ vault_id: string; birthday_height: number }> => again("opening a vault", () => call("/vaults", { method: "POST" }, 120_000)),

    newDepositAddress: async (vaultId: string): Promise<string> =>
      (await again("a deposit address", () => call<{ address: string }>(`/vaults/${vaultId}/addresses`, { method: "POST" }))).address,

    /**
     * What a vault holds. Cached for a few seconds, because any visitor can cause
     * this to be called and it must not turn page views into signer work.
     * Pass `fresh` when a decision depends on it.
     */
    vaultInfo(vaultId: string, fresh = false, ttlMs = 4000): Promise<VaultInfo> {
      const now = Date.now();
      const hit = cache.get(vaultId);
      if (!fresh && hit && now - hit.at < ttlMs) return hit.value;
      const value = call<VaultInfo>(`/vaults/${vaultId}`).then(withoutDust);
      cache.set(vaultId, { at: now, value });
      value.catch(() => cache.delete(vaultId)); // don't cache failures
      if (cache.size > 5000) for (const [k, v] of cache) if (now - v.at > 60_000) cache.delete(k);
      return value;
    },

    /** `prepaid`: part of the vault set aside for network fees, in no payment (a bidder's extra payments each carry their own). */
    async settleVault(vaultId: string, payments: SettlePayment[], prepaid = 0): Promise<SignerSettlement> {
      try {
        return await call<SignerSettlement>(`/vaults/${vaultId}/settle`, json({ payments, prepaid_fee_zatoshis: prepaid }), 15 * 60_000);
      } finally {
        cache.delete(vaultId);
      }
    },
  };
}

const main = client(SIGNER_URL, "signer");

export const chainStatus = main.chainStatus;
export const checkAddress = main.checkAddress;
export const createVault = main.createVault;
export const newDepositAddress = main.newDepositAddress;
export const vaultInfo = main.vaultInfo;
export const settleVault = main.settleVault;

/**
 * The house wallet's signer, or null when the site has none (then there are
 * no practice auctions and no practice wallets). It must be a different
 * wallet from the main signer: a payment between two vaults of one wallet
 * does not count as a deposit.
 */
export const houseSigner = HOUSE_SIGNER_URL && HOUSE_SIGNER_URL !== SIGNER_URL.replace(/\/+$/, "") ? client(HOUSE_SIGNER_URL, "house signer") : null;
