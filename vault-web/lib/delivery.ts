// What the seller, the winner and the operator can do during delivery. Each
// function changes the auction record (the caller holds the auction's lock)
// and returns an error message, or null if it went through.
//
// The envelopes are sealed in the browsers (vault-core/delivery.ts). This file
// stores and relays them and never opens one. There are two exceptions, both
// started by the winner, both disputes over a digital lot:
//
//   - "wrong key": the winner hands over their delivery key, and the dispute
//     is decided here, at once, by repeating the check their browser made;
//   - "not as described": the winner hands over the lot key, so the operator
//     can open exactly what was delivered and compare it with the description.
//
// Every way a delivery can end also says who was at fault. That decides the
// bonds: whoever is at fault forfeits theirs to the other side (see
// vault-core planEscrowPayout).
import "server-only";
import { decryptListingWithKey, decryptLot, judgeDigitalDelivery, lotKeyHash, type Fault, type ListingText, type LotHeader } from "vault-core";
import { LIMITS } from "./limits";
import { lotOf } from "./store";
import type { Auction, Delivery } from "./types";

const ENVELOPE = /^[A-Za-z0-9+/]{80,}={0,2}$/;

export function validEnvelope(value: unknown): value is string {
  return typeof value === "string" && value.length <= LIMITS.envelopeMax && ENVELOPE.test(value);
}

function inProgress(auction: Auction): Delivery | string {
  const d = auction.delivery;
  if (!d) return "this auction has no delivery";
  if (!auction.outcome?.sold) return "there is no sale to deliver yet";
  if (auction.state !== "delivering" || d.resolution) return "the delivery is over";
  return d;
}

const unhex = (hex: string) => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));

/** The seller hands over: the lot key sealed to the winner (digital), or "shipped" with an optional sealed note (physical). */
export function sellerHandover(auction: Auction, now: number, envelope: string | undefined): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (d.handover) return "already handed over";
  if (d.kind === "digital") {
    if (!envelope) return "the sealed lot key is missing";
  } else if (!d.shipping) {
    const buyer = auction.deal ? "buyer" : "winner";
    return d.kind === "promise" ? `the ${buyer} has not said what they want yet` : `the ${buyer} has not sent shipping details yet`;
  }
  if (now > (d.deliver_by ?? 0)) return "the time to hand over has passed";
  d.handover = envelope ? { at: now, envelope } : { at: now };
  d.dispute_by = now + d.dispute_seconds * 1000;
  return null;
}

/** The seller answers a complaint, once, for the operator to read. */
export function sellerReply(auction: Auction, now: number, text: unknown): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (!d.dispute || d.dispute.kind === "wrong-key") return "there is no complaint to answer";
  if (d.dispute.seller_reply) return "you have already answered";
  const reply = typeof text === "string" ? text.trim() : "";
  if (reply.length < 10 || reply.length > LIMITS.replyMax) return `please answer in 10 to ${LIMITS.replyMax} characters`;
  d.dispute.seller_reply = { at: now, text: reply };
  return null;
}

/**
 * The winner says where a physical lot should go, or, for a promise, what
 * they want done. Sealed to the seller. Can be corrected until the seller
 * ships or marks it done.
 */
export function winnerShipping(auction: Auction, now: number, envelope: string): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (d.kind === "digital") return "this lot is not shipped";
  if (d.handover) return d.kind === "promise" ? "the seller has already marked it done" : "the seller has already shipped";
  if (!d.shipping) {
    if (now > (d.address_by ?? 0)) return d.kind === "promise" ? "the time to send your instructions has passed" : "the time to send shipping details has passed";
    d.deliver_by = now + d.deliver_seconds * 1000; // the seller's clock starts now
  }
  d.shipping = { at: now, envelope };
  return null;
}

/** The winner has the lot and it is what was described. The held price is released to the seller. */
export function winnerConfirm(auction: Auction, now: number): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (d.dispute) return "a dispute is open";
  // A parcel can arrive before the seller marks it shipped; a digital lot can't be had without the key.
  if (!d.handover && !(d.kind !== "digital" && d.shipping)) return "nothing has been handed over yet";
  d.confirmed_at = now;
  d.resolution = { decision: "release", reason: d.kind === "digital" ? "as-described" : "confirmed", fault: "none", at: now };
  return null;
}

/**
 * The winner complains.
 *
 * Digital, wrong key (`delivery_key`): the keys decide, at once. A winner who
 *   was right is refunded with the seller's bond; one who was wrong forfeits
 *   their own.
 * Digital, not as described (`lot_key` + `reason`): the lot key must really
 *   open the lot. The price stays held until the operator decides.
 * Physical (`reason`): the price stays held until the operator decides.
 */
