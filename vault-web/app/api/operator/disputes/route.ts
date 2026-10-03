// Open disputes over physical lots, for the operator.
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
      shipped_at: a.delivery!.handover?.at ?? null,
      disputed_at: a.delivery!.dispute!.at,
      reason: a.delivery!.dispute!.reason ?? null,
    }));
  return ok({ disputes: open });
}
