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
// Money only moves in `settle`, `payEscrow` and `returnLateDeposits`, and only
// as the plans from vault-core say. The signer then refuses anything that
// doesn't add up to exactly what a vault holds.
import "server-only";
import { decide, FEE_SHARE_FLOOR, plan, planEscrowPayout, type Depositor, type Fault, type Outcome, type PlannedPayment, type SealedBid } from "vault-core";
import { LIMITS } from "./limits";
import { listAuctions, loadAuction, withAuction } from "./store";
import { settleVault, vaultInfo, type VaultInfo } from "./signer";
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
}

/** Matches each deposit in the vault to its bid, by the address it arrived at. */
export function moneyByBid(auction: Auction, info: VaultInfo): Map<string, BidMoney> {
  const byAddress = new Map(auction.bids.map((b) => [b.deposit_address, b.id]));
  const out = new Map<string, BidMoney>();
  for (const d of info.deposits) {
    const bidId = d.to_address ? byAddress.get(d.to_address) : undefined;
    if (!bidId) continue;
    const m = out.get(bidId) ?? { total: 0, counted: 0, confirmations: Infinity, first_height: null };
    m.total += d.value_zatoshis;
    const closed = auction.closed?.height;
    if (d.mined_height !== null && (closed === undefined || d.mined_height <= closed)) m.counted += d.value_zatoshis;
    m.confirmations = Math.min(m.confirmations, d.confirmations);
    if (d.mined_height !== null) m.first_height = m.first_height === null ? d.mined_height : Math.min(m.first_height, d.mined_height);
    out.set(bidId, m);
  }
  for (const m of out.values()) if (!Number.isFinite(m.confirmations)) m.confirmations = 0;
  return out;
}

function sealedBids(auction: Auction, money: Map<string, BidMoney>): SealedBid[] {
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
    // Bidding time starts now, not when the form was sent.
    auction.ends_at = now + (auction.duration_seconds ?? 0) * 1000;
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

async function maybeDecide(auction: Auction, now: number): Promise<void> {
  const info = await vaultInfo(auction.vault_id, true);
  const money = moneyByBid(auction, info);
  const funded = auction.bids.filter((b) => (money.get(b.id)?.counted ?? 0) > 0);
  const everyoneRevealed = funded.every((b) => b.reveal);
  if (now < (auction.reveal_ends_at ?? 0) && !everyoneRevealed) return;

  const outcome = decide(auction.reserve, sealedBids(auction, money), auction.delivery?.buyer_bond ?? 0);
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
  const info = await vaultInfo(auction.vault_id, true);
  const money = moneyByBid(auction, info);
  const depositors: Depositor[] = auction.bids
    .filter((b) => (money.get(b.id)?.total ?? 0) > 0)
    .map((b) => ({ id: b.id, deposit: money.get(b.id)!.total, refundAddress: b.refund_address }));
  const deposited = depositors.reduce((s, d) => s + d.deposit, 0);

  // The server stopped after the signer settled but before this record was
  // saved: adopt the settlement that exists rather than trying to pay twice.
  if (info.settlement && info.settlement.status !== "expired" && auction.settlements.length === 0) {
    const payments = plan(auction.id, auction.seller.payout_address, depositors, toOutcome(auction), escrowFor(auction), bondFor(auction));
    auction.settlements.push({ txid: info.settlement.txid, fee: info.settlement.fee_zatoshis, at: now, payments: record(payments, info.settlement.payments) });
    auction.deposits_settled = Object.fromEntries(depositors.map((d) => [d.id, d.deposit]));
    afterFirstPayout(auction, now);
    return;
  }

  if (deposited === 0) {
    // Nobody deposited: there is nothing to pay or return from this vault.
    auction.deposits_settled = {};
    afterFirstPayout(auction, now);
    return;
  }
  if (deposited !== info.balance_total_zatoshis) {
    throw new Error(`the vault holds ${info.balance_total_zatoshis} zat but the bids' deposits add up to ${deposited} zat`);
  }
  if (info.balance_spendable_zatoshis !== info.balance_total_zatoshis) return; // still confirming

  const payments = plan(auction.id, auction.seller.payout_address, depositors, toOutcome(auction), escrowFor(auction), bondFor(auction));
  const result = await settleVault(
    auction.vault_id,
    payments.map((p) => ({ to: p.to, zatoshis: p.zatoshis, memo: p.memo, pays_fee: p.pays_fee })),
  );
  auction.settlements.push({ txid: result.txid, fee: result.fee_zatoshis, at: now, payments: record(payments, result.payments) });
  auction.deposits_settled = Object.fromEntries(depositors.map((d) => [d.id, d.deposit]));
  afterFirstPayout(auction, now);
}

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
  if (d.dispute) return null; // decided by the keys or by the operator
  return now > (d.dispute_by ?? Infinity) ? { decision: "release", reason: "no-complaint", fault: "none" } : null;
}

