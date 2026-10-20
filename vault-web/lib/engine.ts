// The auction state machine. It runs on the server, on a timer and whenever an
// auction is looked at, and moves each auction forward when its time comes:
//
//   open ──(end time)──▶ revealing ──(all revealed, or the window ends)──▶ settling
//        ──(every deposit confirmed)──▶ settled
//
// A lot sold with delivery takes one more step. The first payout refunds the
// losers and moves the price into the auction's escrow vault instead of paying
// the seller:
//
//   settling ──▶ delivering ──(handed over and confirmed, or a time limit, or a
//        dispute decided)──▶ settled
//
// and the second payout sends the held price to the seller, or back to the
// winner if the lot was not delivered.
//
// With bonds, a listing starts in "funding" and opens when the seller's bond
// has arrived in the escrow vault. The winner's bond joins it there with the
// price. The second payout returns each bond to its owner, or gives it to the
// other side if its owner was at fault.
//
// Auctions of scheme 2 lock their bids in time (vault-core timelock.ts). When
// bidding has closed, the server fetches the round's signature, opens the bids
// itself, decides, and saves a proof that the highest bid won (fairness.ts).
// The reveal window stays as the fallback: if the signature can't be fetched,
// each bidder's browser opens its own bid from its ticket, as before.
//
// A batch sale (Order Flow) is decided the same way, with several winners.
// Its first payout moves each winner's price and bond into an escrow vault
// made for that winner's unit; the seller's bond is then shared out between
// those vaults; and each unit is handed over on a record of its own, exactly
// as a sold lot is. The sale is finished when every unit is.
//
// Money only moves in `settle`, `settleBatch`, `splitBond`, `payEscrow`,
// `checkEscrow` and `returnLateDeposits`, and only
// as the plans from vault-core say. The signer then refuses anything that
// doesn't add up to exactly what a vault holds.
import "server-only";
import { createHash } from "node:crypto";
import {
  batchStatementOf,
  boardStatusOf,
  decide,
  decideBatch,
  decideDeal,
  decideSealed,
  FEE_SHARE_FLOOR,
  openSealedBid,
  pedersenOpens,
  plan,
  planBatch,
  planBondSplit,
  planEscrowPayout,
  proveBatch,
  proveFairness,
  roundAfter,
  TooEarly,
  verifyBatch,
  verifyFairness,
  type BatchOutcome,
  type Depositor,
  type FairnessStatement,
  type Fault,
  type Opening,
  type Outcome,
  type PlannedPayment,
  type SealedBid,
} from "vault-core";
import { decideBy, silentSide } from "./delivery";
import { beaconChain, fetchBeacon } from "./drand";
import { LIMITS } from "./limits";
import { createAuction, listRecords, loadAuction, loadUnit, saveProof, withAuction, withUnit, deleteEvidence } from "./store";
import { createVault, newDepositAddress, settleVault, vaultInfo, type VaultInfo } from "./signer";
import { siteKey } from "./sitekey";
import type { Auction, Delivery, PaymentRecord, ResolutionReason } from "./types";

/**
 * After the end time, wait this long before closing, so the signer has scanned
 * the blocks mined up to the end time (it scans every 30 seconds).
 */
export const CLOSE_GRACE_MS = Number(process.env.VAULT_CLOSE_GRACE_SEC ?? 40) * 1000;

export interface BidMoney {
  /** Everything that has arrived at this bid's address. */
  total: number;
  /** The part that arrived before bidding closed: only this backs the bid. */
  counted: number;
  /** Fewest confirmations among this bid's deposits. 0 if there are none. */
  confirmations: number;
  /** Height of this bid's first deposit, for breaking ties. */
  first_height: number | null;
  /** How many separate payments make up `total`. */
  notes: number;
}

/** Matches each deposit in the vault to its bid, by the address it arrived at. */
export function moneyByBid(auction: Auction, info: VaultInfo): Map<string, BidMoney> {
  const byAddress = new Map(auction.bids.map((b) => [b.deposit_address, b.id]));
  const out = new Map<string, BidMoney>();
  for (const d of info.deposits) {
    const bidId = d.to_address ? byAddress.get(d.to_address) : undefined;
    if (!bidId) continue;
    const m = out.get(bidId) ?? { total: 0, counted: 0, confirmations: Infinity, first_height: null, notes: 0 };
    m.total += d.value_zatoshis;
    m.notes += 1;
    const closed = auction.closed?.height;
    if (d.mined_height !== null && (closed === undefined || d.mined_height <= closed)) m.counted += d.value_zatoshis;
    m.confirmations = Math.min(m.confirmations, d.confirmations);
    if (d.mined_height !== null) m.first_height = m.first_height === null ? d.mined_height : Math.min(m.first_height, d.mined_height);
    out.set(bidId, m);
  }
  for (const m of out.values()) if (!Number.isFinite(m.confirmations)) m.confirmations = 0;
  return out;
}

/**
 * What one more note costs a payout in network fees (ZIP 317 charges 5,000
 * zat per action). A vault holding more notes than one payout spends is merged
 * first (see the signer), which costs about the same per note.
 */
export const NOTE_FEE = 5_000;

/**
 * Every payment a bidder sends beyond the first is one more note for the
 * payout to spend. Its fee comes out of what goes back to that bidder, not out
 * of everyone's share: whoever sends a hundred tiny payments pays to have them
 * spent, and the seller and the other bidders pay the usual fee. What is taken
 * is handed to the signer as the prepaid part of the fee. A payment keeps at
 * least what a share of the rest of the fee needs. Returns the total taken.
 */
export function chargeExtraNotes(payments: PlannedPayment[], money: Map<string, BidMoney>): number {
  let prepaid = 0;
  const charged = new Set<string>();
  for (const p of payments) {
    if (!p.bidId || (p.kind !== "refund" && p.kind !== "winner-change") || charged.has(p.bidId)) continue;
    const extra = (money.get(p.bidId)?.notes ?? 0) - 1;
    if (extra <= 0) continue;
    const take = Math.min(extra * NOTE_FEE, Math.max(0, p.zatoshis - FEE_SHARE_FLOOR));
    p.zatoshis -= take;
    prepaid += take;
    charged.add(p.bidId);
  }
  return prepaid;
}

/**
 * An auction with a ceiling: what every bid must deposit, whatever it bids.
 * Null for an auction without one, where a deposit is the bid plus the bond
 * (or more), and for the oldest auctions.
 */
export function requiredDeposit(auction: Auction): number | null {
  return auction.scheme === 2 && auction.ceiling != null ? auction.ceiling + (auction.delivery?.buyer_bond ?? 0) : null;
}

