// The operator decides a dispute: "release" pays the seller, "refund" returns
// the price to the winner. The side that lost also loses its bond to the
// other, unless no_fault is set.
import { advance, advanceUnit } from "@/lib/engine";
import { operatorResolve } from "@/lib/delivery";
import { bad, ok, readJson } from "@/lib/http";
import { isOperator } from "@/lib/operator";
import { loadRecord, withAuction, withUnit } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isOperator(req)) return bad("not found", 404);
  const { id } = await params;
  const body = await readJson(req);
  if (!body) return bad("invalid request");
  // The record in dispute may be one sold unit of a batch sale. Only the operator ever names one by id.
  const unit = !!(await loadRecord(id))?.unit_of;
  const result = await (unit ? withUnit : withAuction)(id, (auction) => ({ error: operatorResolve(auction, Date.now(), body.decision, body.no_fault) }));
  if (!result) return bad("not found", 404);
  if (result.error) return bad(result.error);
  await (unit ? advanceUnit : advance)(id, true);
  return ok({ decided: body.decision, no_fault: body.no_fault === true });
}
