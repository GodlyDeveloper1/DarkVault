// Open a sealed bid. Only possible after bidding has closed, so no amount
// reaches the server while others can still bid.
//
// Auctions with time-locked bids open them on the server when the lock's
// round is signed. This route is then the fallback, for a bid the server
// could not open (it could not reach the beacon, say): the bidder's browser
// opens it from its ticket.
import { opens, pedersenOpens } from "vault-core";
import { advance } from "@/lib/engine";
import { bad, clientKey, limited, ok, readJson, tooMany } from "@/lib/http";
import { withAuction } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; bid: string }> }) {
  const wait = limited("reveal", clientKey(req), 120, 3600_000);
  if (wait) return tooMany(wait, "reveals");

  const { id, bid: bidId } = await params;
  const body = await readJson(req);
  if (!body) return bad("invalid request");
  const amount = body.amount;
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) return bad("invalid amount");
  if (!/^[0-9a-f]{64}$/.test(nonce)) return bad("invalid nonce");

  await advance(id, true); // close the auction first, if its time has come
  const result = await withAuction(id, async (auction) => {
    const bid = auction.bids.find((b) => b.id === bidId);
    if (!bid) return { error: "not found", status: 404 };
    if (auction.state === "open") return { error: "bidding is still open; bids are revealed after it closes", status: 409 };
    if (bid.reveal) return { revealed: true };
    // By the clock too: an auction that could not be decided on time (the signer was away, say) takes no late reveals.
    if (auction.state !== "revealing" || Date.now() > (auction.reveal_ends_at ?? 0)) return { error: "the reveal window has closed", status: 409 };
    const fits = auction.scheme === 2 ? pedersenOpens(auction.id, bid.commitment, amount, nonce) : await opens(auction.id, bid.commitment, amount, nonce);
    if (!fits) return { error: "that amount and nonce don't open this bid's commitment", status: 400 };
    bid.reveal = { amount, nonce, at: Date.now(), by: "bidder" };
    return { revealed: true };
  });
  if (!result) return bad("not found", 404);
  if ("error" in result) return bad(result.error!, result.status);
  await advance(id, true); // decide straight away if this was the last reveal
  return ok(result);
}