/** The smallest deposit that could cover a bid in this auction: below it, a bid can't count whatever it holds. */
export function minimumDeposit(auction: Auction): number {
  return requiredDeposit(auction) ?? Math.max(1, auction.scheme === 2 ? auction.reserve + (auction.delivery?.buyer_bond ?? 0) : 1);
}

/**
 * Scheme 2: fixes the time lock as bidding opens. Bids are locked to the first
 * drand round signed after the end time, so not even this server can open one
 * while bidding is on.
 */
export async function lockInTime(auction: Auction): Promise<void> {
  if (auction.scheme !== 2) return;
  const chain = await beaconChain();
  auction.timelock = { chain, round: roundAfter(chain, auction.ends_at) };
}

function sealedBids(auction: Auction, money: Map<string, BidMoney>): SealedBid[] {
  // Scheme 2: the order the bids were placed, which everyone can see on the board.
  if (auction.scheme === 2) return auction.bids.map((b, order) => ({ id: b.id, order, deposit: money.get(b.id)?.counted ?? 0, revealed: b.reveal?.amount }));
  // Order of arrival: the height of the first deposit, then the order the bids were placed.
  const ranked = auction.bids
    .map((b, index) => ({ b, index, height: money.get(b.id)?.first_height ?? Number.MAX_SAFE_INTEGER }))
    .sort((x, y) => x.height - y.height || x.index - y.index);
  return ranked.map(({ b }, order) => ({
    id: b.id,
    order,
    deposit: money.get(b.id)?.counted ?? 0,
    revealed: b.reveal?.amount,
  }));
}

function toOutcome(auction: Auction): Outcome {
  const o = auction.outcome!;
  return { sold: o.sold, winnerId: o.winner_bid_id, price: o.price, standing: o.standing };
}

function record(payments: PlannedPayment[], paid: { zatoshis: number }[]): PaymentRecord[] {
  return payments.map((p, i) => ({ kind: p.kind, bid_id: p.bidId, owed: p.zatoshis, paid: paid[i]?.zatoshis ?? p.zatoshis }));
}

/** The seller's bond: what has arrived, from outside the wallet, at the escrow address and is in a block. */
function sellerBondSeen(escrow: VaultInfo): number {
  return escrow.deposits.filter((d) => d.mined_height !== null).reduce((s, d) => s + d.value_zatoshis, 0);
}

/** A new listing with a bond opens when the seller's bond is in a block, and is cancelled if it never comes. */
async function awaitBond(auction: Auction, now: number): Promise<void> {
  const d = auction.delivery!;
  const escrow = await vaultInfo(d.escrow_vault_id, true);
  if (sellerBondSeen(escrow) >= d.seller_bond) {
    d.bond_funded_at = now;
    // Bidding time (for a deal: the time the offer stands) starts now, not when the form was sent.
    auction.ends_at = now + (auction.duration_seconds ?? 0) * 1000;
    await lockInTime(auction);
    auction.state = "open";
    return;
  }
  if (now > auction.created_at + LIMITS.bondWaitSec * 1000) {
    auction.outcome = { sold: false, cancelled: true, standing: {}, counted: 0, decided_at: now };
    auction.state = "settled";
  }
}

async function close(auction: Auction, now: number): Promise<void> {
  const info = await vaultInfo(auction.vault_id, true);
  auction.closed = { at: now, height: info.scanned_height };
  auction.reveal_ends_at = now + auction.reveal_seconds * 1000;
  auction.state = "revealing";
}

const beaconAsked = new Map<string, number>();

/**
 * Scheme 2: opens the time-locked bids, once their round has been signed.
 * Only bids that can count are opened (their deposit is in full): the server
 * has no reason to learn what an unfunded bid held.
 */
async function openTimeLocked(auction: Auction, bids: Auction["bids"], now: number): Promise<void> {
  const lock = auction.timelock;
  if (!lock) return;
  if (!lock.beacon) {
    // Ask the relays at most every few seconds: a page view must not wait on them.
    if (now - (beaconAsked.get(auction.id) ?? 0) < 8000) return;
    beaconAsked.set(auction.id, now);
    if (beaconAsked.size > 5000) beaconAsked.clear();
    const beacon = await fetchBeacon(lock.chain, lock.round);
    if (!beacon) return; // not signed yet, or no relay answered: try again on the next pass
    lock.beacon = { round: beacon.round, signature: beacon.signature };
  }
  for (const bid of bids) {
    if (bid.reveal || bid.unopenable || !bid.sealed) continue;
    try {
      const { amount, blinding } = await openSealedBid(lock.chain, bid.sealed, lock.beacon);
      if (pedersenOpens(auction.id, bid.commitment, amount, blinding)) bid.reveal = { amount, nonce: blinding, at: now, by: "beacon" };
      else bid.unopenable = "mismatch"; // the locked bid is not the one that was committed to
    } catch (e) {
      // This machine's clock is behind the beacon's: nothing is wrong with the bid. The next pass tries again.
      if (e instanceof TooEarly) return;
      bid.unopenable = "not-a-bid";
    }
  }
}

/** Scheme 2: the public statement of a result, and what the coordinator knows that proves it. */
function fairnessStatement(auction: Auction, outcome: Outcome): { statement: FairnessStatement; openings: (Opening | undefined)[] } {
  const statement: FairnessStatement = {
    v: 2,
    auction_id: auction.id,
    reserve: auction.reserve,
    // Without a ceiling the proof's bound is the price (unsold: the reserve). Nothing that counted was higher.
    ceiling: auction.ceiling ?? (outcome.sold ? outcome.price! : auction.reserve),
    bids: auction.bids.map((b) => ({ commitment: b.commitment, status: boardStatusOf(outcome.standing[b.id]!) })),
    sold: outcome.sold,
    price: outcome.price ?? null,
    winner: outcome.sold ? auction.bids.findIndex((b) => b.id === outcome.winnerId) : null,
  };
  const openings = auction.bids.map((b) => (b.reveal ? { amount: b.reveal.amount, blinding: b.reveal.nonce } : undefined));
  return { statement, openings };
}

