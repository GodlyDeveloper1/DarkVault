// Order Flow: a batch sale. One seller offers several identical units; buyers
// send sealed orders, one order for one unit; at the close the highest orders
// win a unit each, and each winner pays exactly what they offered.
//
// Three things live here:
//
//   1. The decision: which orders win.
//   2. The money: who is paid what at the close, and how the seller's bond is
//      shared out between the units that sold.
//   3. The proof that the right orders won, without showing what any order
//      offered except one: the lowest order that won, which is the sale's
//      public price ("units went for this much or more").
//
// The proof uses the same building blocks as an auction's (rangeproof.ts):
//
//   - the lowest winning order's commitment is opened, so anyone can check it
//     holds the published price;
//   - every other winner is shown to have offered at least that price;
//   - every other order that counted is shown to have offered no more.
//
// "At least" and "no more" are sharpened by the order the orders were placed
// in, because the earlier of two equal orders wins: see `batchBound`.
import { FEE_SHARE_FLOOR, boardStatusOf, type Depositor, type PlannedPayment, type SealedBid, type Standing } from "./index";
import type { BoardStatus, Opening } from "./fairness";
import { G, RistrettoPoint, assertAmount, blindingBase, concat, fromBase64, mod, pause, pedersenOpens, proveRange, scalarOf, sha512, te, toBase64, validCommitment, verifyRange } from "./rangeproof";

/** The fewest and the most units one batch sale can offer. Each unit that sells gets an escrow of its own. */
export const BATCH_MIN_UNITS = 2;
export const BATCH_MAX_UNITS = 20;

/**
 * No order can be above this (10,000 TAZ). It is not a seller's cap: it is the
 * size of the number the proof can speak about. A winner is shown to have
 * offered "the price plus a number of at most 40 bits", and 40 bits of
 * zatoshis is just under 11,000 TAZ.
 */
export const BATCH_MAX_ORDER = 1_000_000_000_000;
const HIGH_BITS = 40;

// ---------------------------------------------------------------------------
// 1. The decision
// ---------------------------------------------------------------------------

export interface BatchOutcome {
  /** Did at least one unit sell? */
  sold: boolean;
  /** The winning orders, best first: the highest, and of equal orders the earlier. Each pays its own amount. */
  winners: { id: string; price: number }[];
  /** The lowest winning order: the sale's public price. Absent when nothing sold. */
  price?: number;
  /** The order that set it. */
  marginalId?: string;
  standing: Record<string, Standing>;
}

/**
 * Sealed orders, several units, pay what you offered.
 *
 * An order counts if it was opened, its deposit covers it and the bond, and it
 * is no higher than `BATCH_MAX_ORDER`. Of the orders that count and meet the
 * lowest price, the highest `units` win one unit each. Of two equal orders the
 * earlier wins (`order` is the position on the public board). Each winner pays
 * exactly what they offered, so nobody, the seller and the site included, can
 * move what a buyer pays by placing an order of their own.
 */
export function decideBatch(reserve: number, units: number, orders: SealedBid[], bond = 0): BatchOutcome {
  assertAmount(reserve, "the lowest price");
  assertAmount(bond, "the bond");
  if (!Number.isInteger(units) || units < 1) throw new Error("a batch sale needs at least one unit");
  const standing: Record<string, Standing> = {};
  const counting: SealedBid[] = [];
  for (const o of orders) {
    assertAmount(o.deposit, "a deposit");
    if (o.revealed !== undefined) assertAmount(o.revealed, "an opened order");
    if (o.deposit === 0) standing[o.id] = "no-deposit";
    // A deposit too small to cover even the lowest order that could win.
    else if (o.deposit < reserve + bond) standing[o.id] = "underfunded";
    else if (o.revealed === undefined) standing[o.id] = "not-revealed";
    else if (o.revealed > BATCH_MAX_ORDER) standing[o.id] = "over-ceiling";
    else if (o.revealed + bond > o.deposit) standing[o.id] = "underfunded";
    else if (o.revealed < reserve) standing[o.id] = "below-reserve";
    else {
      standing[o.id] = "outbid";
      counting.push(o);
    }
  }
  counting.sort((a, b) => b.revealed! - a.revealed! || a.order - b.order);
  const won = counting.slice(0, units);
  for (const w of won) standing[w.id] = "won";
  const last = won[won.length - 1];
  return {
    sold: won.length > 0,
    winners: won.map((w) => ({ id: w.id, price: w.revealed! })),
    ...(last ? { price: last.revealed!, marginalId: last.id } : {}),
    standing,
  };
}

