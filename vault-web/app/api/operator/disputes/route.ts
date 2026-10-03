// Open disputes, for the operator: what the winner says, what the seller
// answers, and what is at stake.
import { bad, ok } from "@/lib/http";
import { isOperator } from "@/lib/operator";
import { listAuctions } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isOperator(req)) return bad("not found", 404);
  const open = (await listAuctions())
    .filter((a) => a.state === "delivering" && a.delivery?.dispute && !a.delivery.resolution)
    .map((a) => ({
      id: a.id,
      title: a.title,
      price: a.outcome?.price ?? null,
      description: a.description,
      lot: a.delivery!.kind,
      kind: a.delivery!.dispute!.kind,
      seller_bond: a.delivery!.seller_bond,
      buyer_bond: a.delivery!.buyer_bond,
      handed_over_at: a.delivery!.handover?.at ?? null,
      disputed_at: a.delivery!.dispute!.at,
      reason: a.delivery!.dispute!.reason ?? null,
      seller_reply: a.delivery!.dispute!.seller_reply?.text ?? null,
      /** Digital lots: the delivered lot can be opened at /api/operator/disputes/<id>/lot */
      lot_available: !!a.delivery!.dispute!.lot_key,
    }));
  return ok({ disputes: open });
}
