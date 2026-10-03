// What the winner does during delivery: send shipping details (sealed to the
// seller), confirm they have the lot, or complain.
import { advance } from "@/lib/engine";
import { validEnvelope, winnerConfirm, winnerDispute, winnerShipping } from "@/lib/delivery";
import { bad, clientKey, limited, matches, ok, readJson, tooMany } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { withAuction } from "@/lib/store";
import { bidView, infosFor } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; bid: string }> }) {
  const wait = limited("delivery", clientKey(req), 60, 3600_000);
  if (wait) return tooMany(wait, "delivery requests");
  const { id, bid: bidId } = await params;
  const body = await readJson(req, LIMITS.envelopeMax + 2000);
  if (!body) return bad("invalid request");
  const token = req.headers.get("x-bid-token");

  const result = await withAuction(id, async (auction): Promise<{ error: string | null }> => {
    const bid = auction.bids.find((b) => b.id === bidId);
    // The same answer whether the auction, the bid or the token is wrong, or the bid didn't win.
    if (!bid || !matches(token, bid.token_hash) || auction.outcome?.winner_bid_id !== bid.id) return { error: "not found" };
    const now = Date.now();
    if (body.action === "shipping") return { error: validEnvelope(body.envelope) ? winnerShipping(auction, now, body.envelope) : "invalid shipping details" };
    if (body.action === "confirm") return { error: winnerConfirm(auction, now) };
    if (body.action === "dispute") return { error: await winnerDispute(auction, now, { delivery_key: body.delivery_key, reason: body.reason }) };
    return { error: "unknown action" };
  });
  if (!result || result.error === "not found") return bad("not found", 404);
  if (result.error) return bad(result.error);
  const auction = await advance(id, true); // pay at once if this decided it
  const bid = auction?.bids.find((b) => b.id === bidId);
  if (!auction || !bid) return bad("not found", 404);
  return ok({ bid: bidView(auction, bid, await infosFor(auction)) });
}
