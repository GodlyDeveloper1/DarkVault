// Placing a sealed bid. Used by the bid route and by the house's automated
// bidders, which place their bids the same way a browser does.
import "server-only";
import { newId, sealedFor, sealedHash, signReceipt, validCommitment, validDeliveryPublic, type Receipt } from "vault-core";
import { LIMITS } from "./limits";
import { checkAddress, newDepositAddress, SignerError } from "./signer";
import { siteKey } from "./sitekey";
import { loadAuction, withAuction } from "./store";

export interface NewBid {
  commitment: string;
  tokenHash: string;
  refund: string;
  deliveryPub?: string;
  /** Scheme 2: the bid, locked in time. */
  sealed: string;
  /** PRIVATE. The practice wallet that will fund this bid, if any. */
  practice?: string;
}

export type Placed = { error: string; status?: number } | { bid_id: string; deposit_address: string; position: number; receipt?: Receipt };

export async function placeBid(id: string, b: NewBid): Promise<Placed> {
  const current = await loadAuction(id);
  if (!current) return { error: "not found", status: 404 };
  if (current.state === "funding") return { error: "bidding has not opened yet: the seller's bond has not arrived" };
  if (current.state !== "open" || Date.now() >= current.ends_at) return { error: "bidding has closed" };
  if (current.delivery && !b.deliveryPub) return { error: "this auction needs a delivery key with every bid; please reload the page" };
  if (b.deliveryPub && !validDeliveryPublic(b.deliveryPub)) return { error: "invalid delivery key" };

  // Scheme 2: the commitment is a group element, and the bid comes locked to this auction's round.
  if (current.scheme === 2) {
    if (!validCommitment(b.commitment)) return { error: "invalid commitment" };
    if (b.sealed.length > LIMITS.sealedMax || !/^-----BEGIN AGE ENCRYPTED FILE-----\n[A-Za-z0-9+/=\n]+-----END AGE ENCRYPTED FILE-----\n?$/.test(b.sealed))
      return { error: "the time-locked bid is missing or malformed" };
    const lock = sealedFor(b.sealed);
    if (!current.timelock || !lock || lock.round !== current.timelock.round || lock.chain_hash !== current.timelock.chain.hash)
      return { error: "this bid is not locked to this auction's close; please reload the page" };
  }

  try {
    const check = await checkAddress(b.refund);
    if (!check.ok) return { error: `refund address: ${check.reason}` };
  } catch (e) {
    return { error: e instanceof SignerError ? e.message : "could not check the refund address", status: 503 };
  }

  try {
    const result = await withAuction(id, async (auction): Promise<Placed> => {
      if (auction.state !== "open" || Date.now() >= auction.ends_at) return { error: "bidding has closed" };
      if (auction.bids.length >= LIMITS.maxBidsPerAuction) return { error: "this auction has reached its limit of bids" };
      if (auction.bids.some((x) => x.commitment === b.commitment)) return { error: "this commitment has already been placed" };
      const deposit_address = await newDepositAddress(auction.vault_id);
      const placed_at = Date.now();
      const position = auction.bids.length + 1;
      // The site signs what it accepted, so it can't later deny the bid or move it on the board.
      const receipt =
        auction.scheme === 2
          ? signReceipt((await siteKey()).secret, { auction_id: auction.id, commitment: b.commitment, sealed_hash: sealedHash(b.sealed), position, placed_at })
          : undefined;
      const bid = {
        id: newId(),
        placed_at,
        commitment: b.commitment,
        token_hash: b.tokenHash,
        refund_address: b.refund,
        deposit_address,
        ...(b.deliveryPub ? { delivery_pub: b.deliveryPub } : {}),
        ...(receipt ? { sealed: b.sealed, receipt } : {}),
        ...(b.practice ? { practice: b.practice } : {}),
      };
      auction.bids.push(bid);
      return { bid_id: bid.id, deposit_address, position, ...(receipt ? { receipt } : {}) };
    });
    return result ?? { error: "not found", status: 404 };
  } catch (e) {
    return { error: e instanceof SignerError ? e.message : "could not place the bid", status: 503 };
  }
}
