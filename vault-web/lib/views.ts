// What each party is shown. The auction record holds private data (addresses,
// deposits, the settlement transaction); nothing leaves the server except
// through one of these three functions.
import "server-only";
import { boardStatusOf, isPublicBeacon, roundTimeMs } from "vault-core";
import { deliveryStage } from "./delivery";
import { moneyByBid, requiredDeposit, unitFinished, unitsOf } from "./engine";
import { HOUSE } from "./house/config";
import { LIMITS } from "./limits";
import { seatsOf } from "./seats";
import { vaultInfo, type VaultInfo } from "./signer";
import { sitePublic } from "./sitekey";
import type { Auction, Bid } from "./types";

/** What the signer says about an auction's vaults. The escrow vault is asked about only while the seller's bond is awaited and once it has paid out. */
export interface Infos {
  info: VaultInfo | null;
  escrow: VaultInfo | null;
  /** The public half of the key the site signs receipts with. */
  site_key?: string | null;
  /**
   * Order Flow, once the sale is decided: the record of each unit that sold,
   * in unit order (null for one not made yet), and what the signer says about
   * its escrow where that was asked for.
   */
  units?: { record: Auction | null; escrow: VaultInfo | null }[];
}

/**
 * `detail` matters only for a batch sale: whose units to ask the signer about.
 * "all" for the seller, a bid id for that order's bidder, nothing for the
 * public view, which shows no payment.
 */
export async function infosFor(auction: Auction, detail?: string): Promise<Infos> {
  const [info, escrow, site_key, units] = await Promise.all([
    vaultInfo(auction.vault_id).catch(() => null),
    auction.delivery && (auction.delivery.payout || auction.state === "funding" || auction.batch?.bond_split?.txid)
      ? vaultInfo(auction.delivery.escrow_vault_id).catch(() => null)
      : Promise.resolve(null),
    auction.scheme === 2 ? sitePublic() : Promise.resolve(null),
    auction.batch && auction.outcome?.winners?.length
      ? unitsOf(auction).then((records) =>
          Promise.all(
            records.map(async (record) => {
              const mine = detail === "all" || (detail !== undefined && record?.outcome?.winner_bid_id === detail);
              return { record, escrow: mine && record?.delivery?.payout ? await vaultInfo(record.delivery.escrow_vault_id).catch(() => null) : null };
            }),
          ),
        )
      : Promise.resolve(undefined),
  ]);
  return { info, escrow, site_key, ...(units ? { units } : {}) };
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
    seller_bond: d.seller_bond ?? 0,
    buyer_bond: d.buyer_bond ?? 0,
    /** A complaint waiting for the operator, with the seller's answer if they gave one. */
    dispute: d.dispute ? { at: d.dispute.at, kind: d.dispute.kind ?? "physical", reason: d.dispute.reason ?? null, verdict: d.dispute.verdict ?? null, seller_reply: d.dispute.seller_reply?.text ?? null } : null,
    resolution: d.resolution ? { decision: d.resolution.decision, reason: d.resolution.reason, fault: d.resolution.fault ?? "none" } : null,
    /** Whether the second payout has been mined. */
    paid: d.payout ? settlementStatus(escrow, d.payout.txid) : null,
  };
}

function settlementStatus(info: VaultInfo | null, txid: string): "pending" | "mined" | "expired" {
  return info?.settlements.find((s) => s.txid === txid)?.status ?? "pending";
}

/**
 * The auctions shown in lists. A listing appears once the seller's bond has
 * arrived. A private auction is never listed: it is reached by its invite
 * link only. Of the practice auctions only the newest is kept once they are
 * over: they are for trying the site, not a record anyone needs.
 */
export function listed(auctions: Auction[]): Auction[] {
  // A deal is never listed either (it is always private; this is the backstop).
  // Nor is a batch sale: it has a market of its own (Order Flow).
  const live = auctions.filter((a) => !a.private && !a.deal && !a.batch && !a.unit_of && a.state !== "funding" && !a.outcome?.cancelled);
  const newestPractice = live.filter((a) => a.house).sort((a, b) => b.created_at - a.created_at)[0];
  return live.filter((a) => !a.house || a.state !== "settled" || a === newestPractice);
}

