// The drand beacon: which network bids are locked to, when its rounds are
// signed, and which round a sealed bid waits for. Nothing here encrypts or
// decrypts, and nothing here needs tlock-js: see timelock.ts for that.

/** A drand network, as much of it as time-lock encryption needs. */
export interface BeaconChain {
  /** The chain's id. */
  hash: string;
  /** The network's public key. This is what bids are encrypted to. */
  public_key: string;
  /** Unix seconds of round 1. */
  genesis_time: number;
  /** Seconds between rounds. */
  period: number;
  scheme: string;
  group_hash: string;
  name: string;
}

/** drand's public network for time-lock encryption ("quicknet"), run by the League of Entropy. */
export const QUICKNET: BeaconChain = {
  hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  public_key:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesis_time: 1692803367,
  period: 3,
  scheme: "bls-unchained-g1-rfc9380",
  group_hash: "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
  name: "quicknet",
};

/**
 * Is this the public drand network, exactly? Anything else is a test beacon
 * and locks nothing. Every field counts: the same key with another start time
 * or period would turn "the round after the close" into a round that has
 * already been signed.
 */
export function isPublicBeacon(chain: BeaconChain | null | undefined): boolean {
  return (
    !!chain &&
    chain.hash === QUICKNET.hash &&
    chain.public_key === QUICKNET.public_key &&
    chain.scheme === QUICKNET.scheme &&
    chain.genesis_time === QUICKNET.genesis_time &&
    chain.period === QUICKNET.period
  );
}

/**
 * The chain to work with, given one described by somebody else (a server):
 * the constant built into this code when it is the public network, so that
 * nothing about the public network is ever taken on another's word.
 */
export function trustedChain(chain: BeaconChain): BeaconChain {
  return isPublicBeacon(chain) ? QUICKNET : chain;
}

/** One round's signature, as drand publishes it. */
export interface Beacon {
  round: number;
  signature: string;
  randomness?: string;
}

/** When a round is signed, in milliseconds. */
export function roundTimeMs(chain: BeaconChain, round: number): number {
  return (chain.genesis_time + (round - 1) * chain.period) * 1000;
}

/** The first round signed strictly after a moment: a bid locked to it can't be opened before that moment. */
export function roundAfter(chain: BeaconChain, timeMs: number): number {
  if (!Number.isFinite(timeMs) || timeMs < chain.genesis_time * 1000) throw new Error("that time is before the beacon began");
  return Math.floor((timeMs - chain.genesis_time * 1000) / (chain.period * 1000)) + 2;
}


/** Reads, without opening anything, which round and chain a sealed bid is locked to. Null if it isn't one. */
export function sealedFor(sealed: string): { round: number; chain_hash: string } | null {
  try {
    const body = sealed
      .replace(/-----(BEGIN|END) AGE ENCRYPTED FILE-----/g, "")
      .replace(/\s+/g, "");
    // The header is in the first 200 bytes: 268 base64 characters (a multiple of four) hold 201.
    const head = atob(body.slice(0, 268));
    const m = /^age-encryption\.org\/v1\n-> tlock (\d{1,15}) ([0-9a-f]{64})\n/.exec(head);
    return m ? { round: Number(m[1]), chain_hash: m[2]! } : null;
  } catch {
    return null;
  }
}
