// Hidden-amount commitments, and a proof that the highest bid won.
//
// A sealed bid is a Pedersen commitment on ristretto255:
//
//     C = amount·G + blinding·H
//
// G is the group's base point. H is a second point, derived by hashing the
// auction id, so nobody knows how H relates to G. C hides the amount
// completely (the blinding is random) and binds the bidder to it (opening C
// to another amount would mean finding that relation).
//
// After the close, the coordinator knows every amount. To show the result is
// right without publishing the losing bids, it publishes:
//
//   - the winner's blinding, so anyone can check the winning commitment really
//     holds the price;
//   - for every other bid that counted, a proof that its amount is no higher
//     than the price (strictly lower, if it was placed before the winner:
//     earlier bids win ties).
//
// "No higher than a bound" is shown as: bound − amount is a number of at most
// K bits, where 2^K exceeds the highest bid allowed. The difference is split
// into bits; each bit gets its own small commitment and a proof that it holds
// 0 or 1 (a Schnorr OR-proof); and the bit commitments must add back up to
// bound·G − C. A negative difference is not a K-bit number, so no such proof
// exists for a bid above its bound.
//
// Nothing here needs a setup ceremony or a downloaded parameter file. The only
// assumption is the usual one for this group: discrete logarithms are hard.
//
// Primitives: ristretto255 and SHA-512 from noble (audited, pure JavaScript).
import { ed25519, RistrettoPoint } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";

type Point = InstanceType<typeof RistrettoPoint>;

/** The order of the group: scalars are integers modulo this. */
const L = ed25519.CURVE.n;
const G = RistrettoPoint.BASE;
const te = new TextEncoder();

const mod = (x: bigint) => ((x % L) + L) % L;

// --- encoding ------------------------------------------------------------------

