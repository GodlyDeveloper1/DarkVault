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
import { cleanJpeg, decryptListingWithKey, decryptLot, fromBase64, judgeDigitalDelivery, lotKeyHash, type Fault, type ListingText, type LotHeader } from "vault-core";
import { LIMITS } from "./limits";
import { lotOf, saveEvidence, type Side } from "./store";
import type { Auction, Delivery, ProofRequest } from "./types";

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
  d.dispute_by = now + complaintSeconds(d) * 1000;
  return null;
}

/**
 * How long the winner has to confirm or complain after the handover. A
 * physical parcel takes days to arrive, so it is never less than the site's
 * minimum for physical lots, whatever the seller chose; otherwise a seller
 * could mark it shipped at once and be paid before the box is opened.
 */
export function complaintSeconds(d: Delivery): number {
  return d.kind === "physical" ? Math.max(d.dispute_seconds, LIMITS.minPhysicalComplaintSec) : d.dispute_seconds;
}

/**
 * Physical: "it hasn't arrived yet". Once, before the time to complain runs
 * out, it adds a few days (LIMITS.extendSec). Fixed and short, so a buyer
 * can't use it to hold the seller's money for weeks.
 */
export function winnerExtend(auction: Auction, now: number): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (d.kind !== "physical") return "only a parcel's time can be extended";
  if (!d.handover) return "the seller hasn't marked it shipped yet";
  if (d.dispute) return "a dispute is open";
  if (d.extended_at) return "the time has already been extended once";
  if (now > (d.dispute_by ?? 0)) return "the time to complain has passed";
  d.extended_at = now;
  d.dispute_by = (d.dispute_by ?? now) + LIMITS.extendSec * 1000;
  return null;
}

/** The keys the winner handed over were for deciding the dispute. Once it is decided they are not kept. */
function forgetKeys(d: Delivery): void {
  if (!d.dispute) return;
  delete d.dispute.lot_key;
  delete d.dispute.listing_key;
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
  const open = openRequest(d, "seller");
  if (open) open.answer = { at: now, text: reply };
  return null;
}

// --- requests for proof --------------------------------------------------------
//
// One side wins the whole dispute; the other loses it, and with it their bond.
// What decides it is proof. When a dispute opens the site asks both sides for
// theirs, with a deadline, and the operator can ask again. The request comes
// from "the site": neither side is told a person reads it. A side that sends
// nothing by the deadline loses (engine: dueResolution).

const ASK: Record<Delivery["kind"], Record<ProofRequest["side"], string>> = {
  physical: {
    winner:
      "Show what is wrong: photos of the parcel and of what arrived. If nothing arrived, say so, and add anything that shows it, such as the tracking page. Cover any name or address first.",
    seller:
      "Show that you sent it: the receipt of posting or the tracking page, and photos of the item before you packed it. Cover any name or address first.",
  },
  digital: {
    winner:
      "Show what is wrong, in order: what you were sent, what you did with it, and the error you got (for a product key, the activation screen with its error code). Cover any name first.",
    seller:
      "Show that what you delivered was genuine and unused: the receipt from where you got it, for example. Cover any name first.",
  },
  promise: {
    winner: "Show what was not done as promised: screenshots or photos, and a short note.",
    seller: "Show that it was done as promised: screenshots or photos, and a short note.",
  },
};

/** When an undecided dispute ends by itself, everyone's own money going back. */
export function decideBy(dispute: NonNullable<Delivery["dispute"]>): number | null {
  if (dispute.kind === "wrong-key") return null;
  return dispute.decide_by ?? dispute.at + LIMITS.disputeDecideSec * 1000;
}

/**
 * Who has lost by saying nothing: the side whose request for proof ran out
 * first without an answer. Both silent: nobody wins, and everyone's own money
 * goes back (null side, "both").
 */
export function silentSide(dispute: NonNullable<Delivery["dispute"]>, now: number): ProofRequest["side"] | "both" | null {
  const missed = (dispute.requests ?? []).filter((r) => !r.answer && now > r.due);
  if (missed.length === 0) return null;
  const sides = new Set(missed.map((r) => r.side));
  if (sides.size === 2) return "both";
  return missed[0]!.side;
}

/** The request to this side that is still waiting for an answer, if any. */
export function openRequest(d: Delivery, side: ProofRequest["side"]): ProofRequest | undefined {
  return d.dispute?.requests?.find((r) => r.side === side && !r.answer);
}

function ask(d: Delivery, side: ProofRequest["side"], now: number, text: string): void {
  const dispute = d.dispute!;
  const due = now + LIMITS.proofSec * 1000;
  (dispute.requests ??= []).push({ side, at: now, due, text });
  // Time to read the answer before the dispute times out.
  dispute.decide_by = Math.max(dispute.decide_by ?? dispute.at + LIMITS.disputeDecideSec * 1000, due + 24 * 3600_000);
}

