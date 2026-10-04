// Time-locked bids.
//
// A bid is encrypted in the bidder's browser so that it can be opened only
// once a chosen moment has passed. Nobody holds the key before then: not the
// bidder's browser, not this site.
//
// The lock is the drand network (the League of Entropy: about twenty
// independent organisations). Every three seconds its members jointly sign
// the number of the current round. A message can be encrypted "to" a future
// round: the signature of that round is the key, and it does not exist until
// enough members produce it together. Encrypting needs only the network's
// public key, a constant below, so the browser contacts nobody.
//
// What this gives an auction: the site holds every bid as ciphertext until the
// close, cannot read one early, and needs no bidder to come back and reveal.
//
// What it rests on: fewer than a threshold of drand's members colluding, and
// the page really using the public key below (it is checked, and shown, on
// the auction page).
//
// Library: tlock-js, drand's own implementation.
import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer, timelockDecrypt, timelockEncrypt } from "tlock-js";

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

const BEACON_DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

/**
 * Is this really the chain's signature of this round? Checked before a beacon
 * is stored or shown, so a relay can't hand over a made-up one. Only the
 * scheme the public network uses is understood.
 */
export function verifyBeacon(chain: BeaconChain, beacon: Beacon): boolean {
  try {
    if (chain.scheme !== QUICKNET.scheme) return false;
    if (!Number.isSafeInteger(beacon.round) || beacon.round < 1 || !/^[0-9a-f]{96}$/.test(beacon.signature) || !/^[0-9a-f]{192}$/.test(chain.public_key)) return false;
    const message = new Uint8Array(8);
    new DataView(message.buffer).setBigUint64(0, BigInt(beacon.round), false);
    return bls.verifyShortSignature(beacon.signature, sha256(message), chain.public_key, { DST: BEACON_DST });
  } catch {
    return false;
  }
}

function client(chain: BeaconChain, beacon?: Beacon) {
  const info = {
    public_key: chain.public_key,
    period: chain.period,
    genesis_time: chain.genesis_time,
    hash: chain.hash,
    groupHash: chain.group_hash,
    schemeID: chain.scheme,
    metadata: { beaconID: chain.name },
  };
  const get = async (round: number) => {
    if (!beacon || beacon.round !== round) throw new Error(`the beacon for round ${round} was not supplied`);
    // The library checks that the randomness is the hash of the signature; it is derived here, so the signature is all a caller has to keep.
    return { round: beacon.round, signature: beacon.signature, randomness: Buffer.from(sha256(Buffer.from(beacon.signature, "hex"))).toString("hex") };
  };
  return {
    // The signature is checked against the chain's public key before it is used.
    options: { disableBeaconVerification: false, noCache: true, chainVerificationParams: { chainHash: chain.hash, publicKey: chain.public_key } },
    chain: () => ({ baseUrl: "offline", info: async () => info }),
    latest: async () => {
      throw new Error("offline");
    },
    get,
  };
}

const AMOUNT_DIGITS = 16;

/**
 * Seals a bid until `round`. The plaintext always has the same length, so the
 * size of the ciphertext says nothing about the amount.
 */
export async function sealBid(chain: BeaconChain, round: number, amount: number, blinding: string): Promise<string> {
  // Something that claims to be the public network but isn't quite: refuse rather than seal to who knows what.
  if (chain.hash === QUICKNET.hash && !isPublicBeacon(chain)) throw new Error("this is not the public drand network it claims to be");
  if (!Number.isSafeInteger(amount) || amount < 0 || String(amount).length > AMOUNT_DIGITS) throw new Error("the bid must be a whole number of zatoshis");
  if (!/^[0-9a-f]{64}$/.test(blinding)) throw new Error("the blinding must be 64 hex characters");
  if (!Number.isSafeInteger(round) || round < 1) throw new Error("the round must be a positive whole number");
  const plain = `dv2|${String(amount).padStart(AMOUNT_DIGITS, "0")}|${blinding}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return timelockEncrypt(round, Buffer.from(plain, "utf8"), client(chain) as any);
}

/** Reads, without opening anything, which round and chain a sealed bid is locked to. Null if it isn't one. */
export function sealedFor(sealed: string): { round: number; chain_hash: string } | null {
  try {
    const body = sealed
      .replace(/-----(BEGIN|END) AGE ENCRYPTED FILE-----/g, "")
      .replace(/\s+/g, "");
    const head = Buffer.from(body, "base64").subarray(0, 200).toString("latin1");
    const m = /^age-encryption\.org\/v1\n-> tlock (\d{1,15}) ([0-9a-f]{64})\n/.exec(head);
    return m ? { round: Number(m[1]), chain_hash: m[2]! } : null;
  } catch {
    return null;
  }
}

/** Thrown when a bid's round has not come yet by this machine's clock. Try again later; the bid may be fine. */
export class TooEarly extends Error {
  constructor() {
    super("it is too early to open this bid");
    this.name = "TooEarly";
  }
}

// The library prints every beacon it uses. One line per bid is noise in a
// server log, so console.log is muted while it runs. Calls can overlap, so
// the mute is counted and lifted only when the last one has finished.
let muted = 0;
let realLog: typeof console.log | null = null;
function mute(): void {
  if (muted++ === 0) {
    realLog = console.log;
    console.log = () => {};
  }
}
function unmute(): void {
  if (--muted === 0 && realLog) {
    console.log = realLog;
    realLog = null;
  }
}

/**
 * Opens a sealed bid with its round's beacon. Throws if the beacon is not a
 * valid signature of the chain, is for another round, or the contents are not
 * a bid.
 */
export async function openSealedBid(chain: BeaconChain, sealed: string, beacon: Beacon): Promise<{ amount: number; blinding: string }> {
  if (!verifyBeacon(chain, beacon)) throw new Error("that is not the chain's signature for this round");
  // The library refuses by this machine's clock too. Say so plainly, so a
  // caller can tell "not yet" from "not a bid".
  if (Date.now() < roundTimeMs(chain, beacon.round)) throw new TooEarly();
  mute();
  let plain: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plain = (await timelockDecrypt(sealed, client(chain, beacon) as any)).toString("utf8");
  } finally {
    unmute();
  }
  const m = /^dv2\|(\d{16})\|([0-9a-f]{64})$/.exec(plain);
  if (!m) throw new Error("the sealed contents are not a bid");
  const amount = Number(m[1]);
  if (!Number.isSafeInteger(amount)) throw new Error("the sealed amount is not a valid number");
  return { amount, blinding: m[2]! };
}
