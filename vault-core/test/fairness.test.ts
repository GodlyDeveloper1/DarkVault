import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boardFingerprint,
  fairnessBound,
  newBlinding,
  pedersenCommit,
  pedersenOpens,
  proveFairness,
  rangeBits,
  validCommitment,
  verifyFairness,
  type BoardStatus,
  type FairnessProof,
  type FairnessStatement,
  type Opening,
} from "../src/index.ts";

const AUCTION = "00112233445566778899aabbccddeeff";
const OTHER = "ffeeddccbbaa99887766554433221100";

/** Builds a board from (amount, status) pairs and returns the statement with its openings. */
function board(entries: [number, BoardStatus?][], result: { sold: boolean; price?: number; winner?: number }, reserve = 200_000, ceiling = 1_000_000) {
  const openings: Opening[] = entries.map(([amount]) => ({ amount, blinding: newBlinding() }));
  const statement: FairnessStatement = {
    v: 2,
    auction_id: AUCTION,
    reserve,
    ceiling,
    bids: entries.map(([, status], i) => ({ commitment: pedersenCommit(AUCTION, openings[i]!.amount, openings[i]!.blinding), status: status ?? "counted" })),
    sold: result.sold,
    price: result.price ?? null,
    winner: result.winner ?? null,
  };
  return { statement, openings };
}

test("a commitment hides the amount, opens only to it, and is tied to its auction", () => {
  const r = newBlinding();
  const c = pedersenCommit(AUCTION, 800_000, r);
  assert.match(c, /^[0-9a-f]{64}$/);
  assert.ok(validCommitment(c));
  assert.equal(c, pedersenCommit(AUCTION, 800_000, r));
  assert.ok(pedersenOpens(AUCTION, c, 800_000, r));
  assert.ok(!pedersenOpens(AUCTION, c, 800_001, r));
  assert.ok(!pedersenOpens(AUCTION, c, 800_000, newBlinding()));
  assert.ok(!pedersenOpens(OTHER, c, 800_000, r), "another auction has another base point");
  // The same amount twice gives unrelated commitments: nothing to compare or guess from.
  assert.notEqual(c, pedersenCommit(AUCTION, 800_000, newBlinding()));
  assert.ok(!validCommitment("zz".repeat(32)));
  assert.ok(!validCommitment("ff".repeat(32)), "not every 32 bytes is a group element");
  assert.ok(!pedersenOpens(AUCTION, c, 800_000, "ff".repeat(32)), "a blinding must be below the group order");
  assert.equal(pedersenCommit(AUCTION, 0, r).length, 64);
});

test("the number of bits covers the ceiling", () => {
  assert.equal(rangeBits(1), 1);
  assert.equal(rangeBits(255), 8);
  assert.equal(rangeBits(256), 9);
  assert.equal(rangeBits(5_000_000), 23);
});

test("an honest result verifies, with the losing bids kept hidden", async () => {
  const { statement, openings } = board([[400_000], [800_000], [650_000], [800_000], [0, "no-deposit"], [900_000, "underfunded"], [5, "unopened"]], { sold: true, price: 800_000, winner: 1 });
  const proof = await proveFairness(statement, openings);
  const verdict = await verifyFairness(statement, proof);
  assert.deepEqual(verdict, { ok: true, problems: [], bids: 7, counted: 4 });
  // The proof names the price and nothing else: no losing amount, no losing blinding.
  const text = JSON.stringify(proof);
  for (const o of [openings[0]!, openings[2]!, openings[3]!]) {
    assert.ok(!text.includes(o.blinding));
    assert.ok(!text.includes(String(o.amount)));
  }
  assert.equal(proof.winner_blinding, openings[1]!.blinding);
  assert.deepEqual(Object.keys(proof.ranges).sort(), ["0", "2", "3"], "one range proof per counted loser, none for the winner or the excluded");
  // Bounds: an equal bid placed later may equal the price; one placed earlier must be strictly lower.
  assert.equal(fairnessBound(statement, 0), 799_999);
  assert.equal(fairnessBound(statement, 3), 800_000);
});

test("an honest no-sale verifies: every counted bid is below the reserve", async () => {
  const { statement, openings } = board([[150_000], [199_999]], { sold: false });
  const proof = await proveFairness(statement, openings);
  assert.equal(proof.winner_blinding, null);
  assert.equal((await verifyFairness(statement, proof)).ok, true);
});

test("a single bid, and a board with no bids, verify", async () => {
  const one = board([[300_000]], { sold: true, price: 300_000, winner: 0 });
  assert.equal((await verifyFairness(one.statement, await proveFairness(one.statement, one.openings))).ok, true);
  const none = board([], { sold: false });
  assert.equal((await verifyFairness(none.statement, await proveFairness(none.statement, none.openings))).ok, true);
});

test("no proof can be made for a false result", async () => {
  const cases: [string, ReturnType<typeof board>][] = [
    ["a lower bid declared the winner", board([[400_000], [800_000], [650_000]], { sold: true, price: 650_000, winner: 2 })],
    ["a later tied bid declared the winner", board([[800_000], [800_000]], { sold: true, price: 800_000, winner: 1 })],
    ["the winner charged less than they bid", board([[400_000], [800_000]], { sold: true, price: 700_000, winner: 1 })],
    ["the winner charged more than they bid", board([[400_000], [800_000]], { sold: true, price: 900_000, winner: 1 })],
    ["declared unsold though a bid met the reserve", board([[400_000], [150_000]], { sold: false })],
  ];
  for (const [name, { statement, openings }] of cases) await assert.rejects(() => proveFairness(statement, openings), /not true|not the price/, name);
});

