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

import type { BoardStatus } from "./fairness";

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

/** The smallest bond. Large enough to be worth returning after its share of the network fee. */
export const MIN_BOND = 50_000; // 0.0005 TAZ

/**
 * The bond that goes with a reserve: a percentage of it, at least MIN_BOND.
 * Sellers put one down before bidding opens; every bid carries one on top of
 * the bid. A party who cheats, or loses a dispute they opened, forfeits theirs
 * to the other side. `percent` 0 switches bonds off.
 */
export function bondFor(reserve: number, percent = 10): number {
  assertAmount(reserve, "the reserve");
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.max(MIN_BOND, Math.floor((reserve * percent) / 100));
}

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
  /**
   * Earlier wins a tie. `decide`: the order deposits were confirmed.
   * `decideSealed`: the order the bids were placed (the position on the board).
   */
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
  | "underfunded" // the deposit doesn't cover the bid and the bond (or, in an auction with a ceiling, the amount every bid must deposit)
  | "over-ceiling" // an auction with a ceiling: the bid was above the highest bid it allows
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
 * A bid counts if it was revealed, its deposit covers the bid plus the bond,
 * and it meets the reserve. The highest counting bid wins and pays exactly what it bid. Ties
 * go to the earlier deposit.
 *
 * The price depends on the winner's own bid and on nothing else, so nobody,
 * the seller and the coordinator included, can raise it by placing a fake bid
 * just under the top one. The winner can check the price themselves: it is the
 * number they sealed.
 */