// ---------------------------------------------------------------------------
// 2. The money
// ---------------------------------------------------------------------------

/**
 * Who is paid what when a batch sale closes. The payments add up to exactly
 * the sum of the deposits.
 *
 * Each winner's price and bond go to the escrow made for that winner's unit
 * (`escrowOf` gives its address), and whatever they deposited above the two
 * comes straight back. Every other deposit goes back whole. Each payment
 * large enough carries an equal share of the network fee.
 */
export function planBatch(saleId: string, depositors: Depositor[], outcome: BatchOutcome, escrowOf: Record<string, string>, bond = 0): PlannedPayment[] {
  assertAmount(bond, "the bond");
  const tag = `Dark Vault ${saleId.slice(0, 8)}`;
  const payments: PlannedPayment[] = [];
  const add = (p: Omit<PlannedPayment, "pays_fee">) => {
    if (p.zatoshis > 0) payments.push({ ...p, pays_fee: p.zatoshis >= FEE_SHARE_FLOOR });
  };
  let total = 0;
  for (const d of depositors) {
    assertAmount(d.deposit, "a deposit");
    total += d.deposit;
  }
  const prices = new Map(outcome.winners.map((w) => [w.id, w.price]));
  for (const w of outcome.winners) {
    const d = depositors.find((x) => x.id === w.id);
    if (!d) throw new Error("a winner has no deposit");
    if (w.price + bond > d.deposit) throw new Error("the price and bond are more than a winner deposited");
    const escrow = escrowOf[w.id];
    if (!escrow) throw new Error("a winner's unit has no escrow");
    add({ kind: "escrow", bidId: w.id, to: escrow, zatoshis: w.price + bond, memo: `${tag}: price${bond ? " and bond" : ""}, held until delivery` });
    add({ kind: "winner-change", bidId: w.id, to: d.refundAddress, zatoshis: d.deposit - w.price - bond, memo: `${tag}: the part of your deposit above the price${bond ? " and bond" : ""}, returned.` });
  }
  for (const d of depositors) {
    if (prices.has(d.id)) continue;
    add({ kind: "refund", bidId: d.id, to: d.refundAddress, zatoshis: d.deposit, memo: `${tag}: your deposit, returned` });
  }
  const paid = payments.reduce((sum, p) => sum + p.zatoshis, 0);
  if (paid !== total) throw new Error(`settlement plan pays ${paid} zat but ${total} zat was deposited`);
  if (payments.length > 0 && !payments.some((p) => p.pays_fee)) throw new Error("no payment is large enough to carry the network fee");
  return payments;
}

/**
 * The seller's bond, shared out after the close. The seller put down one bond
 * for the whole sale; each unit that sold takes an equal share into its own
 * escrow, where it stands behind that one handover. The share of every unit
 * that did not sell, and any odd zatoshis, go straight back to the seller.
 * Everything the bond vault holds is paid out, and every part carries an
 * equal share of the network fee of moving it.
 *
 * A bond too small to be shared out (a share could not carry its part of the
 * fee) is not shared: all of it goes back to the seller. Sites that ask for
 * bonds never take one that small; this is what happens instead of a plan
 * that can't be paid.
 */
