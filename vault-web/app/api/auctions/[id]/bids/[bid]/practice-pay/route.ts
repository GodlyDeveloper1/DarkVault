// Fund a practice bid from a practice wallet: the house purse makes a real
// shielded deposit to the bid's address. Asked for by the bidder, who shows
// both the bid's token and the wallet's.
import { bad, clientKey, limited, matches, ok, tooMany } from "@/lib/http";
import { HOUSE } from "@/lib/house/config";
import { walletFor, walletView } from "@/lib/house/practice";
import { payFromSlot, withPurse } from "@/lib/house/purse";
import { loadAuction, withAuction } from "@/lib/store";
import { SignerError } from "@/lib/signer";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; bid: string }> }) {
  if (!HOUSE.enabled) return bad("not found", 404);
  const wait = limited("practice-pay", clientKey(req), 30, 3600_000);
  if (wait) return tooMany(wait, "practice payments");
  const { id, bid: bidId } = await params;
  const wallet = await walletFor(req.headers.get("x-practice-token"));
  const token = req.headers.get("x-bid-token");

  try {
    // One payment at a time, so a double click can't fund a bid twice.
    const result = await withPurse(async (purse): Promise<{ error: string; status?: number } | { sent: number }> => {
      const auction = await loadAuction(id);
      const bid = auction?.bids.find((b) => b.id === bidId);
      // The same answer whether the auction, the bid, its token or the wallet is wrong.
      if (!auction || !bid || !wallet || !matches(token, bid.token_hash) || bid.practice !== wallet.id) return { error: "not found", status: 404 };
      if (!auction.house) return { error: "a practice wallet only pays for bids in practice auctions" };
      if (bid.practice_paid) return { sent: bid.practice_paid.sent };
      // A deposit has to be in a block before the close. Sent too late, it would miss it and the bid would not count.
      if (auction.state !== "open" || Date.now() > auction.ends_at - HOUSE.payCutoffSec * 1000)
        return { error: "Bidding closes too soon for a deposit to reach a block in time. Try the next practice auction." };
      const view = await walletView(wallet);
      if (view.bids_left <= 0) return { error: "this practice wallet has funded all the bids it can. Use your own wallet, or make a new practice wallet." };
      if (view.balance < HOUSE.ceiling) return { error: "your practice wallet doesn't hold enough right now. Deposits come back when their auctions settle." };
      const paid = await payFromSlot(purse, bid.deposit_address);
      await withAuction(id, (a) => {
        const b = a.bids.find((x) => x.id === bidId);
        if (b) b.practice_paid = { at: Date.now(), sent: paid.sent, txid: paid.txid };
      });
      return { sent: paid.sent };
    });
    if ("error" in result) return bad(result.error, result.status ?? 409);
    return ok({ sent: result.sent, wallet: await walletView(wallet!) });
  } catch (e) {
    const message = e instanceof SignerError ? "The house wallet can't be reached right now. Try again in a minute." : e instanceof Error ? e.message : "the deposit could not be sent";
    return bad(message.charAt(0).toUpperCase() + message.slice(1), 503);
  }
}
