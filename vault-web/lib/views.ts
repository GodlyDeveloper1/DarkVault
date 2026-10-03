// What each party is shown. The auction record holds private data (addresses,
// deposits, the settlement transaction); nothing leaves the server except
// through one of these three functions.
import "server-only";
import { deliveryStage } from "./delivery";
import { moneyByBid } from "./engine";
import { vaultInfo, type VaultInfo } from "./signer";
import type { Auction, Bid } from "./types";

/** What the signer says about an auction's vaults. The escrow vault is asked about only once it has paid out. */
export interface Infos {
  info: VaultInfo | null;
  escrow: VaultInfo | null;
}

export async function infosFor(auction: Auction): Promise<Infos> {
  const [info, escrow] = await Promise.all([
    vaultInfo(auction.vault_id).catch(() => null),
    auction.delivery?.payout ? vaultInfo(auction.delivery.escrow_vault_id).catch(() => null) : Promise.resolve(null),
  ]);
  return { info, escrow };
}

/** The part of the delivery everyone taking part may see: where it stands and the time limits. */
function deliveryCommon(auction: Auction, escrow: VaultInfo | null) {
  const d = auction.delivery!;
  return {
    kind: d.kind,
    stage: deliveryStage(auction),
    deliver_seconds: d.deliver_seconds,
    dispute_seconds: d.dispute_seconds,
    address_by: d.address_by ?? null,
    deliver_by: d.deliver_by ?? null,
    dispute_by: d.dispute_by ?? null,
    handed_over_at: d.handover?.at ?? null,
    disputed: !!d.dispute,
    resolution: d.resolution ? { decision: d.resolution.decision, reason: d.resolution.reason } : null,
    /** Whether the second payout has been mined. */
    paid: d.payout ? settlementStatus(escrow, d.payout.txid) : null,
  };
}

function settlementStatus(info: VaultInfo | null, txid: string): "pending" | "mined" | "expired" {
  return info?.settlements.find((s) => s.txid === txid)?.status ?? "pending";
}

const mask = (address: string) => `${address.slice(0, 14)}…${address.slice(-6)}`;

/** For anyone. No addresses, no deposits, no amounts except the reserve and, once decided, the price. */
export function publicView(auction: Auction, { info, escrow }: Infos) {
  const money = info ? moneyByBid(auction, info) : null;
  const first = auction.settlements[0];
  const d = auction.delivery;
  return {
    id: auction.id,
    title: auction.title,
    description: auction.description,
    reserve: auction.reserve,
    created_at: auction.created_at,
    ends_at: auction.ends_at,
    reveal_seconds: auction.reveal_seconds,
    reveal_ends_at: auction.reveal_ends_at ?? null,
    state: auction.state,
    /** Sealed bids placed, funded or not. */
    bids: auction.bids.length,
    /** Bids with a confirmed deposit. Null when the signer can't be asked. */
    funded: money ? auction.bids.filter((b) => (money.get(b.id)?.total ?? 0) > 0).length : null,
    /** Bidders who have opened their commitment. */
    revealed: auction.bids.filter((b) => b.reveal).length,
    /** The public board: every commitment, in the order placed. */
    commitments: auction.bids.map((b) => b.commitment),
    outcome: auction.outcome
      ? { sold: auction.outcome.sold, price: auction.outcome.price ?? null, counted: auction.outcome.counted }
      : null,
    /** Whether the payout transaction has been mined. The transaction itself is shown only to the people it pays. */
    paid: auction.state === "settled" ? (d?.payout ? settlementStatus(escrow, d.payout.txid) : first ? settlementStatus(info, first.txid) : "nothing-to-pay") : null,
    /** How the lot reaches the winner. Null on auctions that pay the seller at the close. */
    delivery: d
      ? {
          kind: d.kind,
          /** The seller's public key: the winner's browser seals shipping details to it. */
          seller_pub: d.seller_pub,
          deliver_seconds: d.deliver_seconds,
          dispute_seconds: d.dispute_seconds,
          stage: auction.outcome?.sold ? deliveryStage(auction) : null,
        }
      : null,
    signer_online: info !== null,
  };
}

