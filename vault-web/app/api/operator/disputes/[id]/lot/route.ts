// For the operator: the lot that was delivered in a disputed digital sale,
// opened with the key the winner handed over when they complained. Text comes
// back as JSON; a file comes back as a download.
import { disputedLot } from "@/lib/delivery";
import { bad, noStore, ok } from "@/lib/http";
import { isOperator } from "@/lib/operator";
import { loadAuction } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isOperator(req)) return bad("not found", 404);
  const { id } = await params;
  const auction = await loadAuction(id);
  const lot = auction ? await disputedLot(auction) : null;
  if (!lot) return bad("not found", 404);
  if (lot.header.kind === "text") return ok({ kind: "text", text: new TextDecoder().decode(lot.content) });
  const name = (lot.header.name ?? "lot").replace(/[^\w.\- ]/g, "_").slice(0, 120);
  return new Response(lot.content.buffer.slice(lot.content.byteOffset, lot.content.byteOffset + lot.content.byteLength) as ArrayBuffer, {
    headers: { ...noStore, "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${name}"`, "X-Content-Type-Options": "nosniff" },
  });
}
