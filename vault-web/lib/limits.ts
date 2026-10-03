// The numbers that bound an auction. Env overrides exist for tests and demos.
import "server-only";
import { MIN_BID } from "vault-core";

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const LIMITS = {
  titleMax: 80,
  descriptionMax: 1200,
  minReserve: MIN_BID,
  /** A deposit needs a block (about 75 seconds) to confirm, so auctions can't be shorter than this. */
  minDurationSec: num("VAULT_MIN_DURATION_SEC", 10 * 60),
  maxDurationSec: 14 * 24 * 3600,
  minRevealSec: num("VAULT_MIN_REVEAL_SEC", 5 * 60),
  maxRevealSec: 24 * 3600,
  /** Delivery: the shortest and longest time limits a seller can set for the handover and for complaints. */
  minDeliverySec: num("VAULT_MIN_DELIVERY_SEC", 3600),
  maxDeliverySec: 30 * 24 * 3600,
  /** An encrypted lot is the content (at most 1 MB) plus a small header and tag. */
  maxLotBytes: 1024 * 1024 + 2048,
  disputeReasonMax: 600,
  envelopeMax: 8000,
  /** Each bid costs the signer a new address to watch. */
  maxBidsPerAuction: 100,
};