async function maybeDecide(auction: Auction, now: number): Promise<void> {
  const info = await vaultInfo(auction.vault_id, true);
  const money = moneyByBid(auction, info);
  // The bids worth waiting for: funded with at least the least a bid here could need.
  const funded = auction.bids.filter((b) => (money.get(b.id)?.counted ?? 0) >= minimumDeposit(auction));
  if (auction.scheme === 2) await openTimeLocked(auction, funded, now);
  const everyoneRevealed = funded.every((b) => b.reveal);
  if (now < (auction.reveal_ends_at ?? 0) && !everyoneRevealed) return;

  const bond = auction.delivery?.buyer_bond ?? 0;

  if (auction.batch) {
    // Order Flow: the highest orders win a unit each. Published with a proof, as an auction's result is.
    const result = decideBatch(auction.reserve, auction.batch.units, sealedBids(auction, money), bond);
    const statement = batchStatementOf(auction.id, auction.reserve, auction.batch.units, auction.bids.map((b) => ({ id: b.id, commitment: b.commitment })), result);
    const openings = auction.bids.map((b) => (b.reveal ? { amount: b.reveal.amount, blinding: b.reveal.nonce } : undefined));
    const proof = await proveBatch(statement, openings);
    const verdict = await verifyBatch(statement, proof);
    if (!verdict.ok) throw new Error(`the proof of the result does not check out: ${verdict.problems[0]}`);
    const bytes = await saveProof(auction.id, { statement, proof, timelock: auction.timelock ?? null, decided_at: now });
    auction.proof = { at: now, bytes };
    // Which winner gets which unit is a draw nobody outside can predict.
    // Handing the units out best first would tell each buyer, by their unit's
    // number, how many orders were above their own.
    //
    // The draw, and the ids of the units' records, come from a secret made
    // from the site's own key and this sale's id. So deciding the same sale
    // twice (a restart between the decision and its saving) gives the same
    // units, the same escrows and the same buyers in them: money already on
    // its way can't end up in a unit nobody remembers.
    const seed = createHash("sha256").update(`dark-vault/unit-seed:${(await siteKey()).secret}:${auction.id}`, "utf8").digest("hex");
    const winners = result.winners.map((w) => ({ bid_id: w.id, price: w.price }));
    for (let i = winners.length - 1; i > 0; i--) {
      const draw = BigInt(`0x${createHash("sha256").update(`dark-vault/unit-draw:${seed}:${i}`, "utf8").digest("hex")}`);
      const j = Number(draw % BigInt(i + 1));
      [winners[i], winners[j]] = [winners[j]!, winners[i]!];
    }
    auction.batch.unit_seed = seed;
    auction.outcome = {
      sold: result.sold,
      price: result.price,
      winners,
      standing: result.standing,
      counted: Object.values(result.standing).filter((x) => x === "won" || x === "outbid").length,
      decided_at: now,
    };
    auction.state = "settling";
    return;
  }

  const outcome = auction.scheme === 2 ? decideSealed(auction.reserve, auction.ceiling ?? null, sealedBids(auction, money), bond) : decide(auction.reserve, sealedBids(auction, money), bond);

  if (auction.scheme === 2) {
    // The result is published with a proof. A proof of a wrong result can't be
    // made, so this is also a check on everything above: if it fails, nothing
    // is decided and no money moves.
    const { statement, openings } = fairnessStatement(auction, outcome);
    const proof = await proveFairness(statement, openings);
    const verdict = await verifyFairness(statement, proof);
    if (!verdict.ok) throw new Error(`the proof of the result does not check out: ${verdict.problems[0]}`);
    const bytes = await saveProof(auction.id, { statement, proof, timelock: auction.timelock ?? null, decided_at: now });
    auction.proof = { at: now, bytes };
  }

  auction.outcome = {
    sold: outcome.sold,
    price: outcome.price,
    winner_bid_id: outcome.winnerId,
    standing: outcome.standing,
    counted: Object.values(outcome.standing).filter((s) => s === "won" || s === "outbid").length,
    decided_at: now,
  };
  auction.state = "settling";
}

/**
 * A private deal (Settlement). There is nothing to open and nothing to prove:
 * the price was fixed when the deal was made. The deal is taken as soon as one
 * acceptance's payment, price plus bond, is in a block. If the offer runs out
 * first, it ends unsettled. Either way the ordinary settlement follows: the
 * price and the buyer's bond go to escrow, and every other payment goes back.
 */
