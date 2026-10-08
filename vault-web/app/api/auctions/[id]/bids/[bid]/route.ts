// One bid, as its bidder may see it. The bidder proves who they are with a
// token derived from the nonce only they hold.
import { advance, advanceUnit, unitWonBy } from "@/lib/engine";
import { bad, matches, ok } from "@/lib/http";
import { bidView, infosFor } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; bid: string }> }) {
  const { id, bid: bidId } = await params;
  const auction = await advance(id);
  const bid = auction?.bids.find((b) => b.id === bidId);
  // The same answer whether the auction, the bid or the token is wrong.
  if (!auction || !bid || !matches(req.headers.get("x-bid-token"), bid.token_hash)) return bad("not found", 404);
  // Order Flow: an order that won a unit is handed over on that unit's record. Looking moves it forward too.
  const unit = unitWonBy(auction, bid.id);
  if (unit) await advanceUnit(unit.id);
  return ok({ bid: bidView(auction, bid, await infosFor(auction, bid.id)) });
}
