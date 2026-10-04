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
  balance_total_zatoshis: number;
  balance_spendable_zatoshis: number;
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

/** One signer, reached at `url`. `name` is used in the message when it can't be reached. */
function client(url: string, name: string) {
  // A payout is the slow call: the signer builds a shielded transaction, which can take minutes on a small machine.
  async function call<T>(path: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${url}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new SignerError(503, `The ${name} isn't reachable. Is it running (cargo run --release)?`);
    }
    if (!res.ok) throw new SignerError(res.status, (await res.text()) || `${name} returned ${res.status}`);
    return (await res.json()) as T;
  }

  const cache = new Map<string, { at: number; value: Promise<VaultInfo> }>();

  return {
    chainStatus: (): Promise<ChainStatus> => call<ChainStatus>("/status"),

    checkAddress: (address: string): Promise<{ ok: boolean; reason: string | null }> => call("/addresses/check", json({ address })),

    createVault: (): Promise<{ vault_id: string; birthday_height: number }> => call("/vaults", { method: "POST" }, 120_000),

    newDepositAddress: async (vaultId: string): Promise<string> => (await call<{ address: string }>(`/vaults/${vaultId}/addresses`, { method: "POST" })).address,

    /**
     * What a vault holds. Cached for a few seconds, because any visitor can cause
     * this to be called and it must not turn page views into signer work.
     * Pass `fresh` when a decision depends on it.
     */
    vaultInfo(vaultId: string, fresh = false, ttlMs = 4000): Promise<VaultInfo> {
      const now = Date.now();
      const hit = cache.get(vaultId);
      if (!fresh && hit && now - hit.at < ttlMs) return hit.value;
      const value = call<VaultInfo>(`/vaults/${vaultId}`);
      cache.set(vaultId, { at: now, value });
      value.catch(() => cache.delete(vaultId)); // don't cache failures
      if (cache.size > 5000) for (const [k, v] of cache) if (now - v.at > 60_000) cache.delete(k);
      return value;
    },

    async settleVault(vaultId: string, payments: SettlePayment[]): Promise<SignerSettlement> {
      try {
        return await call<SignerSettlement>(`/vaults/${vaultId}/settle`, json({ payments }), 15 * 60_000);
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
