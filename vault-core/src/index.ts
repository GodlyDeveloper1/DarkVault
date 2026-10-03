// Dark Vault rules, shared by the browser and the server.
//
// Four things live here, and nothing that touches the network or coins:
//
//   1. Sealing a bid: a commitment that hides the amount until it is revealed.
//   2. Deciding an auction: who wins and what they pay (their own bid).
//   3. Planning the settlement: who is paid what, adding up to exactly what was
//      deposited.
//   4. Delivery (delivery.ts): sealing a lot and shipping details so the site
//      can pass them on without reading them.
//
// Amounts are whole zatoshis (1 TAZ = 100,000,000 zat) held in ordinary
// numbers; every amount is checked to be a safe integer.

export const ZAT_PER_COIN = 100_000_000;

/** ZIP 317: every action in a transaction costs this much. */
export const FEE_PER_ACTION = 5_000;

/**
 * The smallest reserve and the smallest bid. Every refund has to be able to
 * carry its share of the network fee and still be worth sending.
 */
export const MIN_BID = 100_000; // 0.001 TAZ

/** A payment below this is paid in full and doesn't share the fee. */
export const FEE_SHARE_FLOOR = 4 * FEE_PER_ACTION;

const DOMAIN = "dark-vault/v1/bid";

function assertAmount(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${what} must be a whole number of zatoshis`);
}

function fromHex(hex: string, bytes: number, what: string): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(hex)) throw new Error(`${what} must be ${bytes * 2} hex characters`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// 1. Sealing a bid
// ---------------------------------------------------------------------------

/** 32 random bytes, as hex. Made in the bidder's browser and kept there until the reveal. */
export function newNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** A new 16-byte id, as hex. */
export function newId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * The commitment to a bid:
 *
 *   SHA-256( "dark-vault/v1/bid" ‖ 0x00 ‖ auction id (16 bytes) ‖ amount (u64, big-endian) ‖ nonce (32 bytes) )
 *
 * The auction id stops a commitment being replayed in another auction. The
 * nonce stops anyone guessing the amount by hashing every plausible bid.
 */
export async function commit(auctionId: string, amount: number, nonce: string): Promise<string> {
  assertAmount(amount, "the bid");
  const domain = new TextEncoder().encode(DOMAIN);
  const id = fromHex(auctionId, 16, "the auction id");
  const salt = fromHex(nonce, 32, "the nonce");
  const data = new Uint8Array(domain.length + 1 + 16 + 8 + 32);
  data.set(domain, 0);
  data[domain.length] = 0;
  data.set(id, domain.length + 1);
  new DataView(data.buffer).setBigUint64(domain.length + 1 + 16, BigInt(amount), false);
  data.set(salt, domain.length + 1 + 16 + 8);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

/** Does this amount and nonce open this commitment? */
export async function opens(auctionId: string, commitment: string, amount: number, nonce: string): Promise<boolean> {
  try {
    return (await commit(auctionId, amount, nonce)) === commitment;
  } catch {
    return false;
  }
}

/** SHA-256 of a piece of text, as hex. */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/**
 * The token a bidder shows to see their own bid's status. It is derived from
 * the nonce, so the nonce is the only thing a bidder has to keep, and it says
 * nothing about the amount. The server stores only the token's hash.
 */
export async function bidToken(nonce: string): Promise<string> {
  fromHex(nonce, 32, "the nonce");
  return sha256Hex(`dark-vault/v1/token:${nonce}`);
}

/**
 * What a seller shows the site to prove an auction is theirs. It is derived
 * from the manage key in their link, so the manage key itself never leaves the
 * browser: the seller's delivery keys come from it (see delivery.ts), and a
 * site that saw it could read the lot. The server stores only this token's hash.
 */
export async function manageToken(manageKey: string): Promise<string> {
  fromHex(manageKey, 32, "the manage key");
  return sha256Hex(`dark-vault/v1/manage-token:${manageKey}`);
}

// ---------------------------------------------------------------------------
// 2. Deciding an auction
// ---------------------------------------------------------------------------

/** A bid as the auction sees it at the end of the reveal window. */
export interface SealedBid {
  id: string;
  /** Position in the order deposits were confirmed. Earlier wins a tie. */
  order: number;
  /** Zatoshis confirmed at this bid's deposit address. 0 if nothing arrived. */
  deposit: number;
  /** The revealed amount, if the bidder revealed and it opened the commitment. */
  revealed?: number;
}

export type Standing =
  | "won"
  | "outbid"
  | "below-reserve"
  | "not-revealed"
  | "underfunded" // revealed more than was deposited
  | "no-deposit";

export interface Outcome {
  sold: boolean;
  winnerId?: string;
  /** What the winner pays: exactly what they bid. */
  price?: number;
  /** Why each bid ended where it did. */
  standing: Record<string, Standing>;
}

/**
 * Sealed-bid, first-price with a reserve.
 *
 * A bid counts if it was revealed, is no more than its deposit, and meets the
 * reserve. The highest counting bid wins and pays exactly what it bid. Ties
 * go to the earlier deposit.
 *
 * The price depends on the winner's own bid and on nothing else, so nobody,
 * the seller and the coordinator included, can raise it by placing a fake bid
 * just under the top one. The winner can check the price themselves: it is the
 * number they sealed.
 */
export function decide(reserve: number, bids: SealedBid[]): Outcome {
  assertAmount(reserve, "the reserve");
  const standing: Record<string, Standing> = {};
  const counting: SealedBid[] = [];
  for (const bid of bids) {
    assertAmount(bid.deposit, "a deposit");
    if (bid.deposit === 0) standing[bid.id] = "no-deposit";
    else if (bid.revealed === undefined) standing[bid.id] = "not-revealed";
    else {
      assertAmount(bid.revealed, "a revealed bid");
      if (bid.revealed > bid.deposit) standing[bid.id] = "underfunded";
      else if (bid.revealed < reserve) standing[bid.id] = "below-reserve";
      else {
        standing[bid.id] = "outbid";
        counting.push(bid);
      }
    }
  }
  counting.sort((a, b) => b.revealed! - a.revealed! || a.order - b.order);
  const winner = counting[0];
  if (!winner) return { sold: false, standing };
  standing[winner.id] = "won";
  return { sold: true, winnerId: winner.id, price: winner.revealed!, standing };
}

// ---------------------------------------------------------------------------
// 3. Planning the settlement
// ---------------------------------------------------------------------------

export interface Depositor {
  id: string;
  deposit: number;
  refundAddress: string;
}

export interface PlannedPayment {
  /**
   * "escrow": the price, held until the lot is delivered.
   * "escrow-refund": the held price going back to the winner because delivery failed.
   */
  kind: "seller" | "winner-change" | "refund" | "escrow" | "escrow-refund";
  /** The bid this payment belongs to. Absent for the seller. */
  bidId?: string;
  to: string;
  zatoshis: number;
  memo: string;
  /** Whether this payment carries a share of the network fee. */
  pays_fee: boolean;
}

/**
 * Who is paid what when an auction settles. The payments always add up to
 * exactly the sum of the deposits: the coordinator keeps nothing.
 *
 * - Sold: the seller gets the price, the winner gets back whatever they
 *   deposited above it, and everyone else gets their whole deposit back.
 * - Not sold: everyone gets their whole deposit back.
 *
 * The network fee (5,000 zat per payment) is shared equally by the payments,
 * except payments too small to carry a share.
 *
 * With `escrowAddress`, the price is not paid to the seller yet: it goes to
 * the auction's escrow vault and stays there until the lot is delivered (see
 * `planEscrowPayout`). Everyone else is paid exactly as before.
 */
export function plan(auctionId: string, sellerAddress: string, depositors: Depositor[], outcome: Outcome, escrowAddress?: string): PlannedPayment[] {
  const tag = `Dark Vault ${auctionId.slice(0, 8)}`;
  const payments: PlannedPayment[] = [];
  const add = (p: Omit<PlannedPayment, "pays_fee">) => {
    if (p.zatoshis > 0) payments.push({ ...p, pays_fee: p.zatoshis >= FEE_SHARE_FLOOR });
  };

  let total = 0;
  for (const d of depositors) {
    assertAmount(d.deposit, "a deposit");
    total += d.deposit;
  }

  if (outcome.sold) {
    const winner = depositors.find((d) => d.id === outcome.winnerId);
    const price = outcome.price!;
    if (!winner) throw new Error("the winner has no deposit");
    if (price > winner.deposit) throw new Error("the price is more than the winner deposited");
    if (escrowAddress) add({ kind: "escrow", to: escrowAddress, zatoshis: price, memo: `${tag}: price, held until delivery` });
    else add({ kind: "seller", to: sellerAddress, zatoshis: price, memo: `${tag}: sale proceeds` });
    add({ kind: "winner-change", bidId: winner.id, to: winner.refundAddress, zatoshis: winner.deposit - price, memo: `${tag}: you won. This is your deposit above the price.` });
  }
  for (const d of depositors) {
    if (outcome.sold && d.id === outcome.winnerId) continue;
    add({ kind: "refund", bidId: d.id, to: d.refundAddress, zatoshis: d.deposit, memo: `${tag}: your deposit, returned` });
  }

  const paid = payments.reduce((sum, p) => sum + p.zatoshis, 0);
  if (paid !== total) throw new Error(`settlement plan pays ${paid} zat but ${total} zat was deposited`);
  if (payments.length > 0 && !payments.some((p) => p.pays_fee)) throw new Error("no payment is large enough to carry the network fee");
  return payments;
}

/**
 * The second payout of an auction with delivery: everything the escrow vault
 * holds goes to one party. "release" pays the seller (the lot was delivered);
 * "refund" pays the winner back (it was not).
 */
export function planEscrowPayout(
  auctionId: string,
  held: number,
  decision: "release" | "refund",
  sellerAddress: string,
  winner: { bidId: string; refundAddress: string },
): PlannedPayment[] {
  assertAmount(held, "the held amount");
  if (held < FEE_SHARE_FLOOR) throw new Error("the held amount is too small to pay the network fee");
  const tag = `Dark Vault ${auctionId.slice(0, 8)}`;
  return decision === "release"
    ? [{ kind: "seller", to: sellerAddress, zatoshis: held, memo: `${tag}: sale proceeds, released after delivery`, pays_fee: true }]
    : [{ kind: "escrow-refund", bidId: winner.bidId, to: winner.refundAddress, zatoshis: held, memo: `${tag}: the lot was not delivered. This is your payment, returned.`, pays_fee: true }];
}

/**
 * The least a settlement can cost: 5,000 zat per action, at least two actions.
 * The network may pad a transaction with extra actions for privacy, so the
 * real fee, which the signer reports, can be a little higher.
 */
export function minSettlementFee(deposits: number, payments: number): number {
  return FEE_PER_ACTION * Math.max(2, deposits, payments);
}

// ---------------------------------------------------------------------------
// Amounts as text
// ---------------------------------------------------------------------------

/** "0.05" → 5,000,000. Returns null for anything that isn't a plain decimal with up to 8 places. */
export function parseCoins(text: string): number | null {
  const m = /^\s*(\d{1,8})(?:\.(\d{1,8}))?\s*$/.exec(text);
  if (!m) return null;
  const zat = Number(m[1]) * ZAT_PER_COIN + Number((m[2] ?? "").padEnd(8, "0"));
  return Number.isSafeInteger(zat) ? zat : null;
}

/** 5,000,000 → "0.05" */
export function formatCoins(zat: number): string {
  assertAmount(zat, "the amount");
  const whole = Math.floor(zat / ZAT_PER_COIN);
  const frac = String(zat % ZAT_PER_COIN).padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

// ---------------------------------------------------------------------------
// 4. Delivery: sealed lots, sealed shipping details, disputes
// ---------------------------------------------------------------------------

export * from "./delivery";
