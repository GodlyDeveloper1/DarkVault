// Start a practice auction. Anyone can, when none is running and the house
// purse has deposits ready. If one is already open, its id comes back.
import { bad, clientKey, limited, ok, tooMany } from "@/lib/http";
import { startPracticeAuction } from "@/lib/house/auctions";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const wait = limited("practice-start", clientKey(req), 6, 3600_000);
  if (wait) return tooMany(wait, "practice auctions");
  try {
    const result = await startPracticeAuction();
    if ("error" in result) return bad(result.error, 409);
    return ok({ id: result.id }, 201);
  } catch {
    return bad("A practice auction could not be started right now. Try again in a minute.", 503);
  }
}
