// The drand network, as the server uses it: which chain new auctions lock
// their bids to, and fetching a round's signature once it exists.
//
// Bidders' browsers never come here and never contact drand: sealing a bid
// needs only the chain's public key, which is part of the page.
//
// VAULT_TEST_BEACON_URL replaces the public network with a stand-in for tests
// (scripts/mock-beacon.mjs). A stand-in can sign any round whenever asked, so
// it locks nothing; every auction page that uses one says so in a banner.
import "server-only";
import { isPublicBeacon, QUICKNET, verifyBeacon, type Beacon, type BeaconChain } from "vault-core";

/** Independent relays of the same public network. Any one of them is enough: the signature is checked here. */
const RELAYS = ["https://api.drand.sh", "https://drand.cloudflare.com", "https://api2.drand.sh", "https://api3.drand.sh"];

const TEST_URL = (process.env.VAULT_TEST_BEACON_URL ?? "").replace(/\/+$/, "");
let testChain: BeaconChain | null = null;
let warned = false;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/** The chain a new auction locks its bids to. */
export async function beaconChain(): Promise<BeaconChain> {
  if (!TEST_URL) return QUICKNET;
  if (!warned) {
    warned = true;
    console.warn("[dark vault] VAULT_TEST_BEACON_URL is set: new auctions use a TEST beacon, which locks nothing. Never set this on a real site.");
  }
  if (!testChain) {
    const c = (await getJson(`${TEST_URL}/info`)) as Partial<BeaconChain>;
    if (typeof c?.hash !== "string" || typeof c.public_key !== "string" || typeof c.genesis_time !== "number" || typeof c.period !== "number") throw new Error("the test beacon did not describe itself");
    testChain = { hash: c.hash, public_key: c.public_key, genesis_time: c.genesis_time, period: c.period, scheme: String(c.scheme), group_hash: String(c.group_hash), name: String(c.name ?? "test") };
  }
  return testChain;
}

export function usingTestBeacon(): boolean {
  return TEST_URL !== "";
}

/**
 * A round's signature, or null if it can't be had right now (the round has
 * not happened, or no relay answered). Whatever a relay returns is checked
 * against the chain's public key before it is believed.
 */
export async function fetchBeacon(chain: BeaconChain, round: number): Promise<Beacon | null> {
  const bases = isPublicBeacon(chain) ? RELAYS.map((r) => `${r}/${chain.hash}`) : TEST_URL ? [TEST_URL] : [];
  if (bases.length === 0) return null;
  // All relays at once; the first valid answer wins.
  const ask = async (base: string): Promise<Beacon> => {
    const b = (await getJson(`${base}/public/${round}`)) as Partial<Beacon>;
    if (b?.round !== round || typeof b.signature !== "string") throw new Error("not this round");
    const beacon: Beacon = { round, signature: b.signature.toLowerCase() };
    if (!verifyBeacon(chain, beacon)) throw new Error("not the chain's signature");
    return beacon;
  };
  try {
    return await Promise.any(bases.map(ask));
  } catch {
    return null;
  }
}
