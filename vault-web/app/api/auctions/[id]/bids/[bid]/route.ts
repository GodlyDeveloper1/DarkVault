// One bid, as its bidder may see it. The bidder proves who they are with a
// token derived from the nonce only they hold.
import { advance } from "@/lib/engine";
import { bad, matches, ok } from "@/lib/http";
import { bidView, infosFor } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; bid: string }> }) {
  const { id, bid: bidId } = await params;
  const auction = await advance(id);
  const bid = auction?.bids.find((b) => b.id === bidId);
  // The same answer whether the auction, the bid or the token is wrong.
  if (!auction || !bid || !matches(req.headers.get("x-bid-token"), bid.token_hash)) return bad("not found", 404);
  return ok({ bid: bidView(auction, bid, await infosFor(auction)) });
}
