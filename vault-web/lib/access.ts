// Who may see an auction. A public auction: anyone. A private one: only a
// browser that shows the invite's access token, derived from the invite key in
// the link, which the site never sees. (The seller's browser derives the same
// invite from its manage key.)
//
// A private auction that is asked for without the invite gets the same answer
// as an auction that doesn't exist.
import "server-only";
import { matches } from "./http";
import type { Auction } from "./types";

/** The title stored for a private auction. The real one is in the encrypted listing. */
export const PRIVATE_TITLE = "Private auction";
/** And for a private deal. */
export const DEAL_TITLE = "Private deal";

export function maySee(auction: Auction, req: Request): boolean {
  // A deal is always private. One that somehow isn't is shown to nobody.
  if (auction.deal && !auction.private) return false;
  if (!auction.private) return true;
  return matches(req.headers.get("x-invite"), auction.private.access_hash);
}
