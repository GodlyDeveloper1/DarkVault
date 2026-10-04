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

export function maySee(auction: Auction, req: Request): boolean {
  if (!auction.private) return true;
  return matches(req.headers.get("x-invite"), auction.private.access_hash);
}