export function decide(reserve: number, bids: SealedBid[], bond = 0): Outcome {
  assertAmount(reserve, "the reserve");
  assertAmount(bond, "the bond");
  const standing: Record<string, Standing> = {};
  const counting: SealedBid[] = [];
  for (const bid of bids) {
    assertAmount(bid.deposit, "a deposit");
    if (bid.deposit === 0) standing[bid.id] = "no-deposit";
    else if (bid.revealed === undefined) standing[bid.id] = "not-revealed";
    else {
      assertAmount(bid.revealed, "a revealed bid");
      if (bid.revealed + bond > bid.deposit) standing[bid.id] = "underfunded";
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

/**
 * The same auction with time-locked bids (scheme 2).
 *
 * There are two deposit rules, chosen when the auction is listed.
 *
 * Without a ceiling (`ceiling` is null), which is what the sell form lists:
 * a bidder deposits at least their bid plus the bond. There is no highest bid.
 * The site sees deposits arrive, so a deposit tells it the most a bidder can
 * have bid; a bidder who minds sends a larger, round amount (`hidingDeposit`).
 * A bid counts if it was opened and its deposit covers it and the bond.
 *
 * With a ceiling (auctions listed before, and the tests that keep them
 * working): every bidder deposits exactly the same amount, the ceiling plus
 * the bond, whatever they bid, so a deposit says nothing about the bid. A bid
 * counts if its deposit is at least that amount, it was opened, and it is no
 * higher than the ceiling.
 *
 * Either way the highest counting bid at or above the reserve wins and pays
 * exactly what it bid. Ties go to the bid placed first: `order` is the bid's
 * position on the public board, which everyone can see, so the tie-break can
 * be checked by anyone (see fairness.ts).
 */
export function decideSealed(reserve: number, ceiling: number | null, bids: SealedBid[], bond = 0): Outcome {
  assertAmount(reserve, "the reserve");
  if (ceiling !== null) assertAmount(ceiling, "the ceiling");
  assertAmount(bond, "the bond");
  if (ceiling !== null && ceiling < reserve) throw new Error("the ceiling can't be below the reserve");
  const standing: Record<string, Standing> = {};
  const counting: SealedBid[] = [];
  for (const bid of bids) {
    assertAmount(bid.deposit, "a deposit");
    if (bid.revealed !== undefined) assertAmount(bid.revealed, "an opened bid");
    if (bid.deposit === 0) standing[bid.id] = "no-deposit";
    else if (ceiling !== null && bid.deposit < ceiling + bond) standing[bid.id] = "underfunded";
    // No ceiling: a deposit too small to cover even the lowest bid that could win.
    else if (ceiling === null && bid.deposit < reserve + bond) standing[bid.id] = "underfunded";
    else if (bid.revealed === undefined) standing[bid.id] = "not-revealed";
    else if (ceiling !== null && bid.revealed > ceiling) standing[bid.id] = "over-ceiling";
    else if (ceiling === null && bid.revealed + bond > bid.deposit) standing[bid.id] = "underfunded";
    else if (bid.revealed < reserve) standing[bid.id] = "below-reserve";
    else {
      standing[bid.id] = "outbid";
      counting.push(bid);
    }
  }
  counting.sort((a, b) => b.revealed! - a.revealed! || a.order - b.order);
  const winner = counting[0];
  if (!winner) return { sold: false, standing };
  standing[winner.id] = "won";
  return { sold: true, winnerId: winner.id, price: winner.revealed!, standing };
}

/**
 * What to deposit (before the bond) to keep a bid from the site: the next
 * round amount above the bid. The amounts are the reserve times 2, 5, 10, 20,
 * 50, 100 and so on, so many different bids lead to the same deposit and the
 * site learns only that the bid is no higher than it.
 */
export function hidingDeposit(reserve: number, bid: number): number {
  assertAmount(reserve, "the reserve");
  assertAmount(bid, "the bid");
  if (reserve < 1) throw new Error("the reserve must be at least 1");
  for (let decade = 1; decade <= Number.MAX_SAFE_INTEGER / (reserve * 10); decade *= 10) {
    for (const step of [2, 5, 10]) {
      const amount = reserve * step * decade;
      if (amount > bid) return amount;
    }
  }
  throw new Error("the bid is too large");
}

/**
 * A private deal (Settlement): no bidding, one fixed price both sides agreed
 * before they came here.
 *
 * The buyer accepts by paying the price plus the bond into an address made
 * for that acceptance. `acceptances` are those payments, in the order they
 * were confirmed. The first one that covers the price and the bond takes the
 * deal. Any other payment (a second attempt, a short one) is returned by the
 * settlement, less its share of the network fee, exactly as a losing bid's
 * deposit is.
 *
 * It is `decide` with every acceptance offering exactly the price, so the
 * rest of the machinery (the payout plan, the escrow, the bonds) is the
 * auction's, unchanged.
 */
export function decideDeal(price: number, acceptances: { id: string; order: number; deposit: number }[], bond = 0): Outcome {
  assertAmount(price, "the price");
  if (price < MIN_BID) throw new Error("the price is too small");
  return decide(
    price,
    acceptances.map((a) => ({ ...a, revealed: price })),
    bond,
  );
}

/**
 * How a bid appears on the public board once the result is in. A bid below
 * the reserve still "counted": it was opened, and the proof covers it.
 */
export function boardStatusOf(standing: Standing): BoardStatus {
  if (standing === "no-deposit" || standing === "underfunded") return standing;
  if (standing === "not-revealed" || standing === "over-ceiling") return "unopened";
  return "counted";
}

/** The ceiling a sell form suggests: five times the reserve. */
export function suggestedCeiling(reserve: number): number {
  assertAmount(reserve, "the reserve");
  return reserve * 5;
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
 *
 * With a `bond`, the winner's bond goes into escrow with the price, and only
 * what they deposited above both comes back now.
 */
export function plan(auctionId: string, sellerAddress: string, depositors: Depositor[], outcome: Outcome, escrowAddress?: string, bond = 0): PlannedPayment[] {
  assertAmount(bond, "the bond");
  if (bond > 0 && !escrowAddress) throw new Error("a bond needs an escrow vault to hold it");
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
    if (price + bond > winner.deposit) throw new Error("the price and bond are more than the winner deposited");
    if (escrowAddress) add({ kind: "escrow", to: escrowAddress, zatoshis: price + bond, memo: `${tag}: price${bond ? " and bond" : ""}, held until delivery` });
    else add({ kind: "seller", to: sellerAddress, zatoshis: price, memo: `${tag}: sale proceeds` });
    add({
      kind: "winner-change",
      bidId: winner.id,
      to: winner.refundAddress,
      zatoshis: winner.deposit - price - bond,
      memo: `${tag}: the part of your deposit above the price${bond ? " and bond" : ""}, returned.`,
    });
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

/** Who, if anyone, is to blame for how a delivery ended. They forfeit their bond to the other side. */
export type Fault = "seller" | "winner" | "none";

/** What an auction's escrow vault holds when it pays out. */
export interface EscrowHeld {
  /** Everything in the vault. */
  total: number;
  /** The part the seller put down before bidding opened. */
  sellerBond: number;
  /** The part that is the winner's bond. The rest of the total is the price. */
  buyerBond: number;
}

/**
 * The second payout of an auction with delivery: everything the escrow vault
 * holds is paid out, and nothing stays with the coordinator.
 *
 *                      price        seller's bond   winner's bond
 *   release, no fault  seller       seller          winner
 *   release, winner    seller       seller          seller   (a dispute the winner lost)
 *   refund, seller     winner       winner          winner   (not delivered, or a dispute the seller lost)
 *   refund, winner     winner       seller          seller   (the winner never said where to send it)
 *   refund, no fault   winner       seller          winner
 *   return-bond        (not sold: the seller's bond goes back to the seller)
 */
export function planEscrowPayout(
  auctionId: string,
  held: EscrowHeld,
  decision: "release" | "refund" | "return-bond",
  fault: Fault,
  sellerAddress: string,
  winner?: { bidId: string; refundAddress: string },
): PlannedPayment[] {
  assertAmount(held.total, "the held amount");
  assertAmount(held.sellerBond, "the seller's bond");
  assertAmount(held.buyerBond, "the winner's bond");
  const price = held.total - held.sellerBond - held.buyerBond;
  if (price < 0) throw new Error("the bonds add up to more than the escrow vault holds");
  const tag = `Dark Vault ${auctionId.slice(0, 8)}`;

  let toSeller: number;
  let toWinner: number;
  let sellerMemo: string;
  let winnerMemo: string;
  if (decision === "return-bond") {
    if (held.buyerBond !== 0) throw new Error("there is no winner's bond to hold when a lot did not sell");
    toSeller = held.total;
    toWinner = 0;
    sellerMemo = `${tag}: your bond, returned`;
    winnerMemo = "";
  } else if (decision === "release") {
    if (fault === "seller") throw new Error("the price can't be released to a seller who is at fault");
    toSeller = price + held.sellerBond + (fault === "winner" ? held.buyerBond : 0);
    toWinner = fault === "winner" ? 0 : held.buyerBond;
    sellerMemo = `${tag}: sale proceeds${held.sellerBond ? " and your bond" : ""}${fault === "winner" && held.buyerBond ? ", and the winner's bond (they lost the dispute)" : ""}`;
    winnerMemo = `${tag}: your bond, returned`;
  } else {
    toWinner = price + (fault === "winner" ? 0 : held.buyerBond) + (fault === "seller" ? held.sellerBond : 0);
    toSeller = held.total - toWinner;
    winnerMemo = `${tag}: the sale was undone. This is your payment, returned${fault === "seller" && held.sellerBond ? ", with the seller's bond" : ""}.`;
    sellerMemo = fault === "winner" ? `${tag}: the sale was undone. Your bond, returned, with the winner's bond.` : `${tag}: the sale was undone. Your bond, returned.`;
  }

  // The network fee is carried by whoever receives the price. A bond going
  // back to its owner, or to the other side, arrives in full. With no price to
  // pay out (a bond returned on its own), that one payment carries the fee.
  const priceToSeller = decision !== "refund";
  const both = toSeller > 0 && toWinner > 0;
  const payments: PlannedPayment[] = [];
  if (toSeller > 0) payments.push({ kind: "seller", to: sellerAddress, zatoshis: toSeller, memo: sellerMemo, pays_fee: !both || priceToSeller });
  if (toWinner > 0) {
    if (!winner) throw new Error("the winning bid is missing");
    payments.push({ kind: "escrow-refund", bidId: winner.bidId, to: winner.refundAddress, zatoshis: toWinner, memo: winnerMemo, pays_fee: !both || !priceToSeller });
  }
  if (toSeller + toWinner !== held.total) throw new Error("the escrow payout does not add up to what is held");
  const payer = payments.find((p) => p.pays_fee);
  if (!payer || payer.zatoshis < FEE_SHARE_FLOOR) throw new Error("the held amount is too small to pay the network fee");
  return payments;
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

// ---------------------------------------------------------------------------
// 5. Hidden-amount commitments and the proof that the highest bid won
// ---------------------------------------------------------------------------

export * from "./fairness";

// ---------------------------------------------------------------------------
// 6. Time-locked bids
// ---------------------------------------------------------------------------

export * from "./timelock";

// ---------------------------------------------------------------------------
// 7. Signed receipts for placed bids
// ---------------------------------------------------------------------------

export * from "./receipt";

// ---------------------------------------------------------------------------
// 8. Private auctions: an encrypted listing and the invite that opens it
// ---------------------------------------------------------------------------

export * from "./invite";

// ---------------------------------------------------------------------------
// Order Flow: a batch sale of several identical units (batch.ts)
// ---------------------------------------------------------------------------

export * from "./batch";

// Listing photos (photos.ts): up to three per listing. Public ones are checked
// to carry no camera details; in a private auction or a deal they are
// encrypted with the listing's key and padded to one size.
export * from "./photos";
