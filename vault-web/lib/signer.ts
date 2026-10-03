// Server-only client for the Dark Vault signer. The signer is never public;
// browsers reach it only through our API routes.
import "server-only";

const SIGNER_URL = process.env.SIGNER_URL ?? "http://127.0.0.1:8082";

export class SignerError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${SIGNER_URL}${path}`, { ...init, cache: "no-store" });
  } catch {
    throw new SignerError(503, "The signer isn't reachable. Is it running (cargo run --release)?");
  }
  if (!res.ok) throw new SignerError(res.status, (await res.text()) || `signer returned ${res.status}`);
  return (await res.json()) as T;
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

export function chainStatus(): Promise<ChainStatus> {
  return call<ChainStatus>("/status");
}

export async function checkAddress(address: string): Promise<{ ok: boolean; reason: string | null }> {
  return call("/addresses/check", json({ address }));
}

export function createVault(): Promise<{ vault_id: string; birthday_height: number }> {
  return call("/vaults", { method: "POST" });
}

export async function newDepositAddress(vaultId: string): Promise<string> {
  return (await call<{ address: string }>(`/vaults/${vaultId}/addresses`, { method: "POST" })).address;
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

const cache = new Map<string, { at: number; value: Promise<VaultInfo> }>();

/**
 * What a vault holds. Cached for a few seconds, because any visitor can cause
 * this to be called and it must not turn page views into signer work.
 * Pass `fresh` when a decision depends on it.
 */
export function vaultInfo(vaultId: string, fresh = false, ttlMs = 4000): Promise<VaultInfo> {
  const now = Date.now();
  const hit = cache.get(vaultId);
  if (!fresh && hit && now - hit.at < ttlMs) return hit.value;
  const value = call<VaultInfo>(`/vaults/${vaultId}`);
  cache.set(vaultId, { at: now, value });
  value.catch(() => cache.delete(vaultId)); // don't cache failures
  if (cache.size > 5000) for (const [k, v] of cache) if (now - v.at > 60_000) cache.delete(k);
  return value;
}

export interface SettlePayment {
  to: string;
  zatoshis: number;
  memo?: string;
  pays_fee: boolean;
}

export async function settleVault(vaultId: string, payments: SettlePayment[]): Promise<SignerSettlement> {
  try {
    return await call<SignerSettlement>(`/vaults/${vaultId}/settle`, json({ payments }));
  } finally {
    cache.delete(vaultId);
  }
}
