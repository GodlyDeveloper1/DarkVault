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
// The commitments and the "at most K bits" proof themselves are in rangeproof.ts.
import { G, RistrettoPoint, assertAmount, blindingBase, concat, fromBase64, hexOf, mod, pause, pedersenOpens, proveRange, scalarOf, sha512, te, toBase64, validCommitment, verifyRange } from "./rangeproof";

export { newBlinding, pedersenCommit, pedersenOpens, validCommitment } from "./rangeproof";

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
  /**
   * The size of the proof's ranges: no counted bid is above it. For an auction
   * with a ceiling, the ceiling. For one without, the price (or, with no sale,
   * the reserve): nothing that counted was higher, and that is what is proven.
   */
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
