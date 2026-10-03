// One auction, as anyone may see it. Looking at an auction also moves it forward.
import { advance } from "@/lib/engine";
import { bad, ok } from "@/lib/http";
import { infosFor, publicView } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auction = await advance(id);
  if (!auction) return bad("not found", 404);
  return ok({ auction: publicView(auction, await infosFor(auction)), now: Date.now() });
}
