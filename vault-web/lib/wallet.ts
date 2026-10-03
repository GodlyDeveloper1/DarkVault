// "Connect wallet", the Zcash way.
//
// On other chains, connecting a wallet hands the site a permanent address. Here
// that would be the leak: one address would tie all of a bidder's auctions
// together. So connecting means something smaller and safer:
//
//   - this browser remembers, for itself, an address refunds can go to;
//   - deposits are paid with a standard Zcash payment request (ZIP 321), which
//     opens the bidder's own wallet app with the address and amount filled in;
//   - the wallet panel lists the bids this browser holds.
//
// Nothing in this file talks to the server. The saved address is sent only when
// the bidder places a bid with it, exactly as if they had pasted it.
import { announce } from "./tickets";

export interface Wallet {
  kind: "own";
  /** A shielded address refunds can go to, or null to paste a fresh one per bid. */
  refund_address: string | null;
  connected_at: number;
}

const KEY = "dv-wallet";
/** Fired on this window to ask the wallet panel to open. */
export const OPEN_EVENT = "dv-wallet-open";

export function loadWallet(): Wallet | null {
  try {
    const w = JSON.parse(localStorage.getItem(KEY) ?? "null") as Wallet | null;
    if (!w || w.kind !== "own") return null;
    return { kind: "own", refund_address: typeof w.refund_address === "string" ? w.refund_address : null, connected_at: Number(w.connected_at) || 0 };
  } catch {
    return null;
  }
}

export function saveWallet(wallet: Wallet | null) {
  try {
    if (wallet) localStorage.setItem(KEY, JSON.stringify(wallet));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: connected for this page only */
  }
  announce();
}

/**
 * A quick look at an address, here in the browser. It only catches slips (a
 * transparent address, a mainnet address, a cut-off paste); the signer does the
 * real check when a bid is placed.
 */
export function addressProblem(address: string): string | null {
  const a = address.trim();
  if (a === "") return null;
  if (/^(t1|t3|tm|t2)/.test(a)) return "That is a transparent address. Refunds only go to shielded addresses.";
  if (/^u1/.test(a)) return "That is a mainnet address. Dark Vault runs on the Zcash testnet (addresses start with utest1).";
  if (/^(zs|ztestsapling)/.test(a)) return "That is a Sapling address. Use a unified address (it starts with utest1).";
  if (!/^utest1[02-9ac-hj-np-z]{60,}$/.test(a)) return "That doesn't look like a testnet unified address (it starts with utest1).";
  return null;
}

/** A Zcash payment request (ZIP 321): wallets that open or scan it fill in the address and the amount. */
export function paymentRequest(address: string, coins: string): string {
  return `zcash:${address}?amount=${coins}`;
}

export const maskAddress = (address: string) => `${address.slice(0, 14)}…${address.slice(-6)}`;
