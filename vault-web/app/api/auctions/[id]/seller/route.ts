// The seller's view of their auction, shown to whoever holds the manage key.
import { advance } from "@/lib/engine";
import { bad, matches, ok } from "@/lib/http";
import { infosFor, sellerView } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auction = await advance(id);
  if (!auction || !matches(req.headers.get("x-manage-key"), auction.seller.key_hash)) return bad("not found", 404);
  return ok({ seller: sellerView(auction, await infosFor(auction)) });
}
