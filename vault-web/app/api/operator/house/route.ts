// For whoever runs the site: what the house purse holds (GET), and a fresh
// address to top it up at (POST).
import { bad, ok } from "@/lib/http";
import { practiceStatus } from "@/lib/house/auctions";
import { HOUSE } from "@/lib/house/config";
import { purseStatus, treasuryAddress, withPurse } from "@/lib/house/purse";
import { isOperator } from "@/lib/operator";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isOperator(req)) return bad("not found", 404);
  if (!HOUSE.enabled) return ok({ enabled: false, hint: "Set HOUSE_SIGNER_URL to the house signer (a second signer with its own data folder) and restart the web app." });
  return ok({ enabled: true, purse: await purseStatus(), practice: await practiceStatus() });
}

export async function POST(req: Request) {
  if (!isOperator(req)) return bad("not found", 404);
  if (!HOUSE.enabled) return bad("this site has no house purse", 409);
  try {
    return ok({ address: await withPurse((purse) => treasuryAddress(purse)) });
  } catch {
    return bad("the house signer isn't reachable", 503);
  }
}