/** The batch sales shown in the Order Flow market: every one whose seller's bond has arrived. */
export function listedSales(auctions: Auction[]): Auction[] {
  return auctions.filter((a) => !!a.batch && !a.private && !a.deal && !a.unit_of && a.state !== "funding" && !a.outcome?.cancelled);
}

const mask = (address: string) => `${address.slice(0, 14)}…${address.slice(-6)}`;

/** For anyone. No addresses, no deposits, no amounts except the reserve and, once decided, the price. */
export function publicView(auction: Auction, { info, escrow, site_key, units }: Infos) {
  const money = info ? moneyByBid(auction, info) : null;
  const first = auction.settlements[0];
  const d = auction.delivery;
  const lock = auction.timelock;
  // Scheme 2, once decided: how each bid fared, as the published result has it.
  const board = auction.scheme === 2 && auction.outcome && !auction.outcome.cancelled ? auction.bids.map((b) => boardStatusOf(auction.outcome!.standing[b.id] ?? "no-deposit")) : null;
  const onBoard = board?.filter((s) => s === "counted").length;
  return {
    id: auction.id,
    title: auction.title,
    description: auction.description,
    /**
     * A private auction: the title and description above are placeholders, and
     * this is the real listing, encrypted in the seller's browser. An invited
     * browser opens it with the key in its invite link. The site can't.
     */
    private: auction.private ? { listing: auction.private.listing } : null,
    /**
     * A private deal (Settlement): a fixed price, no bidding. The offer stands
     * until `ends_at`. Like every private record, this view is given only to a
     * browser that shows the invite.
     */
    deal: auction.deal ? { price: auction.deal.price, public_price: auction.deal.public_price } : null,
    /**
     * Order Flow: a batch sale of several identical units. `sold` is how many
     * found a buyer (null until decided) and `done` how many of those have
     * been handed over and paid out. Nothing is said about any one unit.
     */
    batch: auction.batch
      ? {
          units: auction.batch.units,
          sold: auction.outcome && !auction.outcome.cancelled ? (auction.outcome.winners?.length ?? 0) : null,
          done: units ? units.filter((u) => unitFinished(u.record)).length : auction.outcome ? 0 : null,
          /** What the seller put down for each unit. The whole bond is `delivery.seller_bond`. */
          seller_bond_per_unit: Math.floor((d?.seller_bond ?? 0) / auction.batch.units),
        }
      : null,
    /** 2: same-size deposits, time-locked bids and a published proof. 1: the first scheme. */
    scheme: (auction.scheme ?? 1) as 1 | 2,
    reserve: auction.reserve,
    /**
     * An auction with same-size deposits: the highest bid allowed, and what every bid must deposit (the ceiling plus the bond).
     * Both are null for an auction without a ceiling, where a deposit is the bid plus the bond, or more.
     */
    ceiling: auction.ceiling ?? null,
    deposit_required: requiredDeposit(auction),
    /**
     * Scheme 2: what bids are locked to. The browser seals each bid to this
     * chain and round, and checks for itself that the round comes after the
     * end time and whether the chain is the public drand network.
     */
    timelock: lock
      ? { chain: lock.chain, round: lock.round, opens_at: roundTimeMs(lock.chain, lock.round), public_beacon: isPublicBeacon(lock.chain), beacon: lock.beacon?.signature ?? null }
      : null,
    /** Scheme 2: the key the site signs receipts with. */
    site_key: site_key ?? null,
    /** Scheme 2, once decided: how each bid on the board fared, in the order placed, and whether the proof is ready. */
    board,
    proof: auction.proof ? { bytes: auction.proof.bytes } : null,
    /**
     * A practice auction run by the site: the seller is the site, and the bids
     * at these places on the board (1 is first) are its automated bidders'.
     */
    practice: auction.house
      ? {
          n: auction.house.n,
          bots: auction.house.bot_bids.length,
          bot_max: auction.house.bot_max,
          house_positions: auction.house.bot_bids.map((id) => auction.bids.findIndex((b) => b.id === id) + 1).filter((n) => n > 0),
          /** What a practice wallet's ready-made deposit covers: a bid placed with one can't be higher. */
          wallet_deposit: HOUSE.ceiling,
          /** A practice wallet pays a deposit until this moment: later, it would not reach a block before the close. */
          pay_until: auction.ends_at - HOUSE.payCutoffSec * 1000,
        }
      : null,
    created_at: auction.created_at,
    ends_at: auction.ends_at,
    reveal_seconds: auction.reveal_seconds,
    reveal_ends_at: auction.reveal_ends_at ?? null,
    state: auction.state,
    /** Sealed bids placed, funded or not. */
    bids: auction.bids.length,
    /** Listing photos (GET /api/auctions/<id>/photos/<n>). For a private auction or a deal they are encrypted with the listing's key. */
    photos: auction.photos ?? 0,
    /**
     * Seats: how many bids (orders) it seats at once, and how many are free.
     * A bid holds its seat for `hold_minutes` until its deposit arrives. Null for a deal, which has one buyer.
     */
    seats: auction.deal
      ? null
      : (() => {
          const s = seatsOf(auction, money ? (bid) => (money.get(bid)?.total ?? 0) > 0 : null);
          return { total: s.seats, left: s.left, may_free: s.may_free, closed: s.closed, hold_minutes: Math.ceil(LIMITS.seatHoldSec / 60) };
        })(),
    /** Bids with a confirmed deposit. Null when the signer can't be asked. */
    funded: money ? auction.bids.filter((b) => (money.get(b.id)?.total ?? 0) > 0).length : null,
    /**
     * Bids opened so far. Once a scheme 2 auction is decided this is the
     * number the board shows as counted, and no more: how many opened bids
     * were below the reserve or above the ceiling is nobody's business.
     */
    revealed: onBoard ?? auction.bids.filter((b) => b.reveal).length,
    /** The public board: every commitment, in the order placed. */
    commitments: auction.bids.map((b) => b.commitment),
    outcome: auction.outcome
      ? {
          sold: auction.outcome.sold,
          cancelled: !!auction.outcome.cancelled,
          price: auction.outcome.price ?? null,
          /** Scheme 2: the bids the board shows as counted. Before: the bids at or above the reserve. */
          counted: onBoard ?? auction.outcome.counted,
          /** Scheme 2: the winner's place on the board (1 is first). It is part of the published result. */
          winner_position: auction.scheme === 2 && auction.outcome.sold && !auction.batch ? auction.bids.findIndex((b) => b.id === auction.outcome!.winner_bid_id) + 1 : null,
          /**
           * Order Flow: the places on the board of the orders that won a unit,
           * in rising order. Part of the published result. `price` above is
           * then the lowest winning order; what any other winner offered is
           * not public.
           */
          winner_positions: auction.batch
            ? (auction.outcome.winners ?? []).map((w) => auction.bids.findIndex((b) => b.id === w.bid_id) + 1).filter((n) => n > 0).sort((a, b) => a - b)
            : null,
        }
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
          /** What the seller put down before bidding opened, and what every bid must carry on top of the bid. */
          seller_bond: d.seller_bond ?? 0,
          buyer_bond: d.buyer_bond ?? 0,
          /** What this site asks as a bond on its auctions, as a percentage of the reserve. A practice auction has none and says so. */
          usual_bond_percent: LIMITS.bondPercent,
          stage: auction.outcome?.sold && !auction.batch ? deliveryStage(auction) : null,
        }
      : null,
    signer_online: info !== null,
  };
}

