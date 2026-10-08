// Open disputes, for the operator: what the winner says, what the seller
// answers, and what is at stake. A disputed unit of a batch sale is listed
// like any sold lot, under its own id.
import { disputedListing } from "@/lib/delivery";
import { bad, ok } from "@/lib/http";
import { isOperator } from "@/lib/operator";
import { listRecords } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isOperator(req)) return bad("not found", 404);
  const disputed = (await listRecords()).filter((a) => a.state === "delivering" && a.delivery?.dispute && !a.delivery.resolution);
  const open = await Promise.all(
    disputed.map(async (a) => {
      // A private auction's listing is encrypted. The operator reads it only
      // through the key the winner handed over when they complained.
      const listing = await disputedListing(a);
      return {
        id: a.id,
        private: !!a.private,
        title: listing?.title ?? a.title,
        price: a.outcome?.price ?? null,
        description: listing?.description ?? a.description,
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
      };
    }),
  );
  return ok({ disputes: open });
}
