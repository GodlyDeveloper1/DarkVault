// The building blocks under the proofs in fairness.ts and batch.ts: Pedersen
// commitments on ristretto255, and a proof that a committed number has at most
// K bits. See fairness.ts for what they are used to show, and why they are
// sound. Nothing here is specific to one kind of sale.
//
// Primitives: ristretto255 and SHA-512 from noble (audited, pure JavaScript).
import { ed25519, RistrettoPoint } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";

export type Point = InstanceType<typeof RistrettoPoint>;

/** The order of the group: scalars are integers modulo this. */
export const L = ed25519.CURVE.n;
export const G = RistrettoPoint.BASE;
export const te = new TextEncoder();

export const mod = (x: bigint) => ((x % L) + L) % L;

// --- encoding ------------------------------------------------------------------

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bytesOf(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function numberOf(bytes: Uint8Array): bigint {
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return x;
}

export const hexOf = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function unhex(text: string, bytes: number, what: string): Uint8Array {
  if (typeof text !== "string" || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) throw new Error(`${what} must be ${bytes * 2} hex characters`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A scalar from its 32-byte big-endian hex. Must be below the group order: one value, one encoding. */
export function scalarOf(hex: string, what: string): bigint {
  const x = numberOf(unhex(hex, 32, what));
  if (x >= L) throw new Error(`${what} is out of range`);
  return x;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error("not base64");
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Hashes labelled, length-prefixed parts to a scalar. The length prefixes stop two different inputs running together. */
export function hashToScalar(label: string, ...parts: Uint8Array[]): bigint {
  const framed: Uint8Array[] = [te.encode(label), new Uint8Array([0])];
  for (const p of parts) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, p.length, false);
    framed.push(len, p);
  }
  return mod(numberOf(sha512(concat(...framed))));
}

/** A random scalar, never zero. 64 random bytes reduced: no measurable bias. */
function randomScalar(): bigint {
  for (;;) {
    const x = mod(numberOf(crypto.getRandomValues(new Uint8Array(64))));
    if (x !== 0n) return x;
  }
}

// --- commitments -----------------------------------------------------------------

const bases = new Map<string, Point>();

/** The second base point for an auction. Derived by hashing, so its relation to G is unknown to everyone. */
export function blindingBase(auctionId: string): Point {
  let h = bases.get(auctionId);
  if (!h) {
    unhex(auctionId, 16, "the auction id");
    h = RistrettoPoint.hashToCurve(sha512(te.encode(`dark-vault/v2/pedersen-H:${auctionId}`)));
    if (bases.size > 2000) bases.clear();
    bases.set(auctionId, h);
  }
  return h;
}

export function assertAmount(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${what} must be a whole number of zatoshis`);
}

/** A new blinding for a bid: 32 bytes of hex, kept in the bidder's ticket. */
export function newBlinding(): string {
  return hexOf(bytesOf(randomScalar()));
}

function commitPoint(H: Point, amount: bigint, blinding: bigint): Point {
  // multiply() refuses 0, so build the two halves only when they are not zero.
  let c = RistrettoPoint.ZERO;
  if (amount !== 0n) c = c.add(G.multiply(amount));
  if (blinding !== 0n) c = c.add(H.multiply(blinding));
  return c;
}

/** The commitment to a bid: amount·G + blinding·H, as 64 hex characters. */
export function pedersenCommit(auctionId: string, amount: number, blinding: string): string {
  assertAmount(amount, "the bid");
  return commitPoint(blindingBase(auctionId), BigInt(amount), scalarOf(blinding, "the blinding")).toHex();
}

/** Does this amount and blinding open this commitment? */
export function pedersenOpens(auctionId: string, commitment: string, amount: number, blinding: string): boolean {
  try {
    return pedersenCommit(auctionId, amount, blinding) === commitment;
  } catch {
    return false;
  }
}

/** Is this a well-formed commitment (a valid group element)? */
export function validCommitment(commitment: string): boolean {
  try {
    unhex(commitment, 32, "the commitment");
    RistrettoPoint.fromHex(commitment);
    return true;
  } catch {
    return false;
  }
}

// --- "this committed number has at most K bits" -----------------------------------

const BIT_PROOF_BYTES = 5 * 32; // bit commitment, two challenges, two responses

/** z·H − c·Y, for values that are public (so the faster, non-constant-time multiply is fine). */
function respond(H: Point, z: bigint, c: bigint, Y: Point): Point {
  let t = RistrettoPoint.ZERO;
  if (z !== 0n) t = t.add(H.multiplyUnsafe(z));
  if (c !== 0n) t = t.subtract(Y.multiplyUnsafe(c));
  return t;
}

function bitChallenge(context: Uint8Array, j: number, B: Point, T0: Point, T1: Point): bigint {
  return hashToScalar("dark-vault/v2/range-bit", context, new Uint8Array([j]), B.toRawBytes(), T0.toRawBytes(), T1.toRawBytes());
}

/**
 * Proves that D = x·G + s·H with 0 ≤ x < 2^bits, without showing x or s.
 * `context` ties the proof to one statement and one bid, so it can't be reused.
 */
export function proveRange(H: Point, x: bigint, s: bigint, bits: number, context: Uint8Array): Uint8Array {
  if (x < 0n || x >= 1n << BigInt(bits)) throw new Error("the value is outside the range to be proven");
  // Blindings for the bit commitments, chosen so that they add back up to s.
  const blind: bigint[] = new Array(bits);
  let rest = s;
  for (let j = 1; j < bits; j++) {
    blind[j] = randomScalar();
    rest = mod(rest - (blind[j]! << BigInt(j)));
  }
  blind[0] = rest;

  const out = new Uint8Array(bits * BIT_PROOF_BYTES);
  for (let j = 0; j < bits; j++) {
    const bit = Number((x >> BigInt(j)) & 1n);
    const B = commitPoint(H, BigInt(bit), blind[j]!);
    // Y[b] = B − b·G is a multiple of H exactly when the bit is b.
    const Y = [B, B.subtract(G)] as const;
    // The true branch is proven honestly; the other is simulated.
    const k = randomScalar();
    const cFake = randomScalar();
    const zFake = randomScalar();
    const T: Point[] = [];
    T[bit] = H.multiply(k);
    T[1 - bit] = respond(H, zFake, cFake, Y[1 - bit]!);
    const c = bitChallenge(context, j, B, T[0]!, T[1]!);
    const cTrue = mod(c - cFake);
    const zTrue = mod(k + cTrue * blind[j]!);
    const cs = bit === 0 ? [cTrue, cFake] : [cFake, cTrue];
    const zs = bit === 0 ? [zTrue, zFake] : [zFake, zTrue];
    out.set(concat(B.toRawBytes(), bytesOf(cs[0]!), bytesOf(cs[1]!), bytesOf(zs[0]!), bytesOf(zs[1]!)), j * BIT_PROOF_BYTES);
  }
  return out;
}

/** Checks a proof made by `proveRange` for the commitment D. */
export function verifyRange(H: Point, D: Point, bits: number, context: Uint8Array, proof: Uint8Array): boolean {
  if (proof.length !== bits * BIT_PROOF_BYTES) return false;
  const B: Point[] = [];
  try {
    for (let j = 0; j < bits; j++) {
      const at = j * BIT_PROOF_BYTES;
      const b = RistrettoPoint.fromHex(proof.subarray(at, at + 32));
      const [c0, c1, z0, z1] = [1, 2, 3, 4].map((n) => numberOf(proof.subarray(at + 32 * n, at + 32 * (n + 1)))) as [bigint, bigint, bigint, bigint];
      if (c0 >= L || c1 >= L || z0 >= L || z1 >= L) return false;
      const T0 = respond(H, z0, c0, b);
      const T1 = respond(H, z1, c1, b.subtract(G));
      if (mod(c0 + c1) !== bitChallenge(context, j, b, T0, T1)) return false;
      B.push(b);
    }
  } catch {
    return false; // a malformed point
  }
  // The bit commitments, weighted by their powers of two, must add up to D.
  let sum = RistrettoPoint.ZERO;
  for (let j = bits - 1; j >= 0; j--) sum = sum.double().add(B[j]!);
  return sum.equals(D);
}


export const pause = () => new Promise<void>((r) => setTimeout(r, 0));
export { RistrettoPoint, sha512 };