export type PublicAuction = ReturnType<typeof publicView>;

/** The end of the ledger batch a moment falls in. */
const batchEnd = (at: number) => (Math.floor(at / LIMITS.ledgerBatchMs) + 1) * LIMITS.ledgerBatchMs;

/**
 * May this deal be on the public ledger yet? Decided from the record alone,
 * with no question to the signer, so a page that lists the ledger does the
 * same work however many deals are hidden.
 *
 * A deal is shown only if its seller chose to show the price, it completed
 * (the price was released to the seller), and the batch it finished in has
 * closed. Batches close on a fixed clock (once a day, at midnight UTC), so a
 * row can't be matched to the moment its deal finished or to a transaction.
 */
function ledgerDue(auction: Auction, now: number): boolean {
  const d = auction.delivery;
  return !!auction.deal?.public_price && auction.state === "settled" && auction.outcome?.sold === true && d?.resolution?.decision === "release" && !!d.payout && now >= batchEnd(d.payout.at);
}

/**
 * What the public ledger says about private deals: the price of each one that
 * may be shown, and nothing else. No id, no terms, no time, no party. Largest
 * first; two deals of the same price are the same row twice.
 */
export async function ledgerDeals(auctions: Auction[], now = Date.now()): Promise<{ price: number }[]> {
  const due = auctions.filter((a) => ledgerDue(a, now));
  const shown = await Promise.all(
    due.map(async (a) => {
      // Not before the payout is in a block.
      const escrow = await vaultInfo(a.delivery!.escrow_vault_id).catch(() => null);
      return settlementStatus(escrow, a.delivery!.payout!.txid) === "mined" ? { price: a.deal!.price } : null;
    }),
  );
  return shown.filter((d): d is { price: number } => d !== null).sort((a, b) => b.price - a.price);
}

