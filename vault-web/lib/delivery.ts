// What the seller, the winner and the operator can do during delivery. Each
// function changes the auction record (the caller holds the auction's lock)
// and returns an error message, or null if it went through.
//
// The envelopes are sealed in the browsers (vault-core/delivery.ts). This file
// stores and relays them and never opens one, with a single exception: when a
// winner disputes a digital lot they hand over their delivery key, and the
// dispute is decided here by repeating the check their browser made.
import "server-only";
import { judgeDigitalDelivery } from "vault-core";
import { LIMITS } from "./limits";
import { loadLot } from "./store";
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

/** The seller hands over: the lot key sealed to the winner (digital), or "shipped" with an optional sealed note (physical). */
export function sellerHandover(auction: Auction, now: number, envelope: string | undefined): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (d.handover) return "already handed over";
  if (d.kind === "digital") {
    if (!envelope) return "the sealed lot key is missing";
  } else if (!d.shipping) return "the winner has not sent shipping details yet";
  if (now > (d.deliver_by ?? 0)) return "the time to hand over has passed";
  d.handover = envelope ? { at: now, envelope } : { at: now };
  d.dispute_by = now + d.dispute_seconds * 1000;
  return null;
}

/** The winner says where a physical lot should go. Can be corrected until the seller ships. */
export function winnerShipping(auction: Auction, now: number, envelope: string): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (d.kind !== "physical") return "this lot is not shipped";
  if (d.handover) return "the seller has already shipped";
  if (!d.shipping) {
    if (now > (d.address_by ?? 0)) return "the time to send shipping details has passed";
    d.deliver_by = now + d.deliver_seconds * 1000; // the seller's clock starts now
  }
  d.shipping = { at: now, envelope };
  return null;
}

/** The winner has the lot. The held price is released to the seller. */
export function winnerConfirm(auction: Auction, now: number): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (d.dispute) return "a dispute is open";
  // A parcel can arrive before the seller marks it shipped; a digital lot can't be had without the key.
  if (!d.handover && !(d.kind === "physical" && d.shipping)) return "nothing has been handed over yet";
  d.confirmed_at = now;
  d.resolution = { decision: "release", reason: "confirmed", at: now };
  return null;
}

/**
 * The winner complains.
 *
 * Digital: they hand over their delivery key and the keys decide, at once.
 * Physical: the price stays held until the operator decides.
 */
export async function winnerDispute(auction: Auction, now: number, input: { delivery_key?: unknown; reason?: unknown }): Promise<string | null> {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (d.dispute) return "a dispute is already open";
  if (!d.handover) return "nothing has been handed over yet";
  if (now > (d.dispute_by ?? 0)) return "the time to complain has passed";

  if (d.kind === "digital") {
    const winner = auction.bids.find((b) => b.id === auction.outcome!.winner_bid_id);
    const lot = await loadLot(auction.id);
    if (!winner?.delivery_pub || !d.lot || !lot || !d.handover.envelope) return "this delivery can't be checked";
    if (typeof input.delivery_key !== "string") return "the delivery key is needed to check a digital lot";
    const verdict = await judgeDigitalDelivery({
      auctionId: auction.id,
      envelope: d.handover.envelope,
      deliveryKey: input.delivery_key,
      deliveryPublic: winner.delivery_pub,
      keyHash: d.lot.key_hash,
      lot,
    });
    if (verdict === "not-your-key") return "that is not this bid's delivery key";
    d.dispute = { at: now, verdict };
    d.resolution =
      verdict === "seller-cheated" ? { decision: "refund", reason: "wrong-key", at: now } : { decision: "release", reason: "key-was-right", at: now };
    return null;
  }

  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 10 || reason.length > LIMITS.disputeReasonMax) return `please say what is wrong, in 10 to ${LIMITS.disputeReasonMax} characters`;
  d.dispute = { at: now, reason };
  return null;
}

/** The operator decides a dispute over a physical lot. */
export function operatorResolve(auction: Auction, now: number, decision: unknown): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (!d.dispute || d.kind !== "physical") return "there is no dispute to decide";
  if (decision !== "release" && decision !== "refund") return "the decision must be release or refund";
  d.resolution = { decision, reason: "operator", at: now };
  return null;
}

export type DeliveryStage =
  | "not-started"
  | "awaiting-address" // physical: the winner hasn't said where to send it
  | "awaiting-handover" // the seller's turn
  | "awaiting-confirmation" // handed over; the winner can confirm or complain
  | "disputed" // physical: waiting for the operator
  | "released" // the seller is paid
  | "refunded"; // the winner got the price back

export function deliveryStage(auction: Auction): DeliveryStage {
  const d = auction.delivery!;
  if (d.resolution) return d.resolution.decision === "release" ? "released" : "refunded";
  if (!d.started_at) return "not-started";
  if (d.dispute) return "disputed";
  if (d.handover) return "awaiting-confirmation";
  if (d.kind === "physical" && !d.shipping) return "awaiting-address";
  return "awaiting-handover";
}