async function dealPass(auction: Auction, now: number): Promise<void> {
  const deal = auction.deal!;
  const info = await vaultInfo(auction.vault_id, true);
  const bond = auction.delivery?.buyer_bond ?? 0;
  const need = deal.price + bond;
  const seen = moneyByBid(auction, info); // nothing is closed yet: every payment in a block counts
  // Taken only once a payment in full has the confirmations the signer asks for,
  // so a block that is later replaced can't have started a handover.
  const taken = auction.bids.some((b) => {
    const m = seen.get(b.id);
    return !!m && m.counted >= need && m.confirmations >= info.min_confirmations;
  });
  const expired = now >= auction.ends_at + CLOSE_GRACE_MS;
  if (!taken && !expired) return;

  auction.closed = { at: now, height: info.scanned_height };
  const money = moneyByBid(auction, info);
  // First come, first served, by the block in which each payment became
  // complete (not the block of its first coin: a token payment sent early must
  // not jump the queue). Then by the order the acceptances were made.
  const byAddress = new Map(auction.bids.map((b) => [b.deposit_address, b.id]));
  const completeAt = new Map<string, number>();
  const running = new Map<string, number>();
  const mined = info.deposits.filter((d) => d.mined_height !== null && d.mined_height <= info.scanned_height).sort((x, y) => x.mined_height! - y.mined_height!);
  for (const d of mined) {
    const bidId = d.to_address ? byAddress.get(d.to_address) : undefined;
    if (!bidId || completeAt.has(bidId)) continue;
    const sum = (running.get(bidId) ?? 0) + d.value_zatoshis;
    running.set(bidId, sum);
    if (sum >= need) completeAt.set(bidId, d.mined_height!);
  }
  const ranked = auction.bids
    .map((b, index) => ({ b, index, height: completeAt.get(b.id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((x, y) => x.height - y.height || x.index - y.index);
  const outcome = decideDeal(
    deal.price,
    ranked.map(({ b }, order) => ({ id: b.id, order, deposit: money.get(b.id)?.counted ?? 0 })),
    bond,
  );
  auction.outcome = {
    sold: outcome.sold,
    price: outcome.price,
    winner_bid_id: outcome.winnerId,
    standing: outcome.standing,
    counted: outcome.sold ? 1 : 0,
    decided_at: now,
  };
  auction.state = "settling";
}

/**
 * Can these deposits be paid out at all? The network fee is shared by the
 * payments large enough to carry a share. After a sale there is always one
 * (the price). With no sale every payment is a deposit going back, so if each
 * of them is too small, nothing can carry the fee and nothing can move:
 * however many such crumbs there are, they must not stop the sale from ending.
 */
function movable(depositors: Depositor[], sold: boolean): boolean {
  return sold ? depositors.length > 0 : depositors.some((d) => d.deposit >= FEE_SHARE_FLOOR);
}

/** The price is held, not paid to the seller, when the lot sold and the auction has delivery. */
function escrowFor(auction: Auction): string | undefined {
  return auction.delivery && auction.outcome?.sold ? auction.delivery.escrow_address : undefined;
}

/** The winner's bond that goes into escrow with the price. */
function bondFor(auction: Auction): number {
  return escrowFor(auction) ? auction.delivery!.buyer_bond : 0;
}

/**
 * After the first payout: a sale with delivery starts its handover clocks. A
 * lot that did not sell still has the seller's bond to return. Anything else
 * is finished.
 */
function afterFirstPayout(auction: Auction, now: number): void {
  const d = auction.delivery;
  if (!d) {
    auction.state = "settled";
    return;
  }
  if (!auction.outcome?.sold) {
    if (d.seller_bond > 0) {
      d.resolution ??= { decision: "return-bond", reason: "not-sold", fault: "none", at: now };
      auction.state = "delivering";
    } else auction.state = "settled";
    return;
  }
  // If the first payout had to be sent again, the clocks keep their first start.
  if (!d.started_at) {
    d.started_at = now;
    if (d.kind === "digital") d.deliver_by = now + d.deliver_seconds * 1000;
    else d.address_by = now + d.deliver_seconds * 1000;
  }
  auction.state = "delivering";
}

async function settle(auction: Auction, now: number): Promise<void> {
  if (auction.batch) return settleBatch(auction, now);
  const info = await vaultInfo(auction.vault_id, true);
  const money = moneyByBid(auction, info);
  const depositors: Depositor[] = auction.bids
    .filter((b) => (money.get(b.id)?.total ?? 0) > 0)
    .map((b) => ({ id: b.id, deposit: money.get(b.id)!.total, refundAddress: b.refund_address }));
  const deposited = depositors.reduce((s, d) => s + d.deposit, 0);

  // A result was decided on a deposit the signer no longer shows (a block was
  // replaced, or the signer is scanning again). Nothing moves, and no handover
  // starts, until it is back.
  if (auction.outcome?.sold) {
    const winner = auction.outcome.winner_bid_id;
    const held = winner ? (money.get(winner)?.total ?? 0) : 0;
    if (held < (auction.outcome.price ?? 0) + bondFor(auction)) throw new Error("the winning deposit is not in the vault right now; waiting for the signer to show it again");
  }

  // The server stopped after the signer settled but before this record was
  // saved: adopt the settlement that exists rather than trying to pay twice.
  if (info.settlement && info.settlement.status !== "expired" && auction.settlements.length === 0) {
    const payments = plan(auction.id, auction.seller.payout_address, depositors, toOutcome(auction), escrowFor(auction), bondFor(auction));
    chargeExtraNotes(payments, money);
    auction.settlements.push({ txid: info.settlement.txid, fee: info.settlement.fee_zatoshis, at: now, payments: record(payments, info.settlement.payments) });
    auction.deposits_settled = Object.fromEntries(depositors.map((d) => [d.id, d.deposit]));
    afterFirstPayout(auction, now);
    return;
  }

  if (!movable(depositors, auction.outcome?.sold === true)) {
    // Nobody deposited, or all that came is less than a network fee can carry:
    // there is nothing that can be paid or returned from this vault. (Such
    // dust is not marked as settled: it goes back with any later deposit.)
    auction.deposits_settled = {};
    afterFirstPayout(auction, now);
    return;
  }
  if (deposited !== info.balance_total_zatoshis) {
    throw new Error(`the vault holds ${info.balance_total_zatoshis} zat but the bids' deposits add up to ${deposited} zat`);
  }
  if (info.balance_spendable_zatoshis !== info.balance_total_zatoshis) return; // still confirming

  const payments = plan(auction.id, auction.seller.payout_address, depositors, toOutcome(auction), escrowFor(auction), bondFor(auction));
  const prepaid = chargeExtraNotes(payments, money);
  const result = await settleVault(
    auction.vault_id,
    payments.map((p) => ({ to: p.to, zatoshis: p.zatoshis, memo: p.memo, pays_fee: p.pays_fee })),
    prepaid,
  );
  auction.settlements.push({ txid: result.txid, fee: result.fee_zatoshis, at: now, payments: record(payments, result.payments) });
  auction.deposits_settled = Object.fromEntries(depositors.map((d) => [d.id, d.deposit]));
  afterFirstPayout(auction, now);
}

// --- Order Flow: a batch sale ------------------------------------------------------

/**
 * The id of the record for unit `index` of a batch sale. It is always the
 * same for the same unit, so making the units twice makes them once; and it
 * hangs on a secret saved with the result (made from the site's own key),
 * which never leaves the server, so nobody outside can work it out.
 */
export function unitId(sale: Auction, index: number): string {
  const seed = sale.batch?.unit_seed;
  if (!seed) throw new Error("this sale has no units yet");
  return createHash("sha256").update(`dark-vault/unit:${seed}:${sale.id}:${index}`, "utf8").digest("hex").slice(0, 32);
}

/** Which unit of a batch sale an order won: its place among the units and its record's id. Null if it won none. */
export function unitWonBy(sale: Auction, bidId: string): { index: number; id: string } | null {
  const index = sale.batch?.unit_seed ? (sale.outcome?.winners ?? []).findIndex((w) => w.bid_id === bidId) : -1;
  return index < 0 ? null : { index, id: unitId(sale, index) };
}

/** Is a unit's handover over, with its payout in a block? */
export const unitFinished = (unit: Auction | null): boolean => unit?.state === "settled" && unit.delivery?.payout?.mined === true;

/** The records of a batch sale's sold units, in unit order. A unit not made yet is null. */
export async function unitsOf(sale: Auction): Promise<(Auction | null)[]> {
  return Promise.all((sale.outcome?.winners ?? []).map((_, k) => loadUnit(unitId(sale, k))));
}

/**
 * Makes a record, with an escrow vault of its own, for each unit that sold.
 * Done before any money moves, because the first payout pays into those
 * vaults. Safe to run again: a unit that exists is left as it is.
 */
async function ensureUnits(sale: Auction, now: number): Promise<Auction[]> {
  const d = sale.delivery!;
  const winners = sale.outcome?.winners ?? [];
  const units: Auction[] = [];
  for (let k = 0; k < winners.length; k++) {
    const id = unitId(sale, k);
    let unit = await loadUnit(id);
    if (!unit) {
      const bid = sale.bids.find((b) => b.id === winners[k]!.bid_id);
      if (!bid) throw new Error("a winning order is missing");
      const held = await createVault();
      const escrow_address = await newDepositAddress(held.vault_id);
      unit = {
        id,
        created_at: now,
        title: `${sale.title} (unit ${k + 1} of ${sale.batch!.units})`,
        description: sale.description,
        reserve: sale.reserve,
        ends_at: sale.ends_at,
        reveal_seconds: sale.reveal_seconds,
        seller: { ...sale.seller },
        // A unit takes no deposits of its own. Its one vault is its escrow.
        vault_id: held.vault_id,
        delivery: {
          kind: d.kind,
          seller_pub: d.seller_pub,
          ...(sale.batch!.lots[k] ? { lot: sale.batch!.lots[k] } : {}),
          deliver_seconds: d.deliver_seconds,
          dispute_seconds: d.dispute_seconds,
          // What stands behind this one handover: an equal share of the seller's bond.
          seller_bond: Math.floor(d.seller_bond / sale.batch!.units),
          buyer_bond: d.buyer_bond,
          ...(d.bond_funded_at ? { bond_funded_at: d.bond_funded_at } : {}),
          escrow_vault_id: held.vault_id,
          escrow_address,
        },
        state: "delivering",
        // The winner's order, without the sealed bid: all a handover needs is who to answer and where to refund.
        bids: [
          {
            id: bid.id,
            placed_at: bid.placed_at,
            commitment: bid.commitment,
            token_hash: bid.token_hash,
            refund_address: bid.refund_address,
            deposit_address: bid.deposit_address,
            ...(bid.delivery_pub ? { delivery_pub: bid.delivery_pub } : {}),
          },
        ],
        outcome: { sold: true, price: winners[k]!.price, winner_bid_id: bid.id, standing: { [bid.id]: "won" }, counted: 1, decided_at: sale.outcome!.decided_at },
        settlements: [],
        unit_of: { parent: sale.id, index: k, funded: {} },
      };
      await createAuction(unit);
    }
    units.push(unit);
  }
  return units;
}

/**
 * The first payout of a batch sale: each winner's price and bond to their
 * unit's escrow, what they deposited above that back to them, and every other
 * deposit home. Then the handover clocks of the units start.
 */
async function settleBatch(sale: Auction, now: number): Promise<void> {
  const info = await vaultInfo(sale.vault_id, true);
  const money = moneyByBid(sale, info);
  const depositors: Depositor[] = sale.bids
    .filter((b) => (money.get(b.id)?.total ?? 0) > 0)
    .map((b) => ({ id: b.id, deposit: money.get(b.id)!.total, refundAddress: b.refund_address }));
  const deposited = depositors.reduce((s, d) => s + d.deposit, 0);
  const winners = sale.outcome?.winners ?? [];
  const bond = sale.delivery!.buyer_bond;

  // A result decided on a deposit the signer no longer shows (a block was
  // replaced, or the signer is scanning again): nothing moves, and no unit is
  // made, until it is back.
  for (const w of winners) {
    if ((money.get(w.bid_id)?.total ?? 0) < w.price + bond) throw new Error("a winning deposit is not in the vault right now; waiting for the signer to show it again");
  }

  const units = await ensureUnits(sale, now);
  const outcome: BatchOutcome = { sold: winners.length > 0, winners: winners.map((w) => ({ id: w.bid_id, price: w.price })), standing: sale.outcome!.standing };
  const escrowOf = Object.fromEntries(winners.map((w, k) => [w.bid_id, units[k]!.delivery!.escrow_address]));
  // A buyer's extra payments carry their own fee (see chargeExtraNotes).
  let prepaid = 0;
  const planNow = () => {
    const payments = planBatch(sale.id, depositors, outcome, escrowOf, bond);
    prepaid = chargeExtraNotes(payments, money);
    return payments;
  };
  // An escrow payment is not something its bidder is shown as a payment of theirs: it is recorded without the bid.
  const recordOf = (payments: PlannedPayment[], paid: { zatoshis: number }[]) => record(payments, paid).map((p) => (p.kind === "escrow" ? { kind: p.kind, owed: p.owed, paid: p.paid } : p));
  /**
   * Tells each unit what was sent to its escrow, and starts its handover
   * clock. What was sent is read off the payout itself, by the escrow's
   * address. Done before the payout is written on the sale's record: if
   * anything here fails, the sale is still "not paid yet" on the next pass,
   * finds the payout the signer already made, and tells the units again.
   */
  const startUnits = async (sent: { to: string; zatoshis: number }[]) => {
    for (const unit of units) {
      const got = sent.filter((p) => p.to === unit.delivery!.escrow_address).reduce((n, p) => n + p.zatoshis, 0);
      if (got <= 0) throw new Error("a unit's escrow is missing from the payout");
      const told = await withUnit(unit.id, (u) => {
        u.unit_of!.funded.price = got;
        const d = u.delivery!;
        // If the first payout had to be sent again, the clock keeps its first start.
        if (!d.started_at) {
          d.started_at = now;
          d.deliver_by = now + d.deliver_seconds * 1000;
        }
        return true;
      });
      if (!told) throw new Error("a unit's record is missing");
    }
  };
  const finish = () => {
    if (winners.length > 0) sale.state = "delivering";
    // Nothing sold: the seller's bond goes back, as for a lot that did not sell.
    else afterFirstPayout(sale, now);
  };

  // The server stopped after the signer settled but before this record was saved.
  if (info.settlement && info.settlement.status !== "expired" && sale.settlements.length === 0) {
    const payments = planNow();
    await startUnits(info.settlement.payments);
    sale.settlements.push({ txid: info.settlement.txid, fee: info.settlement.fee_zatoshis, at: now, payments: recordOf(payments, info.settlement.payments) });
    sale.deposits_settled = Object.fromEntries(depositors.map((d) => [d.id, d.deposit]));
    finish();
    return;
  }

  if (!movable(depositors, winners.length > 0)) {
    sale.deposits_settled = {};
    finish();
    return;
  }
  if (deposited !== info.balance_total_zatoshis) throw new Error(`the vault holds ${info.balance_total_zatoshis} zat but the orders' deposits add up to ${deposited} zat`);
  if (info.balance_spendable_zatoshis !== info.balance_total_zatoshis) return; // still confirming

  const payments = planNow();
  const result = await settleVault(
    sale.vault_id,
    payments.map((p) => ({ to: p.to, zatoshis: p.zatoshis, memo: p.memo, pays_fee: p.pays_fee })),
    prepaid,
  );
  await startUnits(result.payments);
  sale.settlements.push({ txid: result.txid, fee: result.fee_zatoshis, at: now, payments: recordOf(payments, result.payments) });
  sale.deposits_settled = Object.fromEntries(depositors.map((d) => [d.id, d.deposit]));
  finish();
}

/**
 * How long a sale waits for a seller's bond that was seen before the sale
 * opened and is not in the vault now (the signer is scanning again, say)
 * before it carries on with whatever the vault does hold. A handover must not
 * wait for ever on a number that never comes back.
 */
const BOND_PATIENCE_MS = 3600_000;

/**
 * Shares the seller's bond out once the sale is decided: an equal part into
 * the escrow of each unit that sold, where it stands behind that handover,
 * and the rest straight back to the seller. Returns true once that is done
 * (a split that expired unmined is forgotten and made again).
 *
 * Each unit is told what it was sent before the split is written on the
 * sale's record, so a pass that fails halfway is simply done again.
 */
async function splitBond(sale: Auction, units: Auction[], now: number): Promise<boolean> {
  const d = sale.delivery!;
  const b = sale.batch!;
  const info = await vaultInfo(d.escrow_vault_id, true);
  const tell = async (shares: number[]) => {
    for (let k = 0; k < units.length; k++) {
      const told = await withUnit(units[k]!.id, (unit) => {
        unit.unit_of!.funded.bond = shares[k] ?? 0;
        return true;
      });
      if (!told) throw new Error("a unit's record is missing");
    }
  };
  const sentTo = (payments: { to: string; zatoshis: number }[], address: string) => payments.filter((p) => p.to === address).reduce((s, p) => s + p.zatoshis, 0);

  if (b.bond_split) {
    if (!b.bond_split.txid || info.settlements.find((x) => x.txid === b.bond_split!.txid)?.status !== "expired") return true;
    delete b.bond_split; // it never happened: the bond is back in the vault
  }

  // The split has been made (by this pass's signer, a moment or a restart ago) and is not on the record yet.
  if (info.settlement && info.settlement.status !== "expired") {
    const sent = info.settlement.payments;
    const shares = units.map((u) => sentTo(sent, u.delivery!.escrow_address));
    const back = sentTo(sent, sale.seller.payout_address);
    await tell(shares);
    b.bond_split = { txid: info.settlement.txid, fee: info.settlement.fee_zatoshis, at: now, to_seller: back > 0 ? { owed: back, paid: back } : null, shares: shares.map((n) => ({ owed: n, paid: n })) };
    return true;
  }

  const total = info.balance_total_zatoshis;
  // The bond was seen in a block before the sale opened. If the signer shows less now, wait for it to show it again, but not for ever.
  if (total < d.seller_bond && now - (sale.outcome?.decided_at ?? now) < BOND_PATIENCE_MS) throw new Error("the seller's bond is not in the vault right now; waiting for the signer to show it again");
  if (total < FEE_SHARE_FLOOR) {
    // A sale without bonds (or with nothing a fee could move): there is nothing to share out.
    await tell(units.map(() => 0));
    b.bond_split = { txid: null, fee: 0, at: now, to_seller: null, shares: units.map(() => ({ owed: 0, paid: 0 })) };
    return true;
  }
  if (info.balance_spendable_zatoshis !== total) return false; // still confirming

  const payments = planBondSplit(sale.id, total, b.units, sale.seller.payout_address, units.map((u) => u.delivery!.escrow_address), d.seller_bond);
  const result = await settleVault(
    d.escrow_vault_id,
    payments.map((p) => ({ to: p.to, zatoshis: p.zatoshis, memo: p.memo, pays_fee: p.pays_fee })),
  );
  const paidAt = (i: number) => result.payments[i]?.zatoshis ?? payments[i]!.zatoshis;
  const shares = units.map((_, k) => {
    const i = payments.findIndex((p) => p.unit === k);
    return i < 0 ? { owed: 0, paid: 0 } : { owed: payments[i]!.zatoshis, paid: paidAt(i) };
  });
  const back = payments.findIndex((p) => p.unit === null);
  await tell(shares.map((x) => x.paid));
  b.bond_split = { txid: result.txid, fee: result.fee_zatoshis, at: now, to_seller: back < 0 ? null : { owed: payments[back]!.zatoshis, paid: paidAt(back) }, shares };
  return true;
}

/**
 * A batch sale after its first payout. Late deposits still go back; the
 * seller's bond is shared out; and the sale is finished when every unit's
 * handover is.
 */
async function batchDelivering(sale: Auction, now: number): Promise<void> {
  let late: unknown = null;
  try {
    await returnLateDeposits(sale, now); // also notices a first payout that expired, and sends the sale back to pay again
  } catch (e) {
    late = e;
  }
  if (sale.state === "delivering") {
    const units = await ensureUnits(sale, now);
    const shared = await splitBond(sale, units, now);
    // Read again: the split has just told each unit what it was sent.
    const fresh = await unitsOf(sale);
    // Finished when every unit has been paid out and that payout is in a block.
    if (shared && fresh.every(unitFinished)) sale.state = "settled";
  }
  if (late) throw late;
}

/** What a payment's memo is tagged with: the sale's id, never the id of a unit's own record, which is nobody's to know. */
const memoId = (auction: Auction) => auction.unit_of?.parent ?? auction.id;

/**
 * Where the held price should go, and who was at fault, once that is decided
 * by what has happened and what time it is. Returns null while the handover is
 * still in progress. (Confirmations and disputes set the resolution
 * themselves, in lib/delivery.ts.)
 */
export function dueResolution(d: Delivery, now: number): { decision: "release" | "refund"; reason: ResolutionReason; fault: Fault } | null {
  if (d.kind !== "digital" && !d.shipping && !d.handover) {
    return now > (d.address_by ?? Infinity) ? { decision: "refund", reason: "no-shipping-details", fault: "winner" } : null;
  }
  if (!d.handover) return now > (d.deliver_by ?? Infinity) ? { decision: "refund", reason: "not-delivered", fault: "seller" } : null;
  if (d.dispute) {
    if (d.dispute.kind === "wrong-key") return null; // decided by the keys, at once
    // A return under way is decided by its own deadlines: whoever misses theirs loses.
    const ret = d.return;
    if (ret && !ret.problem) {
      if (!ret.address) return now > ret.address_by ? { decision: "refund", reason: "return-no-address", fault: "seller" } : null;
      if (!ret.sent) return now > (ret.send_by ?? Infinity) ? { decision: "release", reason: "return-not-sent", fault: "winner" } : null;
      return now > (ret.confirm_by ?? Infinity) ? { decision: "refund", reason: "returned", fault: "seller" } : null;
    }
    // A side asked for proof that sent nothing in time loses the dispute.
    // Both silent: nobody wins, and everyone's own money goes back.
    const silent = silentSide(d.dispute, now);
    if (silent === "winner") return { decision: "release", reason: "no-proof", fault: "winner" };
    if (silent === "seller") return { decision: "refund", reason: "no-proof", fault: "seller" };
    if (silent === "both") return { decision: "refund", reason: "operator-timeout", fault: "none" };
    // Nobody decided in time: no one's money can be trapped. The price goes
    // back to the winner, and each bond to its owner.
    if (now > (decideBy(d.dispute) ?? Infinity)) return { decision: "refund", reason: "operator-timeout", fault: "none" };
    return null;
  }
  return now > (d.dispute_by ?? Infinity) ? { decision: "release", reason: "no-complaint", fault: "none" } : null;
}

/** The second payout: everything in the escrow vault goes out, split by the resolution. */
async function payEscrow(auction: Auction, now: number): Promise<void> {
  const d = auction.delivery!;
  if (!d.resolution) {
    const due = dueResolution(d, now);
    if (!due) return;
    d.resolution = { ...due, at: now };
    // Keys a winner handed over for a dispute were for deciding it: not kept once it is decided.
    if (d.dispute) {
      delete d.dispute.lot_key;
      delete d.dispute.listing_key;
    }
  }
  const info = await vaultInfo(d.escrow_vault_id, true);
  const sold = auction.outcome?.sold === true;

  // The server stopped after the signer paid but before this record was saved.
  if (info.settlement && info.settlement.status !== "expired" && !d.payout) {
    const sent = info.settlement.payments;
    const paid = sent.reduce((s, p) => s + p.zatoshis, 0);
    const winnerAddress = auction.bids.find((b) => b.id === auction.outcome?.winner_bid_id)?.refund_address;
    // The plan is gone; what each side was sent can still be read off the payments.
    const got = (address: string | undefined) => {
      const n = sent.filter((p) => p.to === address).reduce((s, p) => s + p.zatoshis, 0);
      return n > 0 ? { owed: n, paid: n } : null;
    };
    d.payout = { txid: info.settlement.txid, fee: info.settlement.fee_zatoshis, at: now, owed: paid + info.settlement.fee_zatoshis, paid, to_seller: got(auction.seller.payout_address), to_winner: got(winnerAddress) };
    auction.state = "settled";
    if (d.dispute?.evidence) await deleteEvidence(auction.id).catch(() => {});
    return;
  }

  const total = info.balance_total_zatoshis;
  let sellerBond: number;
  // What the seller sent above the bond asked for: never at stake, always theirs.
  let sellerExtra = 0;
  if (auction.unit_of) {
    // A unit of a batch sale. Nothing reaches this vault from outside: the
    // sale sends it the winner's price and bond, then the seller's bond for
    // this unit. Wait until both have been sent and are here.
    const { price, bond } = auction.unit_of.funded;
    if (price === undefined || bond === undefined || total < price + bond) return;
    sellerBond = Math.min(bond, total);
  } else {
    const seen = Math.min(sellerBondSeen(info), total);
    sellerBond = Math.min(seen, d.seller_bond ?? 0);
    sellerExtra = seen - sellerBond;
    // After a sale the price is on its way here from the first payout. Wait for it.
    if (sold ? total <= sellerBond + sellerExtra : total === 0) {
      if (!sold && d.seller_bond === 0) auction.state = "settled";
      return;
    }
  }
  if (info.balance_spendable_zatoshis !== total) return; // still confirming

  const winner = sold ? auction.bids.find((b) => b.id === auction.outcome?.winner_bid_id) : undefined;
  if (sold && !winner) throw new Error("the winning bid is missing");
  const payments = planEscrowPayout(
    memoId(auction),
    { total, sellerBond, sellerExtra, buyerBond: sold ? Math.min(d.buyer_bond, total - sellerBond - sellerExtra) : 0, winnerPercent: d.resolution.winner_percent },
    d.resolution.decision,
    d.resolution.fault,
    auction.seller.payout_address,
    winner && { bidId: winner.id, refundAddress: winner.refund_address },
  );
  const result = await settleVault(
    d.escrow_vault_id,
    payments.map((p) => ({ to: p.to, zatoshis: p.zatoshis, memo: p.memo, pays_fee: p.pays_fee })),
  );
  const part = (kind: PlannedPayment["kind"]) => {
    const i = payments.findIndex((p) => p.kind === kind);
    return i < 0 ? null : { owed: payments[i]!.zatoshis, paid: result.payments[i]?.zatoshis ?? payments[i]!.zatoshis };
  };
  d.payout = {
    txid: result.txid,
    fee: result.fee_zatoshis,
    at: now,
    owed: total,
    paid: result.payments.reduce((s, p) => s + p.zatoshis, 0),
    to_seller: part("seller"),
    to_winner: part("escrow-refund"),
  };
  auction.state = "settled";
  // Evidence photos were for deciding the dispute. The payout is made: they are deleted.
  if (d.dispute?.evidence) await deleteEvidence(auction.id).catch(() => {});
}

/**
 * After everything is paid: a second payout that expired without being mined
 * never happened, so pay again. And a seller's bond that arrives after the
 * auction is over goes straight back to the seller.
 */
async function checkEscrow(auction: Auction, now: number): Promise<void> {
  const d = auction.delivery;
  if (!d) return;
  const last = d.payout?.at ?? auction.outcome?.decided_at ?? auction.created_at;
  if (now - last > 7 * 24 * 3600_000) return;
  const info = await vaultInfo(d.escrow_vault_id);
  if (d.payout && info.settlements.find((s) => s.txid === d.payout!.txid)?.status === "expired") {
    delete d.payout;
    auction.state = "delivering";
    return;
  }
  const total = info.balance_total_zatoshis;
  // Less than the network fee can carry can't be sent anywhere.
  if (total < FEE_SHARE_FLOOR || info.balance_spendable_zatoshis !== total) return;
  if (info.settlement && info.settlement.status === "pending") return;
  const payments = planEscrowPayout(memoId(auction), { total, sellerBond: total, buyerBond: 0 }, "return-bond", "none", auction.seller.payout_address);
  const result = await settleVault(
    d.escrow_vault_id,
    payments.map((p) => ({ to: p.to, zatoshis: p.zatoshis, memo: p.memo, pays_fee: p.pays_fee })),
  );
  (d.stray_returns ??= []).push({ txid: result.txid, at: now, paid: result.payments[0]?.zatoshis ?? 0 });
}

/** After settlement: money that arrives late at a bid's address goes straight back. */
async function returnLateDeposits(auction: Auction, now: number): Promise<void> {
  const last = auction.settlements[auction.settlements.length - 1];
  // Stop looking a week after the last payout.
  if (last && now - last.at > 7 * 24 * 3600_000) return;
  const info = await vaultInfo(auction.vault_id);

  // A payout that expired without being mined never happened: the money is
  // back in the vault. Forget the record and pay again.
  if (last && info.settlements.find((s) => s.txid === last.txid)?.status === "expired") {
    auction.settlements.pop();
    if (last.late) {
      const settled = auction.deposits_settled ?? {};
      for (const p of last.payments) if (p.bid_id) settled[p.bid_id] = Math.max(0, (settled[p.bid_id] ?? 0) - p.owed);
      auction.deposits_settled = settled;
    } else {
      delete auction.deposits_settled;
      auction.state = "settling";
    }
    return;
  }

  if (info.balance_total_zatoshis === 0) return;
  if (info.settlement && info.settlement.status === "pending") return;
  if (info.balance_spendable_zatoshis !== info.balance_total_zatoshis) return;

  const money = moneyByBid(auction, info);
  const settled = auction.deposits_settled ?? {};
  const late: Depositor[] = auction.bids
    .map((b) => ({ id: b.id, deposit: (money.get(b.id)?.total ?? 0) - (settled[b.id] ?? 0), refundAddress: b.refund_address }))
    .filter((d) => d.deposit > 0);
  const lateTotal = late.reduce((s, d) => s + d.deposit, 0);
  // Less than a network fee can carry can't be sent anywhere; it waits for more.
  if (!movable(late, false) || lateTotal !== info.balance_total_zatoshis) return;

  const payments = plan(auction.id, auction.seller.payout_address, late, { sold: false, standing: {} });
  const result = await settleVault(
    auction.vault_id,
    payments.map((p) => ({ to: p.to, zatoshis: p.zatoshis, memo: p.memo, pays_fee: p.pays_fee })),
  );
  auction.settlements.push({ txid: result.txid, fee: result.fee_zatoshis, at: now, payments: record(payments, result.payments), late: true });
  for (const d of late) settled[d.id] = (settled[d.id] ?? 0) + d.deposit;
  auction.deposits_settled = settled;
}

const lastRun: Map<string, number> = ((globalThis as Record<string, unknown>).__dvLastRun ??= new Map()) as Map<string, number>;
/** Auctions being advanced right now. Opening bids and proving a result can take a while. */
const busy: Set<string> = ((globalThis as Record<string, unknown>).__dvBusy ??= new Set()) as Set<string>;

/** One pass over a record under its lock: `steps` moves it as far as it can go right now. */
async function pass(id: string, unit: boolean, steps: (auction: Auction, now: number) => Promise<void>): Promise<Auction | null> {
  lastRun.set(id, Date.now());
  if (lastRun.size > 10000) lastRun.clear();
  return (unit ? withUnit : withAuction)(id, async (auction) => {
    const now = Date.now();
    busy.add(id);
    try {
      await steps(auction, now);
      delete auction.last_error;
    } catch (e) {
      // Kept for the operator; never shown to visitors. The next pass tries again.
      auction.last_error = e instanceof Error ? e.message : String(e);
    } finally {
      busy.delete(id);
    }
    return auction;
  });
}

/**
 * Moves one auction forward as far as it can go right now.
 *
 * Page views call this too, so unless `force` is set it does nothing if the
 * auction was advanced in the last few seconds: looking at a page must not
 * turn into signer work. Nor does a page view wait behind a pass that is
 * already running: it is shown the auction as it stands.
 *
 * A sold unit of a batch sale is not an auction here: for its id this returns
 * null, like any id that does not exist. See `advanceUnit`.
 */
export async function advance(id: string, force = false): Promise<Auction | null> {
  const recent = Date.now() - (lastRun.get(id) ?? 0) < 3000;
  if ((recent || busy.has(id)) && !force) return loadAuction(id);
  return pass(id, false, async (auction, now) => {
    // A few steps can happen in one go (for example close, then decide when nobody bid).
    for (let i = 0; i < 5; i++) {
      const before = auction.state;
      if (auction.state === "funding") await awaitBond(auction, now);
      else if (auction.state === "open") {
        if (auction.deal) await dealPass(auction, now);
        else if (now >= auction.ends_at + CLOSE_GRACE_MS) await close(auction, now);
      } else if (auction.state === "revealing") {
        await maybeDecide(auction, now);
        // A batch sale's result is saved before any of its money moves: this pass ends here, and the next one pays.
        if (auction.batch && auction.state !== "revealing") break;
      } else if (auction.state === "settling") await settle(auction, now);
      else if (auction.state === "delivering") {
        if (auction.batch && auction.outcome?.sold) await batchDelivering(auction, now);
        else {
          // Late deposits still go back, and a first payout that expired is sent again.
          // Whatever goes wrong there must not hold up the escrow payout.
          let late: unknown = null;
          try {
            await returnLateDeposits(auction, now);
          } catch (e) {
            late = e;
          }
          if (auction.state === "delivering") await payEscrow(auction, now);
          if (late) throw late;
        }
      } else if (auction.state === "settled") {
        await checkEscrow(auction, now);
        if (auction.state === "settled") await returnLateDeposits(auction, now);
      }
      if (auction.state === before) break;
    }
  });
}

/**
 * Moves one sold unit of a batch sale forward: its escrow pays out when its
 * handover is decided. Called by the timer and by the sale's own routes; a
 * unit's id is never taken from a request.
 */
export async function advanceUnit(id: string, force = false): Promise<Auction | null> {
  const recent = Date.now() - (lastRun.get(id) ?? 0) < 3000;
  if ((recent || busy.has(id)) && !force) return loadUnit(id);
  return pass(id, true, async (unit, now) => {
    for (let i = 0; i < 3; i++) {
      const before = unit.state;
      if (unit.state === "delivering") await payEscrow(unit, now);
      else if (unit.state === "settled") await checkEscrow(unit, now);
      if (unit.state === before) break;
    }
    // Note it down once the unit's payout is in a block: its sale waits for that.
    const d = unit.delivery;
    if (unit.state === "settled" && d?.payout && !d.payout.mined) {
      const info = await vaultInfo(d.escrow_vault_id);
      if (info.settlements.find((x) => x.txid === d.payout!.txid)?.status === "mined") d.payout.mined = true;
    }
  });
}

let running = false;

/** One pass over every auction. Called on a timer from instrumentation.ts. */
export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const records = await listRecords();
    // Units first, so that a sale sees in the same pass that its last unit has finished.
    for (const r of records) if (r.unit_of) await advanceUnit(r.id, true).catch(() => {});
    for (const r of records) if (!r.unit_of) await advance(r.id, true).catch(() => {});
  } finally {
    running = false;
  }
}
