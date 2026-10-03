// The operator decides a dispute over a physical lot.
import { advance } from "@/lib/engine";
import { operatorResolve } from "@/lib/delivery";
import { bad, ok, readJson } from "@/lib/http";
import { isOperator } from "@/lib/operator";
import { withAuction } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isOperator(req)) return bad("not found", 404);
  const { id } = await params;
  const body = await readJson(req);
  if (!body) return bad("invalid request");
  const result = await withAuction(id, (auction) => ({ error: operatorResolve(auction, Date.now(), body.decision) }));
  if (!result) return bad("not found", 404);
  if (result.error) return bad(result.error);
  await advance(id, true);
  return ok({ decided: body.decision });
}
