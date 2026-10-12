// For the operator only: one evidence photo a side added to a dispute.
import { isOperator } from "@/lib/operator";
import { loadEvidence } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; side: string; n: string }> }) {
  const notFound = () => new Response("not found", { status: 404 });
  if (!isOperator(req)) return notFound();
  const { id, side, n } = await params;
  const index = Number(n) - 1;
  if (!/^[0-9a-f]{32}$/.test(id) || (side !== "winner" && side !== "seller") || !Number.isInteger(index) || index < 0 || index > 9) return notFound();
  const bytes = await loadEvidence(id, side, index);
  if (!bytes) return notFound();
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } });
}