export function planBondSplit(saleId: string, held: number, units: number, sellerAddress: string, escrows: string[]): { to: string; zatoshis: number; memo: string; pays_fee: boolean; unit: number | null }[] {
  assertAmount(held, "the bond");
  if (!Number.isInteger(units) || units < 1 || escrows.length > units) throw new Error("more units sold than the sale offered");
  if (held === 0) return []; // a sale without bonds: nothing to share out
  const tag = `Dark Vault ${saleId.slice(0, 8)}`;
  const share = Math.floor(held / units);
  if (escrows.length > 0 && share < FEE_SHARE_FLOOR) {
    if (held < FEE_SHARE_FLOOR) throw new Error("the bond is too small to pay the network fee");
    return [{ to: sellerAddress, zatoshis: held, memo: `${tag}: your bond, returned (it was too small to share between the units)`, pays_fee: true, unit: null }];
  }
  const out: { to: string; zatoshis: number; memo: string; pays_fee: boolean; unit: number | null }[] = escrows.map((to, unit) => ({
    to,
    zatoshis: share,
    memo: `${tag}: the seller's bond for this unit, held until delivery`,
    pays_fee: share >= FEE_SHARE_FLOOR,
    unit,
  }));
  const back = held - share * escrows.length;
  if (back > 0) out.push({ to: sellerAddress, zatoshis: back, memo: `${tag}: your bond for the units that did not sell, returned`, pays_fee: back >= FEE_SHARE_FLOOR, unit: null });
  const paying = out.filter((p) => p.zatoshis > 0);
  if (paying.reduce((s, p) => s + p.zatoshis, 0) !== held) throw new Error("the bond split does not add up to what is held");
  if (!paying.some((p) => p.pays_fee)) throw new Error("the bond is too small to pay the network fee");
  return paying;
}

// ---------------------------------------------------------------------------
// 3. The proof that the right orders won
// ---------------------------------------------------------------------------

/** Everything public about a batch sale's result. The proof is checked against exactly this. */
export interface BatchStatement {
  v: 3;
  auction_id: string;
  /** The lowest price an order could win at. */
  reserve: number;
  /** How many units were offered. */
  units: number;
  /** Every order placed, in the order placed. */
  bids: { commitment: string; status: BoardStatus }[];
  /** The positions in `bids` of the orders that won a unit, in rising order. */
  winners: number[];
  /** The position of the lowest winning order, or null if nothing sold. */
  marginal: number | null;
  /** What it offered: the sale's public price. Null if nothing sold. */
  price: number | null;
}

export interface BatchProof {
  /** Opens the lowest winning order's commitment to the price. Null if nothing sold. */
  marginal_blinding: string | null;
  /** For every other counted order, by position: winners offered at least their bound, the rest at most theirs. */
  ranges: Record<string, string>;
}

/** The public statement of a decided batch sale. `board` is every order placed, in the order placed. */
export function batchStatementOf(saleId: string, reserve: number, units: number, board: { id: string; commitment: string }[], outcome: BatchOutcome): BatchStatement {
  const position = new Map(board.map((b, i) => [b.id, i]));
  const at = (id: string) => {
    const i = position.get(id);
    if (i === undefined) throw new Error("a winning order is not on the board");
    return i;
  };
  return {
    v: 3,
    auction_id: saleId,
    reserve,
    units,
    bids: board.map((b) => ({ commitment: b.commitment, status: boardStatusOf(outcome.standing[b.id] ?? "no-deposit") })),
    winners: outcome.winners.map((w) => at(w.id)).sort((a, b) => a - b),
    marginal: outcome.marginalId ? at(outcome.marginalId) : null,
    price: outcome.price ?? null,
  };
}

/**
 * What the result says about the order at position `i` (which counted, and is
 * not the lowest winner):
 *
 *   a winner offered at least the price; more than it, if it was placed after
 *   the lowest winner (placed later and equal, it would have lost to it);
 *
 *   any other order offered at most the price; less than it, if it was placed
 *   before the lowest winner (placed earlier and equal, it would have won
 *   instead). If units were left over, every order at or above the lowest
 *   price would have won one, so any other order was below the lowest price.
 */