function concat(...parts: Uint8Array[]): Uint8Array {
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

const hexOf = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function unhex(text: string, bytes: number, what: string): Uint8Array {
  if (typeof text !== "string" || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) throw new Error(`${what} must be ${bytes * 2} hex characters`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A scalar from its 32-byte big-endian hex. Must be below the group order: one value, one encoding. */
function scalarOf(hex: string, what: string): bigint {
  const x = numberOf(unhex(hex, 32, what));
  if (x >= L) throw new Error(`${what} is out of range`);
  return x;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error("not base64");
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Hashes labelled, length-prefixed parts to a scalar. The length prefixes stop two different inputs running together. */
function hashToScalar(label: string, ...parts: Uint8Array[]): bigint {
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
function blindingBase(auctionId: string): Point {
  let h = bases.get(auctionId);
  if (!h) {
    unhex(auctionId, 16, "the auction id");
    h = RistrettoPoint.hashToCurve(sha512(te.encode(`dark-vault/v2/pedersen-H:${auctionId}`)));
    if (bases.size > 2000) bases.clear();
    bases.set(auctionId, h);
  }
  return h;
}

function assertAmount(value: number, what: string): void {
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
function proveRange(H: Point, x: bigint, s: bigint, bits: number, context: Uint8Array): Uint8Array {
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
function verifyRange(H: Point, D: Point, bits: number, context: Uint8Array, proof: Uint8Array): boolean {
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

// --- the fairness statement and its proof -----------------------------------------

/**
 * Why a bid on the board did or did not take part in the result:
 *   counted      funded and opened; its amount is covered by the proof
 *   no-deposit   nothing arrived at its deposit address before the close
 *   underfunded  its deposit was smaller than every bid must deposit
 *   unopened     it could not be opened, or what it held was not a valid bid
 */
export type BoardStatus = "counted" | "no-deposit" | "underfunded" | "unopened";

/** Everything public about an auction's result. The proof is checked against exactly this. */
export interface FairnessStatement {
  v: 2;
  auction_id: string;
  reserve: number;
  /** The highest bid the auction allowed. */
  ceiling: number;
  /** Every bid placed, in the order placed. */
  bids: { commitment: string; status: BoardStatus }[];
  sold: boolean;
  /** The winning amount, or null if not sold. */
  price: number | null;
  /** The winner's position in `bids`, or null if not sold. */
  winner: number | null;
}

export interface FairnessProof {
  /** Opens the winning commitment to the price. Null if not sold. */
  winner_blinding: string | null;
  /** For each counted bid other than the winner, by position: proof that it is within its bound. */
  ranges: Record<string, string>;
}

/** What a bid held, known to the coordinator after the close. */
export interface Opening {
  amount: number;
  blinding: string;
}

/** How many bits cover every amount the auction allows. */
export function rangeBits(ceiling: number): number {
  assertAmount(ceiling, "the ceiling");
  return Math.max(1, ceiling.toString(2).length);
}

/**
 * The most a counted, non-winning bid at position `i` can have been:
 * the price, or one less if it was placed before the winner (an equal bid
 * placed earlier would have won). With no sale, one less than the reserve.
 */
export function fairnessBound(statement: FairnessStatement, i: number): number {
  if (!statement.sold) return statement.reserve - 1;
  return statement.price! - (i < statement.winner! ? 1 : 0);
}

function statementBytes(s: FairnessStatement): Uint8Array {
  // One fixed spelling of the statement, so prover and verifier hash the same bytes.
  const text = [
    "dark-vault/v2/fairness",
    s.auction_id,
    s.reserve,
    s.ceiling,
    s.sold ? 1 : 0,
    s.price ?? "-",
    s.winner ?? "-",
    s.bids.length,
    ...s.bids.map((b) => `${b.commitment}:${b.status}`),
  ].join("|");
  return sha512(te.encode(text));
}

const rangeContext = (digest: Uint8Array, i: number) => concat(digest, te.encode(`#${i}`));

/** The problems with a statement's shape, before any proof is looked at. Empty means well-formed. */
function shapeProblems(s: FairnessStatement): string[] {
  const problems: string[] = [];
  const amount = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (s?.v !== 2 || !/^[0-9a-f]{32}$/.test(s.auction_id ?? "")) return ["this is not a fairness statement"];
  if (!amount(s.reserve) || !amount(s.ceiling) || s.reserve < 1 || s.ceiling < s.reserve) problems.push("the reserve and ceiling make no sense");
  if (!Array.isArray(s.bids)) return [...problems, "the list of bids is missing"];
  const seen = new Set<string>();
  s.bids.forEach((b, i) => {
    if (!validCommitment(b?.commitment)) problems.push(`bid #${i + 1} is not a valid commitment`);
    else if (seen.has(b.commitment)) problems.push(`bid #${i + 1} repeats an earlier commitment`);
    seen.add(b?.commitment);
    if (!["counted", "no-deposit", "underfunded", "unopened"].includes(b?.status)) problems.push(`bid #${i + 1} has an unknown status`);
  });
  if (s.sold) {
    if (!amount(s.price) || s.price! < s.reserve || s.price! > s.ceiling) problems.push("the price is outside the reserve and the ceiling");
    if (!Number.isInteger(s.winner) || s.winner! < 0 || s.winner! >= s.bids.length || s.bids[s.winner!]?.status !== "counted")
      problems.push("the winner is not a counted bid on the board");
  } else if (s.price !== null || s.winner !== null) problems.push("an unsold lot can't have a price or a winner");
  return problems;
}

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Makes the proof. `openings[i]` is what bid `i` held; it is needed for every
 * counted bid. Throws if the statement is not true: a proof of a false result
 * can't be made, and trying is a bug to hear about.
 */
export async function proveFairness(statement: FairnessStatement, openings: (Opening | undefined)[]): Promise<FairnessProof> {
  const problems = shapeProblems(statement);
  if (problems.length) throw new Error(`the statement is malformed: ${problems[0]}`);
  const H = blindingBase(statement.auction_id);
  const bits = rangeBits(statement.ceiling);
  const digest = statementBytes(statement);
  const proof: FairnessProof = { winner_blinding: null, ranges: {} };

  for (let i = 0; i < statement.bids.length; i++) {
    const bid = statement.bids[i]!;
    if (bid.status !== "counted") continue;
    const o = openings[i];
    if (!o || !pedersenOpens(statement.auction_id, bid.commitment, o.amount, o.blinding)) throw new Error(`bid #${i + 1} is counted but its opening is missing or wrong`);
    if (statement.sold && i === statement.winner) {
      if (o.amount !== statement.price) throw new Error("the winner's bid is not the price");
      proof.winner_blinding = o.blinding;
      continue;
    }
    const bound = fairnessBound(statement, i);
    if (o.amount > bound) throw new Error(`bid #${i + 1} is higher than the result allows: the statement is not true`);
    // bound·G − C = (bound − amount)·G − blinding·H
    proof.ranges[String(i)] = toBase64(proveRange(H, BigInt(bound - o.amount), mod(-scalarOf(o.blinding, "the blinding")), bits, rangeContext(digest, i)));
    await pause(); // let a server answer other requests between bids
  }
  return proof;
}

export interface FairnessVerdict {
  ok: boolean;
  /** Plain sentences; empty when everything checks out. */
  problems: string[];
  /** How many bids are on the board, and how many of them counted. */
  bids: number;
  counted: number;
}

/**
 * Checks a result against its proof. Runs anywhere, with only the public
 * statement and proof: no secret, no server.
 */
export async function verifyFairness(statement: FairnessStatement, proof: FairnessProof, onProgress?: (done: number, of: number) => void): Promise<FairnessVerdict> {
  const problems = shapeProblems(statement);
  const bids = Array.isArray(statement?.bids) ? statement.bids.length : 0;
  if (problems.length) return { ok: false, problems, bids, counted: 0 };
  const counted = statement.bids.filter((b) => b.status === "counted").length;
  if (!proof || typeof proof !== "object" || typeof proof.ranges !== "object" || proof.ranges === null) return { ok: false, problems: ["the proof is missing"], bids, counted };

  const H = blindingBase(statement.auction_id);
  const bits = rangeBits(statement.ceiling);
  const digest = statementBytes(statement);

  if (statement.sold) {
    const w = statement.bids[statement.winner!]!;
    if (typeof proof.winner_blinding !== "string" || !pedersenOpens(statement.auction_id, w.commitment, statement.price!, proof.winner_blinding))
      problems.push("the winning commitment does not hold the price");
  }

  const todo = statement.bids.map((b, i) => i).filter((i) => statement.bids[i]!.status === "counted" && !(statement.sold && i === statement.winner));
  let done = 0;
  for (const i of todo) {
    let fine = false;
    try {
      const C = RistrettoPoint.fromHex(statement.bids[i]!.commitment);
      const bound = fairnessBound(statement, i);
      const D = (bound === 0 ? RistrettoPoint.ZERO : G.multiplyUnsafe(BigInt(bound))).subtract(C);
      const encoded = proof.ranges[String(i)];
      fine = typeof encoded === "string" && verifyRange(H, D, bits, rangeContext(digest, i), fromBase64(encoded));
    } catch {
      fine = false;
    }
    if (!fine) {
      problems.push(
        statement.sold
          ? `bid #${i + 1} is not shown to be ${i < statement.winner! ? "lower than" : "no higher than"} the price`
          : `bid #${i + 1} is not shown to be below the reserve`,
      );
    }
    onProgress?.(++done, todo.length);
    await pause(); // keep a page responsive while it checks
  }
  // A proof for a bid that isn't being proven is a sign of a muddled statement.
  for (const key of Object.keys(proof.ranges)) if (!todo.includes(Number(key))) problems.push(`the proof has an entry for bid #${Number(key) + 1}, which needs none`);
  return { ok: problems.length === 0, problems, bids, counted };
}

/** SHA-256 over the board, in order: a short fingerprint a bidder can note down before the close. */
export async function boardFingerprint(auctionId: string, commitments: string[]): Promise<string> {
  const bytes = te.encode(["dark-vault/v2/board", auctionId, ...commitments].join("|"));
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)));
}
