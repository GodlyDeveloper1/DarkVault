// The seller hands over: the lot key sealed to the winner (digital), or
// "shipped", with an optional sealed note (physical). Or, with `reply`,
// answers a complaint for the operator to read.
import { advance } from "@/lib/engine";
import { sellerHandover, sellerReply, validEnvelope } from "@/lib/delivery";
import { bad, clientKey, limited, matches, ok, readJson, tooMany } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { withAuction } from "@/lib/store";
import { infosFor, sellerView } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const wait = limited("delivery", clientKey(req), 60, 3600_000);
  if (wait) return tooMany(wait, "delivery requests");
  const { id } = await params;
  const body = await readJson(req, LIMITS.envelopeMax + 2000);
  if (!body) return bad("invalid request");
  const key = req.headers.get("x-manage-key");

  const result = await withAuction(id, (auction): { error: string | null } => {
    if (!matches(key, auction.seller.key_hash)) return { error: "not found" };
    if (body.reply !== undefined) return { error: sellerReply(auction, Date.now(), body.reply) };
    if (body.envelope !== undefined && !validEnvelope(body.envelope)) return { error: "invalid envelope" };
    return { error: sellerHandover(auction, Date.now(), body.envelope as string | undefined) };
  });
  if (!result || result.error === "not found") return bad("not found", 404);
  if (result.error) return bad(result.error);
  const auction = await advance(id, true);
  if (!auction) return bad("not found", 404);
  return ok({ seller: sellerView(auction, await infosFor(auction)) });
}