/** For the bidder who holds this bid's token. */
export function bidView(auction: Auction, bid: Bid, { info, escrow: saleEscrow, units }: Infos) {
  const money = info ? moneyByBid(auction, info).get(bid.id) : undefined;
  // Order Flow: a winning order's handover runs on the record of the unit it won. Everything about it is read from there.
  const unitAt = auction.batch ? (auction.outcome?.winners ?? []).findIndex((w) => w.bid_id === bid.id) : -1;
  const unit = unitAt >= 0 ? (units?.[unitAt] ?? null) : null;
  const of = auction.batch ? unit?.record : auction;
  const escrow = auction.batch ? (unit?.escrow ?? null) : saleEscrow;
  const d = of?.delivery;
  const won = !!of && !!d && of.outcome?.sold === true && of.outcome.winner_bid_id === bid.id && !!d.started_at;
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
    /** Scheme 2: the time lock opened this bid, or the bidder's browser did. */
    opened_by: bid.reveal ? (bid.reveal.by ?? "bidder") : null,
    /** Scheme 2: the locked bid could not be used. The browser can still open the bid from its ticket while the reveal window lasts. */
    unopenable: bid.unopenable ?? null,
    /** Scheme 2: where this bid sits on the board (1 is first), and the site's signed receipt for it. */
    position: auction.bids.indexOf(bid) + 1,
    receipt: bid.receipt ?? null,
    /** A bid placed with a practice wallet, and what the house purse has sent to its address. */
    practice: bid.practice ? { paid: bid.practice_paid ? { at: bid.practice_paid.at, sent: bid.practice_paid.sent } : null } : null,
    standing: auction.outcome?.standing[bid.id] ?? null,
    payments,
    /** Only for the winner: the handover as it concerns them. */
    /**
     * Order Flow: this order won a unit, and this is what it pays (what it
     * offered). Told to its bidder alone; the public result gives only the
     * lowest winning order.
     */
    unit: unitAt >= 0 ? { number: unitAt + 1, price: auction.outcome!.winners![unitAt]!.price } : null,
    delivery: won
      ? {
          ...deliveryCommon(of!, escrow),
          /** Digital: the lot key, sealed to this bid's delivery key. Physical: the seller's sealed note, if any. */
          envelope: d!.handover?.envelope ?? null,
          lot: d!.lot ?? null,
          shipping_sent_at: d!.shipping?.at ?? null,
          verdict: d!.dispute?.verdict ?? null,
          /** What the second payout sends this bidder: the price back, a bond back, the seller's bond, or nothing. */
          refund: (() => {
            const p = d!.payout;
            // Records made before bonds have no split: a refund went to the winner in full.
            const part = p ? (p.to_winner !== undefined ? p.to_winner : d!.resolution?.decision === "refund" ? { owed: p.owed, paid: p.paid } : null) : null;
            return p && part ? { owed: part.owed, paid: part.paid, txid: p.txid, status: settlementStatus(escrow, p.txid) } : null;
          })(),
        }
      : null,
  };
}

