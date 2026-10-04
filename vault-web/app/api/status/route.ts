// Is the signer reachable, and how far has it scanned? For the status line.
import { ok } from "@/lib/http";
import { HOUSE } from "@/lib/house/config";
import { LIMITS } from "@/lib/limits";
import { usingTestBeacon } from "@/lib/drand";
import { chainStatus } from "@/lib/signer";
import { sitePublic } from "@/lib/sitekey";

export const dynamic = "force-dynamic";

export async function GET() {
  const site = {
    bond_percent: LIMITS.bondPercent,
    max_ceiling_multiple: LIMITS.maxCeilingMultiple,
    /** The key receipts are signed with. */
    site_key: await sitePublic(),
    /** "test" means bids are not really locked in time: for tests only. */
    beacon: usingTestBeacon() ? "test" : "public",
    /** Whether the site runs practice auctions and hands out practice wallets. */
    practice: HOUSE.enabled,
  };
  try {
    const s = await chainStatus();
    return ok({ online: true, chain_tip: s.chain_tip, scanned_height: s.scanned_height, ...site });
  } catch {
    return ok({ online: false, ...site });
  }
}
