// The seller hands over: the lot key sealed to the winner (digital), or
// "shipped", with an optional sealed note (physical). Or, with `reply`,
// answers a complaint for the operator to read.
//
// In a batch sale (Order Flow) the seller does this once per unit that sold,
// and says which with `unit` (1 is the first).
import { advance, advanceUnit, unitId } from "@/lib/engine";
import { sellerHandover, sellerReply, validEnvelope } from "@/lib/delivery";
import { bad, clientKey, limited, matches, ok, readJson, tooMany } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { loadAuction, withAuction, withUnit } from "@/lib/store";
import type { Auction } from "@/lib/types";
import { infosFor, sellerView } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const wait = limited("delivery", clientKey(req), 120, 3600_000);
  if (wait) return tooMany(wait, "delivery requests");
  const { id } = await params;
  const body = await readJson(req, LIMITS.envelopeMax + 2000);
  if (!body) return bad("invalid request");
  const key = req.headers.get("x-manage-key");

  const act = (auction: Auction): { error: string | null } => {
    if (!matches(key, auction.seller.key_hash)) return { error: "not found" };
    if (body.reply !== undefined) return { error: sellerReply(auction, Date.now(), body.reply) };
    if (body.envelope !== undefined && !validEnvelope(body.envelope)) return { error: "invalid envelope" };
    return { error: sellerHandover(auction, Date.now(), body.envelope as string | undefined) };
  };

  // A batch sale: the same steps, on the record of the unit named.
  const known = await loadAuction(id);
  const sale = known?.batch && matches(key, known.seller.key_hash) ? known : null;
  let unit: string | null = null;
  if (known?.batch) {
    if (!sale) return bad("not found", 404);
    const n = body.unit;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > (sale.outcome?.winners?.length ?? 0)) return bad("say which unit: that one did not sell");
    unit = unitId(sale, n - 1);
  }
  const result = unit ? await withUnit(unit, act) : await withAuction(id, act);
  if (!result || result.error === "not found") return bad(unit ? "that unit is not ready yet; try again in a moment" : "not found", unit ? 409 : 404);
  if (result.error) return bad(result.error);
  if (unit) await advanceUnit(unit, true);
  const auction = await advance(id, true);
  if (!auction) return bad("not found", 404);
  return ok({ seller: sellerView(auction, await infosFor(auction, "all")) });
}
