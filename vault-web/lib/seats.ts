// Seats: how many people an auction (or a sale) can seat at once.
//
// A bid takes a seat when it is placed. It keeps the seat once a deposit for
// it arrives; a bid that has had no deposit after LIMITS.seatHoldSec gives its
// seat back, so nobody can fill an auction with bids they never fund. A bid
// whose seat went back is still a bid: a deposit that comes later, before the
// close, counts as usual.
import "server-only";
import { LIMITS } from "./limits";
import type { Auction } from "./types";

export interface Seats {
  /** Seats in all. */
  seats: number;
  /** Seats taken now: funded bids, and unfunded ones still inside their hold. */
  taken: number;
  /** Seats free now. */
  left: number;
  /** A taken seat can still come free (an unfunded bid inside its hold), and the auction can take more bids. */
  may_free: boolean;
  /** No more bids at all: the auction has taken as many as it can in total. */
  closed: boolean;
}

/**
 * `funded(bidId)` says whether a deposit for that bid has been seen. Without
 * it (the signer can't be asked), every bid placed counts as seated: an
 * auction never takes more people than it should because the signer was down.
 */
export function seatsOf(auction: Auction, funded: ((bidId: string) => boolean) | null, now = Date.now()): Seats {
  const seats = LIMITS.maxBidsPerAuction;
  const hold = LIMITS.seatHoldSec * 1000;
  const closed = auction.bids.length >= LIMITS.maxPlacedBids;
  let taken = 0;
  let holding = 0;
  for (const b of auction.bids) {
    if (!funded || funded(b.id)) taken += 1;
    else if (now - b.placed_at < hold) {
      taken += 1;
      holding += 1;
    }
  }
  const left = closed ? 0 : Math.max(0, seats - taken);
  return { seats, taken, left, may_free: !closed && holding > 0, closed };
}
