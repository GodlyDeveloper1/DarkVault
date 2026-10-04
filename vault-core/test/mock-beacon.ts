// A stand-in drand network for tests: its own key, the same scheme as the
// public one. It can sign any round on demand, which is exactly what the real
// network can't do, so nothing sealed to it is really locked.
import { bls12_381 as bls } from "@noble/curves/bls12-381";
import { sha256 } from "@noble/hashes/sha256";
import type { Beacon, BeaconChain } from "../src/index.ts";

const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";

export function mockBeacon(secretHex = "1f".repeat(32), genesisSecondsAgo = 3000) {
  const secret = Buffer.from(secretHex, "hex");
  const chain: BeaconChain = {
    hash: "aa".repeat(32),
    public_key: Buffer.from(bls.getPublicKeyForShortSignatures(secret)).toString("hex"),
    genesis_time: Math.floor(Date.now() / 1000) - genesisSecondsAgo,
    period: 3,
    scheme: "bls-unchained-g1-rfc9380",
    group_hash: "bb".repeat(32),
    name: "test",
  };
  const sign = (round: number): Beacon => {
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(round));
    const signature = Buffer.from(bls.signShortSignature(sha256(message), secret, { DST })).toString("hex");
    return { round, signature, randomness: Buffer.from(sha256(Buffer.from(signature, "hex"))).toString("hex") };
  };
  return { chain, sign };
}
