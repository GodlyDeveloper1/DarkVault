// Practice auctions and wallets: are they on, is one open, can one be started?
import { ok } from "@/lib/http";
import { practiceStatus } from "@/lib/house/auctions";

export const dynamic = "force-dynamic";

export async function GET() {
  return ok({ practice: await practiceStatus() });
}
