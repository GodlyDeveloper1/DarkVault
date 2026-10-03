// Place a sealed bid. The browser sends a commitment, never an amount. The
// server answers with a deposit address made for this bid alone.
import { newId } from "vault-core";
import { bad, clientKey, limited, ok, readJson, tooMany } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { checkAddress, newDepositAddress, SignerError } from "@/lib/signer";
import { loadAuction, withAuction } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const wait = limited("bid", clientKey(req), 20, 3600_000);
  if (wait) return tooMany(wait, "bids");

  const { id } = await params;
  const body = await readJson(req);
  if (!body) return bad("invalid request");
  const commitment = typeof body.commitment === "string" ? body.commitment : "";
  const tokenHash = typeof body.token_hash === "string" ? body.token_hash : "";
  const refund = typeof body.refund_address === "string" ? body.refund_address.trim() : "";
  if (!/^[0-9a-f]{64}$/.test(commitment)) return bad("invalid commitment");
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return bad("invalid token");
  if (refund.length < 20 || refund.length > 600) return bad("please give a shielded refund address");
  const deliveryPub = body.delivery_pub;
  if (deliveryPub !== undefined && (typeof deliveryPub !== "string" || !/^[0-9a-f]{64}$/.test(deliveryPub))) return bad("invalid delivery key");

  const current = await loadAuction(id);
  if (!current) return bad("not found", 404);
  if (current.state === "funding") return bad("bidding has not opened yet: the seller's bond has not arrived");
  if (current.state !== "open" || Date.now() >= current.ends_at) return bad("bidding has closed");
  if (current.delivery && !deliveryPub) return bad("this auction needs a delivery key with every bid; please reload the page");

  try {
    const check = await checkAddress(refund);
    if (!check.ok) return bad(`refund address: ${check.reason}`);
  } catch (e) {
    return bad(e instanceof SignerError ? e.message : "could not check the refund address", 503);
  }

  try {
    const result = await withAuction(id, async (auction) => {
      if (auction.state !== "open" || Date.now() >= auction.ends_at) return { error: "bidding has closed" };
      if (auction.bids.length >= LIMITS.maxBidsPerAuction) return { error: "this auction has reached its limit of bids" };
      if (auction.bids.some((b) => b.commitment === commitment)) return { error: "this commitment has already been placed" };
      const deposit_address = await newDepositAddress(auction.vault_id);
      const bid = {
        id: newId(),
        placed_at: Date.now(),
        commitment,
        token_hash: tokenHash,
        refund_address: refund,
        deposit_address,
        ...(typeof deliveryPub === "string" ? { delivery_pub: deliveryPub } : {}),
      };
      auction.bids.push(bid);
      return { bid_id: bid.id, deposit_address, position: auction.bids.length };
    });
    if (!result) return bad("not found", 404);
    if ("error" in result) return bad(result.error!);
    return ok(result, 201);
  } catch (e) {
    return bad(e instanceof SignerError ? e.message : "could not place the bid", 503);
  }
}
