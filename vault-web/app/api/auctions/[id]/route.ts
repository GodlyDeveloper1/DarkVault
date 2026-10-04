// One auction, as anyone may see it (a private one: anyone who holds its
// invite). Looking at an auction also moves it forward.
import { maySee } from "@/lib/access";
import { advance } from "@/lib/engine";
import { bad, ok } from "@/lib/http";
import { loadAuction } from "@/lib/store";
import { infosFor, publicView } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The same answer, and the same work, whether there is no such auction or it is private and the invite is missing.
  const known = await loadAuction(id);
  if (!known || !maySee(known, req)) return bad("not found", 404);
  const auction = await advance(id);
  if (!auction) return bad("not found", 404);
  return ok({ auction: publicView(auction, await infosFor(auction)), now: Date.now() });
}
