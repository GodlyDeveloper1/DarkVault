// Open disputes, for the operator: what the winner says, what the seller
// answers, and what is at stake. A disputed unit of a batch sale is listed
// like any sold lot, under its own id.
import { decideBy, disputedListing } from "@/lib/delivery";
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
        /** Which market: an auction, a deal (Settlement), or one unit of an Order Flow sale. */
        market: a.unit_of ? "order-flow" : a.deal ? "settlement" : "auction",
        sale_id: a.unit_of?.parent ?? null,
        /** Evidence photos: /api/operator/disputes/<id>/evidence/<winner|seller>/<n> */
        evidence: { winner: a.delivery!.dispute!.evidence?.winner ?? 0, seller: a.delivery!.dispute!.evidence?.seller ?? 0 },
        /** The site's requests for proof, and what each side sent back. A request unanswered by its deadline loses that side the dispute. */
        requests: (a.delivery!.dispute!.requests ?? []).map((r) => ({ side: r.side, at: r.at, due: r.due, text: r.text, answer: r.answer ?? null })),
        /** A return under way (the buyer won and is sending it back): where it stands. */
        return: a.delivery!.return
          ? {
              at: a.delivery!.return.at,
              address_by: a.delivery!.return.address_by,
              address_at: a.delivery!.return.address?.at ?? null,
              send_by: a.delivery!.return.send_by ?? null,
              sent_at: a.delivery!.return.sent?.at ?? null,
              confirm_by: a.delivery!.return.confirm_by ?? null,
              problem: a.delivery!.return.problem?.text ?? null,
            }
          : null,
        /** Undecided by then, it ends with everyone's own money going back. */
        decide_by: decideBy(a.delivery!.dispute!),
      };
    }),
  );
  return ok({ disputes: open });
}
