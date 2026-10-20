// The seller hands over: the lot key sealed to the winner (digital), or
// "shipped", with an optional sealed note (physical). Or, during a dispute:
// `reply` answers the complaint, `proof` answers the site's request for proof,
// `evidence` adds a photo to it.
//
// In a batch sale (Order Flow) the seller does this once per unit that sold,
// and says which with `unit` (1 is the first).
import { advance, advanceUnit, unitId } from "@/lib/engine";
import { addEvidence, answerProof, sellerHandover, sellerReply, sellerReturnAddress, sellerReturnProblem, sellerReturnReceived, validEnvelope } from "@/lib/delivery";
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
  // Room for one evidence photo (300 KB, base64) or an envelope.
  const body = await readJson(req, 420_000);
  if (!body) return bad("invalid request");
  const key = req.headers.get("x-manage-key");

  const act = async (auction: Auction): Promise<{ error: string | null }> => {
    if (!matches(key, auction.seller.key_hash)) return { error: "not found" };
    if (body.reply !== undefined) return { error: sellerReply(auction, Date.now(), body.reply) };
    if (body.proof !== undefined) return { error: answerProof(auction, "seller", Date.now(), body.proof) };
    // A return: where to send it (sealed to the buyer), "it is back", or "what came back is wrong".
    if (body.return_address !== undefined) return { error: validEnvelope(body.return_address) ? sellerReturnAddress(auction, Date.now(), body.return_address) : "invalid return address" };
    if (body.return_received === true) return { error: sellerReturnReceived(auction, Date.now()) };
    if (body.return_problem !== undefined) return { error: sellerReturnProblem(auction, Date.now(), body.return_problem) };
    if (body.evidence !== undefined) return { error: await addEvidence(auction, "seller", body.evidence) };
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
