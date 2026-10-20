// The encrypted digital lot, for the winner. It is ciphertext: without the lot
// key, which the seller's browser seals to the winner, it says nothing.
//
// In a batch sale each winner is given the lot of the unit they won, and no other.
//
// The first time the winner's browser fetches it after the key was handed over
// is recorded: from then they have a short time to say it is not what was
// described (lib/delivery.ts, digitalComplainBy).
import { lotOpened } from "@/lib/delivery";
import { unitWonBy } from "@/lib/engine";
import { bad, matches, noStore } from "@/lib/http";
import { loadAuction, loadLot, loadUnitLot, withAuction, withUnit } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; bid: string }> }) {
  const { id, bid: bidId } = await params;
  const auction = await loadAuction(id);
  const bid = auction?.bids.find((b) => b.id === bidId);
  if (!auction || !bid || !matches(req.headers.get("x-bid-token"), bid.token_hash)) return bad("not found", 404);
  const unit = unitWonBy(auction, bid.id);
  if (auction.batch ? !unit : auction.outcome?.winner_bid_id !== bid.id) return bad("not found", 404);
  const lot = unit ? await loadUnitLot(id, unit.index) : auction.delivery?.lot ? await loadLot(id) : null;
  if (!lot) return bad("not found", 404);
  if (unit) await withUnit(unit.id, (u) => lotOpened(u, Date.now()));
  else await withAuction(id, (a) => lotOpened(a, Date.now()));
  return new Response(lot.buffer.slice(lot.byteOffset, lot.byteOffset + lot.byteLength) as ArrayBuffer, {
    headers: { ...noStore, "Content-Type": "application/octet-stream", "X-Content-Type-Options": "nosniff" },
  });
}
