// The numbers that bound an auction. Env overrides exist for tests and demos.
import "server-only";
import { MIN_BID } from "vault-core";

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const LIMITS = {
  titleMax: 80,
  descriptionMax: 1200,
  minReserve: MIN_BID,
  /** A deposit needs a block (about 75 seconds) to confirm, so auctions can't be shorter than this. */
  minDurationSec: num("VAULT_MIN_DURATION_SEC", 10 * 60),
  maxDurationSec: 14 * 24 * 3600,
  minRevealSec: num("VAULT_MIN_REVEAL_SEC", 5 * 60),
  maxRevealSec: 24 * 3600,
  /** The ceiling (highest bid allowed) can be at most this many times the reserve: every bidder has to deposit it. */
  maxCeilingMultiple: 100,
  /** No amount in an auction can be more than all the coins there will ever be (21 million). */
  maxAmount: 21_000_000 * 100_000_000,
  /** A time-locked bid is about 670 characters. */
  sealedMax: 1200,
  /** Bonds, as a percentage of the reserve (see vault-core bondFor). 0 switches bonds off. */
  bondPercent: (() => {
    const v = Number(process.env.VAULT_BOND_PERCENT ?? 10);
    return Number.isFinite(v) && v >= 0 && v <= 100 ? v : 10;
  })(),
  /** A seller's bond can't be more than this (it is a deposit, not a sale). */
  maxSellerBond: 1_000_000_000,
  /** How long a new listing waits for the seller's bond before it is cancelled. */
  bondWaitSec: num("VAULT_BOND_WAIT_SEC", 2 * 3600),
  replyMax: 600,
  /** Delivery: the shortest and longest time limits a seller can set for the handover and for complaints. */
  minDeliverySec: num("VAULT_MIN_DELIVERY_SEC", 3600),
  /** Physical lots: the shortest time a winner has to complain after "shipped", whatever the seller chose, since a parcel takes days. */
  minPhysicalComplaintSec: num("VAULT_MIN_PHYSICAL_COMPLAINT_SEC", 7 * 86400),
  /** A dispute the operator hasn't decided in this time ends as a refund with nobody at fault. */
  disputeDecideSec: num("VAULT_DISPUTE_DECIDE_SEC", 7 * 86400),
  /** Evidence photos each side may add to a dispute. */
  maxEvidencePhotos: 3,
  maxDeliverySec: 30 * 24 * 3600,
  /** An encrypted lot is the content (at most 1 MB) plus a small header and tag. */
  maxLotBytes: 1024 * 1024 + 2048,
  /** Order Flow: one unit of a batch sale is a code, a key or a short text, not a film. */
  maxUnitLotBytes: 64 * 1024 + 2048,
  disputeReasonMax: 600,
  envelopeMax: 8000,
  /**
   * Seats: how many bids an auction (or orders a sale) seats at once. A bid
   * takes a seat when it is placed and keeps it once funded; see seats.ts. It
   * keeps payouts small, and the page shows the seats left.
   */
  maxBidsPerAuction: num("VAULT_SEATS", 20),
  /** How long a new bid holds its seat without a deposit before the seat goes back. */
  seatHoldSec: num("VAULT_SEAT_HOLD_SEC", 10 * 60),
  /**
   * The most bids one auction takes in all, seated or not. Every bid costs
   * the signer an address to watch, and a payout pays at most 200 people.
   */
  maxPlacedBids: num("VAULT_MAX_BIDS", 120),
  /** A deal has one buyer: this many payment addresses at most are made for one deal. */
  maxDealAcceptances: 5,
  /** How long a deal's offer can stand. */
  maxDealOfferSec: 30 * 24 * 3600,
  /**
   * Finished deals join the public ledger in batches that close on a fixed
   * clock: once a day, at midnight UTC. A shorter batch is for tests and demos.
   */
  ledgerBatchMs: num("VAULT_LEDGER_BATCH_SEC", 24 * 3600) * 1000,
};
