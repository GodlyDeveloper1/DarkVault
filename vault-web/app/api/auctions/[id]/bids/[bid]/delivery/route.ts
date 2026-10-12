// What the winner does during delivery: send shipping details (sealed to the
// seller), confirm they have the lot, or complain. Also: say a parcel hasn't
// arrived yet (once), accept the seller's offer, add evidence photos.
//
// In a batch sale (Order Flow) every winner does this for the unit they won.
// The request names the sale and the order, as always; which unit that is, is
// worked out here.
import { advance, advanceUnit, unitWonBy } from "@/lib/engine";
import { addEvidence, validEnvelope, winnerAcceptOffer, winnerConfirm, winnerDispute, winnerExtend, winnerShipping } from "@/lib/delivery";
import { bad, clientKey, limited, matches, ok, readJson, tooMany } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { loadAuction, withAuction, withUnit } from "@/lib/store";
import type { Auction } from "@/lib/types";
import { bidView, infosFor } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; bid: string }> }) {
  const wait = limited("delivery", clientKey(req), 60, 3600_000);
  if (wait) return tooMany(wait, "delivery requests");
  const { id, bid: bidId } = await params;
  // Room for one evidence photo (300 KB, base64) or an envelope.
  const body = await readJson(req, 420_000);
  if (!body) return bad("invalid request");
  const token = req.headers.get("x-bid-token");

  const act = async (auction: Auction): Promise<{ error: string | null }> => {
    const bid = auction.bids.find((b) => b.id === bidId);
    // The same answer whether the auction, the bid or the token is wrong, or the bid didn't win.
    if (!bid || !matches(token, bid.token_hash) || auction.outcome?.winner_bid_id !== bid.id) return { error: "not found" };
    const now = Date.now();
    if (body.action === "shipping") return { error: validEnvelope(body.envelope) ? winnerShipping(auction, now, body.envelope) : "invalid shipping details" };
    if (body.action === "confirm") return { error: winnerConfirm(auction, now) };
    if (body.action === "dispute") return { error: await winnerDispute(auction, now, { delivery_key: body.delivery_key, lot_key: body.lot_key, listing_key: body.listing_key, reason: body.reason }) };
    if (body.action === "extend") return { error: winnerExtend(auction, now) };
    if (body.action === "accept_offer") return { error: winnerAcceptOffer(auction, now, body.percent) };
    if (body.action === "evidence") return { error: await addEvidence(auction, "winner", body.photo) };
    return { error: "unknown action" };
  };

  // A batch sale: the same steps, on the record of the unit this order won.
  const known = await loadAuction(id);
  const sale = known?.batch ? known : null;
  const unit = sale ? unitWonBy(sale, bidId) : null;
  const mine = !!sale && !!sale.bids.find((b) => b.id === bidId && matches(token, b.token_hash));
  const result = sale ? (unit && mine ? await withUnit(unit.id, act) : null) : await withAuction(id, act);
  if (!result || result.error === "not found") return bad("not found", 404);
  if (result.error) return bad(result.error);
  if (unit) await advanceUnit(unit.id, true); // pay at once if this decided it
  const auction = await advance(id, true);
  const bid = auction?.bids.find((b) => b.id === bidId);
  if (!auction || !bid) return bad("not found", 404);
  return ok({ bid: bidView(auction, bid, await infosFor(auction, bid.id)) });
}
