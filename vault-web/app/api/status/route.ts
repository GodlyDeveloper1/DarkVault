// Is the signer reachable, and how far has it scanned? For the status line.
import { ok } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { chainStatus } from "@/lib/signer";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const s = await chainStatus();
    return ok({ online: true, chain_tip: s.chain_tip, scanned_height: s.scanned_height, bond_percent: LIMITS.bondPercent });
  } catch {
    return ok({ online: false, bond_percent: LIMITS.bondPercent });
  }
}
