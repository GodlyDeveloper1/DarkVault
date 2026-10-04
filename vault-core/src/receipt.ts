// Signed receipts.
//
// When a bid is placed, the site signs what it accepted: which auction, which
// commitment, the hash of the time-locked bid, and the bid's position on the
// board. The bidder's browser checks the signature and keeps the receipt in
// the ticket.
//
// What it is for: the result of an auction lists every bid on the board. A
// bidder whose commitment is missing from that list, has moved, or is marked
// "could not be opened" when its time-locked bid opens perfectly well, can
// show the receipt. It is the site's own signature, so the site can't deny it.
//
// Signature: Ed25519 (noble). The site's key is made on first start and stays
// in its data folder; the public half is shown on every auction page.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

export interface Receipt {
  auction_id: string;
  /** The bid's commitment, as placed. */
  commitment: string;
  /** SHA-256 of the time-locked bid, exactly as the browser sent it. */
  sealed_hash: string;
  /** 1 for the first bid on the board. */
  position: number;
  /** When the site accepted it, in milliseconds. */
  placed_at: number;
  /** Ed25519 signature over the fields above, as hex. */
  signature: string;
}

const te = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text: string) => new Uint8Array((text.match(/../g) ?? []).map((b) => parseInt(b, 16)));

/** SHA-256 of a time-locked bid, as hex. */
export function sealedHash(sealed: string): string {
  return hex(sha256(te.encode(sealed)));
}

function receiptBytes(r: Omit<Receipt, "signature">): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(r.auction_id) || !/^[0-9a-f]{64}$/.test(r.commitment) || !/^[0-9a-f]{64}$/.test(r.sealed_hash)) throw new Error("not a receipt");
  if (!Number.isSafeInteger(r.position) || r.position < 1 || !Number.isSafeInteger(r.placed_at) || r.placed_at < 0) throw new Error("not a receipt");
  return te.encode(["dark-vault/v2/receipt", r.auction_id, r.commitment, r.sealed_hash, r.position, r.placed_at].join("|"));
}

/** A new site key: 32 random bytes, as hex. Server only. */
export function newSiteKey(): string {
  return hex(ed25519.utils.randomPrivateKey());
}

/** The public half of a site key, as hex. */
export function sitePublicKey(secretHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error("the site key must be 64 hex characters");
  return hex(ed25519.getPublicKey(unhex(secretHex)));
}

/** Server only. */
export function signReceipt(secretHex: string, fields: Omit<Receipt, "signature">): Receipt {
  if (!/^[0-9a-f]{64}$/.test(secretHex)) throw new Error("the site key must be 64 hex characters");
  return { ...fields, signature: hex(ed25519.sign(receiptBytes(fields), unhex(secretHex))) };
}

/** Did the holder of this public key sign this receipt? */
export function verifyReceipt(publicHex: string, receipt: Receipt): boolean {
  try {
    if (!/^[0-9a-f]{64}$/.test(publicHex) || !/^[0-9a-f]{128}$/.test(receipt.signature)) return false;
    return ed25519.verify(unhex(receipt.signature), receiptBytes(receipt), unhex(publicHex));
  } catch {
    return false;
  }
}