/** The second payout: everything in the escrow vault goes out, split by the resolution. */
async function payEscrow(auction: Auction, now: number): Promise<void> {
  const d = auction.delivery!;
  if (!d.resolution) {
    const due = dueResolution(d, now);
    if (!due) return;
    d.resolution = { ...due, at: now };
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
    return;
  }

  const total = info.balance_total_zatoshis;
  const sellerBond = Math.min(sellerBondSeen(info), total);
  // After a sale the price is on its way here from the first payout. Wait for it.
  if (sold ? total <= sellerBond : total === 0) {
    if (!sold && d.seller_bond === 0) auction.state = "settled";
    return;
  }
  if (info.balance_spendable_zatoshis !== total) return; // still confirming

  const winner = sold ? auction.bids.find((b) => b.id === auction.outcome?.winner_bid_id) : undefined;
  if (sold && !winner) throw new Error("the winning bid is missing");
  const payments = planEscrowPayout(
    auction.id,
    { total, sellerBond, buyerBond: sold ? Math.min(d.buyer_bond, total - sellerBond) : 0 },
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
  const payments = planEscrowPayout(auction.id, { total, sellerBond: total, buyerBond: 0 }, "return-bond", "none", auction.seller.payout_address);
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
  if (lateTotal === 0 || lateTotal !== info.balance_total_zatoshis) return;

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

/**
 * Moves one auction forward as far as it can go right now.
 *
 * Page views call this too, so unless `force` is set it does nothing if the
 * auction was advanced in the last few seconds: looking at a page must not
 * turn into signer work.
 */
export async function advance(id: string, force = false): Promise<Auction | null> {
  const recent = Date.now() - (lastRun.get(id) ?? 0) < 3000;
  if (recent && !force) return loadAuction(id);
  lastRun.set(id, Date.now());
  if (lastRun.size > 10000) lastRun.clear();
  return withAuction(id, async (auction) => {
    const now = Date.now();
    try {
      // A few steps can happen in one go (for example close, then decide when nobody bid).
      for (let i = 0; i < 5; i++) {
        const before = auction.state;
        if (auction.state === "funding") await awaitBond(auction, now);
        else if (auction.state === "open") {
          if (now >= auction.ends_at + CLOSE_GRACE_MS) await close(auction, now);
        } else if (auction.state === "revealing") await maybeDecide(auction, now);
        else if (auction.state === "settling") await settle(auction, now);
        else if (auction.state === "delivering") {
          // Late deposits still go back, and a first payout that expired is sent again.
          await returnLateDeposits(auction, now);
          if (auction.state === "delivering") await payEscrow(auction, now);
        } else if (auction.state === "settled") {
          await checkEscrow(auction, now);
          if (auction.state === "settled") await returnLateDeposits(auction, now);
        }
        if (auction.state === before) break;
      }
      delete auction.last_error;
    } catch (e) {
      // Kept for the operator; never shown to visitors. The next pass tries again.
      auction.last_error = e instanceof Error ? e.message : String(e);
    }
    return auction;
  });
}

let running = false;

/** One pass over every auction. Called on a timer from instrumentation.ts. */
export async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const auction of await listAuctions()) {
      await advance(auction.id, true).catch(() => {});
    }
  } finally {
    running = false;
  }
}