export async function winnerDispute(auction: Auction, now: number, input: { delivery_key?: unknown; lot_key?: unknown; listing_key?: unknown; reason?: unknown }): Promise<string | null> {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (d.dispute) return "a dispute is already open";
  if (!d.handover) return "nothing has been handed over yet";
  if (now > (d.dispute_by ?? 0)) return "the time to complain has passed";
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const reasonProblem = reason.length < 10 || reason.length > LIMITS.disputeReasonMax ? `please say what is wrong, in 10 to ${LIMITS.disputeReasonMax} characters` : null;

  // A private auction's description is encrypted, and a dispute the operator
  // decides is about that description. The winner's browser hands over the
  // key to the listing (and only the listing) with the complaint.
  let listing: { listing_key: string } | Record<string, never> = {};
  const needsListing = !!auction.private && (d.kind !== "digital" || typeof input.lot_key === "string");
  if (needsListing) {
    if (typeof input.listing_key !== "string" || !/^[0-9a-f]{64}$/.test(input.listing_key)) return "the key to this private listing is needed, so the operator can read what was described";
    try {
      await decryptListingWithKey(input.listing_key, auction.private!.listing);
    } catch {
      return "that key does not open this auction's listing";
    }
    listing = { listing_key: input.listing_key };
  }

  if (d.kind !== "digital") {
    if (reasonProblem) return reasonProblem;
    d.dispute = { at: now, kind: d.kind, reason, ...listing };
    return null;
  }

  const winner = auction.bids.find((b) => b.id === auction.outcome!.winner_bid_id);
  const lot = await lotOf(auction);
  if (!winner?.delivery_pub || !d.lot || !lot || !d.handover.envelope) return "this delivery can't be checked";

  if (typeof input.lot_key === "string") {
    // "Not as described": only someone who really opened the lot can say so.
    if (reasonProblem) return reasonProblem;
    if (!/^[0-9a-f]{64}$/.test(input.lot_key)) return "that is not a lot key";
    const key = unhex(input.lot_key);
    try {
      if ((await lotKeyHash(key)) !== d.lot.key_hash) return "that key is not this lot's key";
      await decryptLot(key, lot);
    } catch {
      return "that key does not open the lot. Ask for your payment back instead.";
    }
    d.dispute = { at: now, kind: "not-as-described", reason, lot_key: input.lot_key, ...listing };
    return null;
  }

  if (typeof input.delivery_key !== "string") return "the delivery key is needed to check a digital lot";
  const verdict = await judgeDigitalDelivery({
    // The browsers seal to the sale they know: a unit of a batch sale is delivered under the sale's id.
    auctionId: auction.unit_of?.parent ?? auction.id,
    envelope: d.handover.envelope,
    deliveryKey: input.delivery_key,
    deliveryPublic: winner.delivery_pub,
    keyHash: d.lot.key_hash,
    lot,
  });
  if (verdict === "not-your-key") return "that is not this bid's delivery key";
  d.dispute = { at: now, kind: "wrong-key", verdict };
  d.resolution =
    verdict === "seller-cheated"
      ? { decision: "refund", reason: "wrong-key", fault: "seller", at: now }
      : { decision: "release", reason: "key-was-right", fault: "winner", at: now };
  return null;
}

/**
 * The operator decides a dispute. "release" pays the seller, "refund" returns
 * the price to the winner. Unless `noFault` is set, the side that lost the
 * dispute also loses its bond to the other.
 */
export function operatorResolve(auction: Auction, now: number, decision: unknown, noFault: unknown): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (!d.dispute || d.dispute.kind === "wrong-key") return "there is no dispute to decide";
  if (decision !== "release" && decision !== "refund") return "the decision must be release or refund";
  const fault: Fault = noFault === true ? "none" : decision === "release" ? "winner" : "seller";
  d.resolution = { decision, reason: "operator", fault, at: now };
  // The keys the winner handed over were for this decision. It is made: they are not kept.
  delete d.dispute.lot_key;
  delete d.dispute.listing_key;
  return null;
}

/** For the operator: the delivered lot, opened with the key the winner handed over. */
export async function disputedLot(auction: Auction): Promise<{ header: LotHeader; content: Uint8Array } | null> {
  const key = auction.delivery?.dispute?.lot_key;
  const lot = key ? await lotOf(auction) : null;
  if (!key || !lot) return null;
  try {
    return await decryptLot(unhex(key), lot);
  } catch {
    return null;
  }
}

/**
 * For the operator: what a private auction's listing says, opened with the
 * key the winner handed over with their complaint. Null when the auction is
 * not private or no key was handed over.
 */
export async function disputedListing(auction: Auction): Promise<ListingText | null> {
  const key = auction.delivery?.dispute?.listing_key;
  if (!key || !auction.private) return null;
  try {
    return await decryptListingWithKey(key, auction.private.listing);
  } catch {
    return null;
  }
}

export type DeliveryStage =
  | "not-started"
  | "awaiting-address" // physical: the winner hasn't said where to send it
  | "awaiting-handover" // the seller's turn
  | "awaiting-confirmation" // handed over; the winner can confirm or complain
  | "disputed" // waiting for the operator
  | "released" // the seller is paid
  | "refunded" // the winner got the price back
  | "bond-returned"; // not sold: the seller's bond went back

export function deliveryStage(auction: Auction): DeliveryStage {
  const d = auction.delivery!;
  if (d.resolution) return d.resolution.decision === "release" ? "released" : d.resolution.decision === "refund" ? "refunded" : "bond-returned";
  if (!d.started_at) return "not-started";
  if (d.dispute) return "disputed";
  if (d.handover) return "awaiting-confirmation";
  if (d.kind !== "digital" && !d.shipping) return "awaiting-address";
  return "awaiting-handover";
}
