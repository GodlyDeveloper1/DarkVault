// The operator asks one side of a dispute for (more) proof, with a deadline.
// That side sees it as a request from the site; silence loses the dispute.
import { operatorAsk } from "@/lib/delivery";
import { bad, ok, readJson } from "@/lib/http";
import { isOperator } from "@/lib/operator";
import { loadRecord, withAuction, withUnit } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isOperator(req)) return bad("not found", 404);
  const { id } = await params;
  const body = await readJson(req);
  if (!body) return bad("invalid request");
  const unit = !!(await loadRecord(id))?.unit_of;
  const result = await (unit ? withUnit : withAuction)(id, (auction) => ({ error: operatorAsk(auction, Date.now(), body.side, body.text) }));
  if (!result) return bad("not found", 404);
  if (result.error) return bad(result.error);
  return ok({ asked: body.side });
}