export function batchBound(s: BatchStatement, i: number): { side: "at-least" | "at-most"; bound: number } {
  if (s.winners.includes(i)) return { side: "at-least", bound: s.price! + (i > s.marginal! ? 1 : 0) };
  if (s.winners.length < s.units) return { side: "at-most", bound: s.reserve - 1 };
  return { side: "at-most", bound: s.price! - (i < s.marginal! ? 1 : 0) };
}

const lowBits = (s: BatchStatement) => Math.max(1, (s.winners.length < s.units ? s.reserve : s.price!).toString(2).length);

function statementBytes(s: BatchStatement): Uint8Array {
  const text = ["dark-vault/v3/batch", s.auction_id, s.reserve, s.units, s.winners.join(","), s.marginal ?? "-", s.price ?? "-", s.bids.length, ...s.bids.map((b) => `${b.commitment}:${b.status}`)].join("|");
  return sha512(te.encode(text));
}

const context = (digest: Uint8Array, i: number, side: string) => concat(digest, te.encode(`#${i}:${side}`));

function shapeProblems(s: BatchStatement): string[] {
  const problems: string[] = [];
  const amount = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (s?.v !== 3 || !/^[0-9a-f]{32}$/.test(s.auction_id ?? "")) return ["this is not a batch sale's statement"];
  if (!amount(s.reserve) || s.reserve < 1) problems.push("the lowest price makes no sense");
  if (!Number.isInteger(s.units) || s.units < 1 || s.units > 1000) problems.push("the number of units makes no sense");
  if (!Array.isArray(s.bids)) return [...problems, "the list of orders is missing"];
  const seen = new Set<string>();
  s.bids.forEach((b, i) => {
    if (!validCommitment(b?.commitment)) problems.push(`order #${i + 1} is not a valid commitment`);
    else if (seen.has(b.commitment)) problems.push(`order #${i + 1} repeats an earlier commitment`);
    seen.add(b?.commitment);
    if (!["counted", "no-deposit", "underfunded", "unopened"].includes(b?.status)) problems.push(`order #${i + 1} has an unknown status`);
  });
  if (!Array.isArray(s.winners)) return [...problems, "the list of winners is missing"];
  const sorted = s.winners.every((w, k) => Number.isInteger(w) && w >= 0 && w < s.bids.length && (k === 0 || w > s.winners[k - 1]!));
  if (!sorted) problems.push("the winners are not distinct orders on the board, in order");
  else if (s.winners.some((w) => s.bids[w]?.status !== "counted")) problems.push("a winner is not a counted order");
  if (s.winners.length > s.units) problems.push("more orders won than there were units");
  if (s.winners.length > 0) {
    if (!Number.isInteger(s.marginal) || !s.winners.includes(s.marginal!)) problems.push("the lowest winning order is not one of the winners");
    if (!amount(s.price) || s.price! < s.reserve || s.price! > BATCH_MAX_ORDER) problems.push("the price is outside what an order can be");
  } else if (s.marginal !== null || s.price !== null) problems.push("a sale with no winners can't have a price");
  return problems;
}

/**
 * Makes the proof. `openings[i]` is what order `i` held; it is needed for
 * every counted order. Throws if the statement is not true.
 */