export type PublicAuction = ReturnType<typeof publicView>;

/** For the bidder who holds this bid's token. */
export function bidView(auction: Auction, bid: Bid, { info, escrow }: Infos) {
  const money = info ? moneyByBid(auction, info).get(bid.id) : undefined;
  const d = auction.delivery;
  const won = !!d && auction.outcome?.sold === true && auction.outcome.winner_bid_id === bid.id && !!d.started_at;
  const payments = auction.settlements.flatMap((s) =>
    s.payments
      .filter((p) => p.bid_id === bid.id)
      .map((p) => ({ kind: p.kind, owed: p.owed, paid: p.paid, txid: s.txid, status: settlementStatus(info, s.txid), late: !!s.late })),
  );
  return {
    bid_id: bid.id,
    placed_at: bid.placed_at,
    commitment: bid.commitment,
    deposit_address: bid.deposit_address,
    refund_address: mask(bid.refund_address),
    deposit: money
      ? { total: money.total, counted: money.counted, confirmations: money.confirmations, needed: info!.min_confirmations }
      : info
        ? { total: 0, counted: 0, confirmations: 0, needed: info.min_confirmations }
        : null,
    revealed: !!bid.reveal,
    standing: auction.outcome?.standing[bid.id] ?? null,
    payments,
    /** Only for the winner: the handover as it concerns them. */
    delivery: won
      ? {
          ...deliveryCommon(auction, escrow),
          /** Digital: the lot key, sealed to this bid's delivery key. Physical: the seller's sealed note, if any. */
          envelope: d!.handover?.envelope ?? null,
          lot: d!.lot ?? null,
          shipping_sent_at: d!.shipping?.at ?? null,
          verdict: d!.dispute?.verdict ?? null,
          /** The held price coming back, if the lot was not delivered. */
          refund:
            d!.payout && d!.resolution?.decision === "refund"
              ? { owed: d!.payout.owed, paid: d!.payout.paid, txid: d!.payout.txid, status: settlementStatus(escrow, d!.payout.txid) }
              : null,
        }
      : null,
  };
}

export type BidView = ReturnType<typeof bidView>;

/** For the seller who holds the manage key. */
export function sellerView(auction: Auction, { info, escrow }: Infos) {
  const d = auction.delivery;
  const payments = auction.settlements.flatMap((s) =>
    s.payments.filter((p) => p.kind === "seller").map((p) => ({ owed: p.owed, paid: p.paid, txid: s.txid, status: settlementStatus(info, s.txid) })),
  );
  // With delivery, the seller is paid by the second payout, out of escrow.
  if (d?.payout && d.resolution?.decision === "release") {
    payments.push({ owed: auction.outcome?.price ?? d.payout.owed, paid: d.payout.paid, txid: d.payout.txid, status: settlementStatus(escrow, d.payout.txid) });
  }
  const winner = d && auction.outcome?.sold && d.started_at ? auction.bids.find((b) => b.id === auction.outcome!.winner_bid_id) : undefined;
  return {
    payout_address: mask(auction.seller.payout_address),
    proceeds: payments[0] ?? null,
    delivery:
      d && winner
        ? {
            ...deliveryCommon(auction, escrow),
            /** The winner's delivery key (public): the seller's browser seals the lot key or a note to it. */
            winner_pub: winner.delivery_pub ?? null,
            /** Physical: the winner's shipping details, sealed to the seller. */
            shipping: d.shipping ? { at: d.shipping.at, envelope: d.shipping.envelope } : null,
            dispute: d.dispute ? { at: d.dispute.at, reason: d.dispute.reason ?? null, verdict: d.dispute.verdict ?? null } : null,
            held: auction.outcome?.price ?? null,
          }
        : null,
  };
}

export type SellerView = ReturnType<typeof sellerView>;
