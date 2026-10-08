// Place a sealed bid. The browser sends a commitment and the bid locked in
// time, never an amount it could read. The server answers with a deposit
// address made for this bid alone and a signed receipt.
//
// In a practice auction a bid can name a practice wallet in place of a refund
// address: its refund then goes back to the house purse, for that wallet.
import { maySee } from "@/lib/access";
import { placeBid, type Placed } from "@/lib/bids";
import { bad, clientKey, limited, ok, readJson, tooMany } from "@/lib/http";
import { HOUSE } from "@/lib/house/config";
import { attachBid, walletFor } from "@/lib/house/practice";
import { treasuryAddress, withPurse } from "@/lib/house/purse";
import { loadAuction } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A private auction takes bids only from browsers that hold its invite.
  const known = await loadAuction(id);
  if (!known || !maySee(known, req)) return bad("not found", 404);
  // Counted only now: a stranger posting to made-up ids must not use up the room for real bidders.
  const wait = limited("bid", clientKey(req), 20, 3600_000);
  if (wait) return tooMany(wait, "bids");
  const body = await readJson(req);
  if (!body) return bad("invalid request");
  const commitment = typeof body.commitment === "string" ? body.commitment : "";
  const tokenHash = typeof body.token_hash === "string" ? body.token_hash : "";
  const refund = typeof body.refund_address === "string" ? body.refund_address.trim() : "";
  if (!/^[0-9a-f]{64}$/.test(commitment)) return bad("invalid commitment");
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return bad("invalid token");
  const deliveryPub = body.delivery_pub;
  if (deliveryPub !== undefined && (typeof deliveryPub !== "string" || !/^[0-9a-f]{64}$/.test(deliveryPub))) return bad("invalid delivery key");

  const sealed = typeof body.sealed === "string" ? body.sealed : "";
  const rest = { commitment, tokenHash, sealed, ...(typeof deliveryPub === "string" ? { deliveryPub } : {}) };

  // A practice wallet in place of a refund address. Done under the purse's
  // lock, one bid at a time, so its limits can't be slipped past by sending
  // several bids at once.
  if (typeof body.practice === "string") {
    const token = body.practice;
    let result: Placed;
    try {
      result = await withPurse(async (purse): Promise<Placed> => {
        const auction = await loadAuction(id);
        const wallet = HOUSE.enabled ? await walletFor(token) : null;
        if (!wallet) return { error: "that practice wallet isn't known here; make a new one" };
        if (!auction?.house) return { error: "a practice wallet only works in practice auctions" };
        if (auction.bids.filter((b) => b.practice === wallet.id).length >= 2) return { error: "a practice wallet can place two bids in one practice auction" };
        if (wallet.bids.length >= 60) return { error: "this practice wallet has been used up; make a new one" };
        const placed = await placeBid(id, { ...rest, refund: await treasuryAddress(purse), practice: wallet.id });
        if (!("error" in placed)) await attachBid(wallet.id, id, placed.bid_id);
        return placed;
      });
    } catch {
      return bad("The house wallet can't be reached right now. Try again in a minute, or bid with your own wallet.", 503);
    }
    if ("error" in result) return bad(result.error, result.status ?? 400);
    return ok(result, 201);
  }

  if (refund.length < 20 || refund.length > 600) return bad("please give a shielded refund address");
  const result = await placeBid(id, { ...rest, refund });
  if ("error" in result) return bad(result.error, result.status ?? 400);
  return ok(result, 201);
}