export async function proveBatch(statement: BatchStatement, openings: (Opening | undefined)[]): Promise<BatchProof> {
  const problems = shapeProblems(statement);
  if (problems.length) throw new Error(`the statement is malformed: ${problems[0]}`);
  const H = blindingBase(statement.auction_id);
  const digest = statementBytes(statement);
  const low = lowBits(statement);
  const proof: BatchProof = { marginal_blinding: null, ranges: {} };

  for (let i = 0; i < statement.bids.length; i++) {
    const bid = statement.bids[i]!;
    if (bid.status !== "counted") continue;
    const o = openings[i];
    if (!o || !pedersenOpens(statement.auction_id, bid.commitment, o.amount, o.blinding)) throw new Error(`order #${i + 1} is counted but its opening is missing or wrong`);
    if (i === statement.marginal) {
      if (o.amount !== statement.price) throw new Error("the lowest winning order is not the price");
      proof.marginal_blinding = o.blinding;
      continue;
    }
    const { side, bound } = batchBound(statement, i);
    const r = scalarOf(o.blinding, "the blinding");
    if (side === "at-least") {
      if (o.amount < bound || o.amount > BATCH_MAX_ORDER) throw new Error(`order #${i + 1} won but offered less than the result says: the statement is not true`);
      // C − bound·G = (amount − bound)·G + blinding·H
      proof.ranges[String(i)] = toBase64(proveRange(H, BigInt(o.amount - bound), r, HIGH_BITS, context(digest, i, side)));
    } else {
      if (o.amount > bound) throw new Error(`order #${i + 1} did not win but offered more than the result allows: the statement is not true`);
      // bound·G − C = (bound − amount)·G − blinding·H
      proof.ranges[String(i)] = toBase64(proveRange(H, BigInt(bound - o.amount), mod(-r), low, context(digest, i, side)));
    }
    await pause(); // let a server answer other requests between orders
  }
  return proof;
}

export interface BatchVerdict {
  ok: boolean;
  /** Plain sentences; empty when everything checks out. */
  problems: string[];
  bids: number;
  counted: number;
  winners: number;
}

/** Checks a batch sale's result against its proof. Runs anywhere, with only the public statement and proof. */
export async function verifyBatch(statement: BatchStatement, proof: BatchProof, onProgress?: (done: number, of: number) => void): Promise<BatchVerdict> {
  const problems = shapeProblems(statement);
  const bids = Array.isArray(statement?.bids) ? statement.bids.length : 0;
  const winners = Array.isArray(statement?.winners) ? statement.winners.length : 0;
  if (problems.length) return { ok: false, problems, bids, counted: 0, winners };
  const counted = statement.bids.filter((b) => b.status === "counted").length;
  if (!proof || typeof proof !== "object" || typeof proof.ranges !== "object" || proof.ranges === null) return { ok: false, problems: ["the proof is missing"], bids, counted, winners };

  const H = blindingBase(statement.auction_id);
  const digest = statementBytes(statement);
  const low = lowBits(statement);

  if (statement.marginal !== null) {
    const m = statement.bids[statement.marginal]!;
    if (typeof proof.marginal_blinding !== "string" || !pedersenOpens(statement.auction_id, m.commitment, statement.price!, proof.marginal_blinding))
      problems.push("the lowest winning order's commitment does not hold the price");
  }

  const todo = statement.bids.map((_, i) => i).filter((i) => statement.bids[i]!.status === "counted" && i !== statement.marginal);
  let done = 0;
  for (const i of todo) {
    const { side, bound } = batchBound(statement, i);
    let fine = false;
    try {
      const C = RistrettoPoint.fromHex(statement.bids[i]!.commitment);
      const B = bound === 0 ? RistrettoPoint.ZERO : G.multiplyUnsafe(BigInt(bound));
      const encoded = proof.ranges[String(i)];
      if (typeof encoded === "string") {
        fine = side === "at-least" ? verifyRange(H, C.subtract(B), HIGH_BITS, context(digest, i, side), fromBase64(encoded)) : bound >= 0 && verifyRange(H, B.subtract(C), low, context(digest, i, side), fromBase64(encoded));
      }
    } catch {
      fine = false;
    }
    if (!fine) problems.push(side === "at-least" ? `order #${i + 1} won a unit but is not shown to have offered enough` : `order #${i + 1} did not win a unit but is not shown to have offered less`);
    onProgress?.(++done, todo.length);
    await pause(); // keep a page responsive while it checks
  }
  for (const key of Object.keys(proof.ranges)) if (!todo.includes(Number(key))) problems.push(`the proof has an entry for order #${Number(key) + 1}, which needs none`);
  return { ok: problems.length === 0, problems, bids, counted, winners };
}
