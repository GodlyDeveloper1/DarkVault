// The result of an auction and the proof that it is right. Public.
//
// The statement lists every bid on the board (as commitments), which of them
// counted, the price and the winner's position. The proof opens the winning
// commitment to the price and shows every other counted bid was lower,
// without giving its amount. Anyone can check it: the auction page does, in
// the browser, and so can a script with vault-core's verifyFairness.
import { NextResponse } from "next/server";
import { maySee } from "@/lib/access";
import { advance } from "@/lib/engine";
import { bad } from "@/lib/http";
import { loadAuction, loadProof } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A private auction's result is for its invited bidders: without the invite, the same answer and the same work as for no auction.
  const known = await loadAuction(id);
  const auction = known && maySee(known, req) ? await advance(id) : null;
  // Served only once the auction record says the result stands.
  const text = auction?.proof ? await loadProof(id) : null;
  if (!text) return bad("not found", 404);
  return new NextResponse(text, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