export type BidView = ReturnType<typeof bidView>;

/** For the seller who holds the manage key. */
export function sellerView(auction: Auction, { info, escrow, units }: Infos) {
  const d = auction.delivery;
  const payments = auction.settlements.flatMap((s) =>
    s.payments.filter((p) => p.kind === "seller").map((p) => ({ owed: p.owed, paid: p.paid, txid: s.txid, status: settlementStatus(info, s.txid) })),
  );
  // With delivery, the seller is paid by the second payout, out of escrow: the price, their bond, or both.
  if (d?.payout) {
    const p = d.payout;
    const part = p.to_seller !== undefined ? p.to_seller : d.resolution?.decision === "release" ? { owed: p.owed, paid: p.paid } : null;
    if (part) payments.push({ owed: part.owed, paid: part.paid, txid: p.txid, status: settlementStatus(escrow, p.txid) });
  }
  // The seller's bond: where to send it, and what has arrived (only while the listing waits for it).
  const bond =
    d && (d.seller_bond ?? 0) > 0
      ? {
          required: d.seller_bond,
          address: d.escrow_address,
          received: auction.state === "funding" && escrow ? escrow.deposits.reduce((sum, x) => sum + x.value_zatoshis, 0) : null,
          confirmed: !!d.bond_funded_at,
          wait_until: auction.created_at + LIMITS.bondWaitSec * 1000,
        }
      : null;
  const winner = d && auction.outcome?.sold && d.started_at ? auction.bids.find((b) => b.id === auction.outcome!.winner_bid_id) : undefined;
  // Order Flow: one entry per unit that sold. The seller is paid each unit's own price, so they are shown it.
  const split = auction.batch?.bond_split;
  const sold = auction.batch
    ? (auction.outcome?.winners ?? []).map((w, k) => {
        const u = units?.[k]?.record ?? null;
        const ud = u?.delivery;
        const p = ud?.payout;
        const buyer = u?.bids[0];
        return {
          unit: k + 1,
          price: w.price,
          delivery:
            u && ud?.started_at
              ? {
                  ...deliveryCommon(u, units![k]!.escrow),
                  winner_pub: buyer?.delivery_pub ?? null,
                  shipping: null,
                  held: w.price,
                }
              : null,
          /** What this unit's escrow paid the seller: the price, their bond for the unit, or both. */
          proceeds: p?.to_seller ? { owed: p.to_seller.owed, paid: p.to_seller.paid, txid: p.txid, status: settlementStatus(units![k]!.escrow, p.txid) } : null,
        };
      })
    : null;
  return {
    payout_address: mask(auction.seller.payout_address),
    proceeds: payments[0] ?? null,
    /** Order Flow: the units that sold, in unit order, and the seller's bond for the units that did not. */
    units: sold,
    bond_back: split?.to_seller && split.txid ? { owed: split.to_seller.owed, paid: split.to_seller.paid, txid: split.txid, status: settlementStatus(escrow, split.txid) } : null,
    bond,
    delivery:
      d && winner
        ? {
            ...deliveryCommon(auction, escrow),
            /** The winner's delivery key (public): the seller's browser seals the lot key or a note to it. */
            winner_pub: winner.delivery_pub ?? null,
            /** Physical: the winner's shipping details, sealed to the seller. */
            shipping: d.shipping ? { at: d.shipping.at, envelope: d.shipping.envelope } : null,
            held: auction.outcome?.price ?? null,
          }
        : null,
  };
}

export type SellerView = ReturnType<typeof sellerView>;