test("a cheating coordinator can't reuse or bend an honest proof", async () => {
  const { statement, openings } = board([[400_000], [800_000], [650_000]], { sold: true, price: 800_000, winner: 1 });
  const proof = await proveFairness(statement, openings);
  const check = async (s: FairnessStatement, p: FairnessProof) => (await verifyFairness(s, p)).ok;
  assert.equal(await check(statement, proof), true);
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

  // Claim a lower price for the same board.
  assert.equal(await check({ ...statement, price: 700_000 }, proof), false);
  // Claim another winner.
  assert.equal(await check({ ...statement, winner: 2 }, proof), false);
  // Quietly drop a bid from the board.
  assert.equal(await check({ ...statement, bids: statement.bids.slice(0, 2) }, proof), false);
  // Swap one bid's commitment for another.
  const swapped = clone(statement);
  swapped.bids[2]!.commitment = pedersenCommit(AUCTION, 1, newBlinding());
  assert.equal(await check(swapped, proof), false);
  // Mark a counted bid as excluded but keep its proof, or drop its proof.
  const excluded = clone(statement);
  excluded.bids[0]!.status = "unopened";
  assert.equal(await check(excluded, proof), false, "a leftover proof entry is flagged");
  const missing = clone(proof);
  delete missing.ranges["2"];
  assert.equal(await check(statement, missing), false);
  // Use bid #1's proof for bid #3.
  const crossed = clone(proof);
  crossed.ranges["2"] = proof.ranges["0"]!;
  assert.equal(await check(statement, crossed), false);
  // Flip one bit anywhere in a range proof.
  const raw = Buffer.from(proof.ranges["0"]!, "base64");
  for (const at of [0, 40, 70, 100, 140, raw.length - 1]) {
    const bent = clone(proof);
    const copy = Buffer.from(raw);
    copy[at]! ^= 1;
    bent.ranges["0"] = copy.toString("base64");
    assert.equal(await check(statement, bent), false, `byte ${at}`);
  }
  // A wrong winner blinding, a truncated proof, the proof of another auction.
  assert.equal(await check(statement, { ...proof, winner_blinding: newBlinding() }), false);
  assert.equal(await check(statement, { ...proof, ranges: { ...proof.ranges, "0": raw.subarray(0, raw.length - 160).toString("base64") } }), false);
  assert.equal(await check({ ...statement, auction_id: OTHER }, proof), false);
  assert.equal(await check(statement, null as unknown as FairnessProof), false);
});

test("a forged range proof for a bid above the price is rejected", async () => {
  // The coordinator wants bid #1 (900,000) to lose to bid #2 (800,000). It can't prove 900,000 ≤ 800,000,
  // so it tries the proof it could make if bid #1 were 700,000.
  const honest = board([[700_000], [800_000]], { sold: true, price: 800_000, winner: 1 });
  const proof = await proveFairness(honest.statement, honest.openings);
  const forged: FairnessStatement = JSON.parse(JSON.stringify(honest.statement));
  forged.bids[0]!.commitment = pedersenCommit(AUCTION, 900_000, honest.openings[0]!.blinding);
  const verdict = await verifyFairness(forged, proof);
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join(" "), /bid #1 is not shown to be lower than the price/);
});

test("malformed statements are refused with a reason", async () => {
  const { statement, openings } = board([[400_000], [800_000]], { sold: true, price: 800_000, winner: 1 });
  const proof = await proveFairness(statement, openings);
  const bad = async (change: Partial<FairnessStatement>) => (await verifyFairness({ ...statement, ...change }, proof)).problems.join(" ");
  assert.match(await bad({ price: 100_000 }), /outside the reserve/);
  assert.match(await bad({ price: 2_000_000 }), /outside the reserve/);
  assert.match(await bad({ winner: 5 }), /winner is not a counted bid/);
  assert.match(await bad({ sold: false }), /unsold lot can't have a price/);
  assert.match(await bad({ bids: [statement.bids[0]!, statement.bids[0]!] }), /repeats an earlier commitment/);
  assert.match(await bad({ ceiling: 100 }), /make no sense/);
  assert.match(await bad({ v: 1 as 2 }), /not a fairness statement/);
});

test("the board fingerprint changes with any change to the board", async () => {
  const a = pedersenCommit(AUCTION, 1, newBlinding()), b = pedersenCommit(AUCTION, 2, newBlinding());
  const f = await boardFingerprint(AUCTION, [a, b]);
  assert.match(f, /^[0-9a-f]{64}$/);
  assert.equal(f, await boardFingerprint(AUCTION, [a, b]));
  assert.notEqual(f, await boardFingerprint(AUCTION, [b, a]));
  assert.notEqual(f, await boardFingerprint(AUCTION, [a]));
  assert.notEqual(f, await boardFingerprint(OTHER, [a, b]));
});

test("sixteen bids at a 0.05 TAZ ceiling: size and time", async () => {
  const entries: [number][] = Array.from({ length: 16 }, (_, i) => [300_000 + i * 100_000]);
  const { statement, openings } = board(entries, { sold: true, price: 1_800_000, winner: 15 }, 200_000, 5_000_000);
  let t = Date.now();
  const proof = await proveFairness(statement, openings);
  const proveMs = Date.now() - t;
  t = Date.now();
  const verdict = await verifyFairness(statement, proof);
  const verifyMs = Date.now() - t;
  assert.equal(verdict.ok, true);
  console.log(`      16 bids, 23 bits each: proof ${JSON.stringify(proof).length} bytes, made in ${proveMs} ms, checked in ${verifyMs} ms`);
});