/** When a dispute opens: the site asks both sides for proof. */
function askBoth(d: Delivery, now: number): void {
  d.dispute!.decide_by = now + LIMITS.disputeDecideSec * 1000;
  ask(d, "winner", now, ASK[d.kind].winner);
  ask(d, "seller", now, ASK[d.kind].seller);
}

/** The operator asks one side for (more) proof. Shown to that side as a request from the site. */
export function operatorAsk(auction: Auction, now: number, side: unknown, text: unknown): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (!d.dispute || d.dispute.kind === "wrong-key") return "there is no dispute to ask about";
  if (side !== "winner" && side !== "seller") return "ask the winner or the seller";
  if (d.return && !d.return.problem) return "a return is under way: its own deadlines decide it";
  const said = typeof text === "string" ? text.trim() : "";
  if (said.length < 10 || said.length > LIMITS.proofTextMax) return `say what you need in 10 to ${LIMITS.proofTextMax} characters`;
  if (openRequest(d, side)) return "that side has not answered the last request yet";
  ask(d, side, now, said);
  return null;
}

/** One side answers the site's request: a note (their photos are added beside it). */
export function answerProof(auction: Auction, side: ProofRequest["side"], now: number, text: unknown): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  const open = openRequest(d, side);
  if (!open) return "there is no request for proof waiting for you";
  if (now > open.due) return "the time to answer has passed";
  const said = typeof text === "string" ? text.trim() : "";
  if (said.length < 10 || said.length > LIMITS.proofTextMax) return `please write 10 to ${LIMITS.proofTextMax} characters`;
  open.answer = { at: now, text: said };
  // The seller's first answer is also their reply to the complaint, which the winner sees.
  if (side === "seller" && !d.dispute!.seller_reply) d.dispute!.seller_reply = { at: now, text: said };
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
    if (typeof input.listing_key !== "string" || !/^[0-9a-f]{64}$/.test(input.listing_key)) return "the key to this private listing is needed, so the site can read what was described";
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
    askBoth(d, now);
    return null;
  }

  const winner = auction.bids.find((b) => b.id === auction.outcome!.winner_bid_id);
  const lot = await lotOf(auction);
  if (!winner?.delivery_pub || !d.lot || !lot || !d.handover.envelope) return "this delivery can't be checked";

  if (typeof input.lot_key === "string") {
    // "Not as described": only someone who really opened the lot can say so,
    // and soon after: an honest buyer checks a key or a file at once.
    if (reasonProblem) return reasonProblem;
    const by = digitalComplainBy(d);
    if (by !== null && now > by) return `the ${Math.round(LIMITS.digitalComplaintSec / 3600)} hours to say it is not what was described have passed`;
    if (!/^[0-9a-f]{64}$/.test(input.lot_key)) return "that is not a lot key";
    const key = unhex(input.lot_key);
    try {
      if ((await lotKeyHash(key)) !== d.lot.key_hash) return "that key is not this lot's key";
      await decryptLot(key, lot);
    } catch {
      return "that key does not open the lot. Ask for your payment back instead.";
    }
    d.dispute = { at: now, kind: "not-as-described", reason, lot_key: input.lot_key, ...listing };
    askBoth(d, now);
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
 * The operator decides a dispute. One side wins it all:
 *   "release": the seller wins. They are paid, and the winner's bond goes to them.
 *   "refund":  the winner wins. Their payment comes back, with the seller's bond.
 *   "lost":    a parcel lost, damaged or held in the post. Nobody lied: the
 *              payment comes back and each bond goes back to its owner.
 *   "return":  the winner wins a dispute over a posted item, but sends it back
 *              first. The refund (with the seller's bond) follows the return.
 * There are no splits and no "nobody at fault" for anything else.
 */
export function operatorResolve(auction: Auction, now: number, decision: unknown): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (!d.dispute || d.dispute.kind === "wrong-key") return "there is no dispute to decide";
  if (decision === "return") {
    if (d.kind !== "physical") return "only a posted item can be sent back";
    if (d.return) return "a return is already under way";
    d.return = { at: now, address_by: now + LIMITS.returnAddressSec * 1000 };
    // Requests for proof still waiting are over: the dispute is decided, only the return is left.
    d.dispute.requests = (d.dispute.requests ?? []).filter((r) => r.answer);
    return null;
  }
  if (decision === "lost") {
    if (d.kind !== "physical") return "only a parcel can be lost in the post";
    d.resolution = { decision: "refund", reason: "lost-in-post", fault: "none", at: now };
  } else if (decision === "release" || decision === "refund") {
    d.resolution = { decision, reason: "operator", fault: decision === "release" ? "winner" : "seller", at: now };
  } else return "the decision must be release (the seller wins), refund (the buyer wins), return or lost";
  forgetKeys(d);
  return null;
}

// --- a return --------------------------------------------------------------
//
// The buyer won a dispute over a posted item and sends it back before the
// refund. The seller's return address is sealed to the buyer; the buyer's note
// (a tracking number) is sealed to the seller. The site passes them on and
// can't read either. The deadlines are in dueResolution (engine.ts).

function returning(auction: Auction): { d: Delivery; r: NonNullable<Delivery["return"]> } | string {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (!d.return) return "there is no return under way";
  if (d.return.problem) return "the return is with the site now";
  return { d, r: d.return };
}

/** The seller says where the item should come back to, sealed to the buyer. */
export function sellerReturnAddress(auction: Auction, now: number, envelope: string): string | null {
  const x = returning(auction);
  if (typeof x === "string") return x;
  if (x.r.address) return "you have already sent your return address";
  if (now > x.r.address_by) return "the time to send a return address has passed";
  x.r.address = { at: now, envelope };
  x.r.send_by = now + LIMITS.returnSendSec * 1000;
  return null;
}

/** The buyer has posted it back, with an optional sealed note for the seller. */
export function winnerReturned(auction: Auction, now: number, envelope: string | undefined): string | null {
  const x = returning(auction);
  if (typeof x === "string") return x;
  if (!x.r.address) return "the seller has not sent a return address yet";
  if (x.r.sent) return "already marked as posted back";
  if (now > (x.r.send_by ?? 0)) return "the time to post it back has passed";
  x.r.sent = envelope ? { at: now, envelope } : { at: now };
  x.r.confirm_by = now + LIMITS.returnConfirmSec * 1000;
  return null;
}

/** The seller has it back: the buyer is refunded, with the seller's bond. */
export function sellerReturnReceived(auction: Auction, now: number): string | null {
  const x = returning(auction);
  if (typeof x === "string") return x;
  if (!x.r.sent) return "the buyer has not posted it back yet";
  x.d.resolution = { decision: "refund", reason: "returned", fault: "seller", at: now };
  forgetKeys(x.d);
  return null;
}

/** The seller says what came back is not what they sent. The site asks both sides for proof, as at the start. */
export function sellerReturnProblem(auction: Auction, now: number, text: unknown): string | null {
  const x = returning(auction);
  if (typeof x === "string") return x;
  if (!x.r.sent) return "the buyer has not posted it back yet";
  if (now > (x.r.confirm_by ?? 0)) return "the time to report a problem has passed";
  const said = typeof text === "string" ? text.trim() : "";
  if (said.length < 10 || said.length > LIMITS.proofTextMax) return `please say what is wrong in 10 to ${LIMITS.proofTextMax} characters`;
  x.r.problem = { at: now, text: said };
  x.d.dispute!.decide_by = now + LIMITS.disputeDecideSec * 1000;
  ask(x.d, "seller", now, "Show what came back and how it differs from what you sent: photos of it, and your photos from before you posted it. Cover any name or address first.");
  ask(x.d, "winner", now, "The seller says what came back is not what they sent. Show what you posted back: the receipt of posting, the tracking, and photos of the item and its packing. Cover any name or address first.");
  return null;
}

/** A practice auction's dispute is not argued: the sale is undone, nobody at fault. Only the house calls this. */
export function undoPractice(auction: Auction, now: number): string | null {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (!auction.house) return "not a practice auction";
  d.resolution = { decision: "refund", reason: "operator", fault: "none", at: now };
  forgetKeys(d);
  return null;
}

/** Digital: the time limit to say a lot is not as described, once the winner has been able to read it. Null until then. */
export function digitalComplainBy(d: Delivery): number | null {
  if (d.kind !== "digital" || !d.lot_opened_at) return null;
  return Math.min(d.dispute_by ?? Infinity, d.lot_opened_at + LIMITS.digitalComplaintSec * 1000);
}

/** The winner's browser has fetched the encrypted lot: from now on they can read it. Recorded once. */
export function lotOpened(auction: Auction, now: number): void {
  const d = auction.delivery;
  if (d?.kind === "digital" && d.handover && !d.lot_opened_at && !d.resolution) d.lot_opened_at = now;
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

/**
 * A photo for the operator, from either side of an open dispute: what
 * arrived, the packaging, a receipt of posting. Cleaned in the browser like a
 * listing photo (no location, device or time) and checked again here. Seen
 * only by the operator; deleted once the dispute's payout is made.
 */
export async function addEvidence(auction: Auction, side: Side, photo: unknown): Promise<string | null> {
  const d = inProgress(auction);
  if (typeof d === "string") return d;
  if (!d.dispute || d.dispute.kind === "wrong-key") return "there is no dispute to add a photo to";
  const count = d.dispute.evidence?.[side] ?? 0;
  if (count >= LIMITS.maxEvidencePhotos) return `you can add at most ${LIMITS.maxEvidencePhotos} photos`;
  let bytes: Uint8Array;
  try {
    bytes = typeof photo === "string" ? fromBase64(photo) : new Uint8Array();
  } catch {
    return "the photo is not readable";
  }
  if (!cleanJpeg(bytes)) return "the photo must be a cleaned JPEG of at most 300 KB; add it again from this page";
  await saveEvidence(auction.id, side, count, bytes);
  d.dispute.evidence = { winner: d.dispute.evidence?.winner ?? 0, seller: d.dispute.evidence?.seller ?? 0, [side]: count + 1 };
  return null;
}
