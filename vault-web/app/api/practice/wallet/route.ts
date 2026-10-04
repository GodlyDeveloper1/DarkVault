// A practice wallet: make one (POST), or look at one (GET, with its token).
// The wallet is custodial and only works in practice auctions; see lib/house/practice.ts.
import { bad, clientKey, limited, ok, tooMany } from "@/lib/http";
import { HOUSE } from "@/lib/house/config";
import { createWallet, walletFor, walletView } from "@/lib/house/practice";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!HOUSE.enabled) return bad("this site has no practice wallets", 404);
  const wait = limited("practice-wallet", clientKey(req), 3, 3600_000);
  if (wait) return tooMany(wait, "practice wallets");
  const made = await createWallet();
  if (!made) return bad("Today's practice wallets have all been handed out. Try again tomorrow, or bid with your own wallet.", 429);
  const wallet = await walletFor(made.token);
  return ok({ token: made.token, wallet: await walletView(wallet!) }, 201);
}

export async function GET(req: Request) {
  const wallet = HOUSE.enabled ? await walletFor(req.headers.get("x-practice-token")) : null;
  if (!wallet) return bad("not found", 404);
  return ok({ wallet: await walletView(wallet) });
}
