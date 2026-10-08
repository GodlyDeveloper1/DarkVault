import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BATCH_MAX_ORDER,
  batchBound,
  batchStatementOf,
  decideBatch,
  FEE_SHARE_FLOOR,
  newBlinding,
  pedersenCommit,
  planBatch,
  planBondSplit,
  proveBatch,
  unitLotKey,
  verifyBatch,
  type BatchProof,
  type BatchStatement,
  type Opening,
  type SealedBid,
} from "../src/index.ts";

const SALE = "00112233445566778899aabbccddeeff";
const RESERVE = 200_000;
const BOND = 50_000;

/** Orders placed in this order, each funded in full unless a deposit is given. `null`: never opened. */
function orders(amounts: (number | null | [number | null, number])[]): SealedBid[] {
  return amounts.map((a, order) => {
    const [amount, deposit] = Array.isArray(a) ? a : [a, Math.max(a ?? 0, RESERVE) + BOND];
    return { id: `o${order}`, order, deposit, ...(amount === null ? {} : { revealed: amount }) };
  });
}

/** Decides, then builds the public statement and the openings, as the site does. */
function sale(amounts: (number | null | [number | null, number])[], units: number) {
  const list = orders(amounts);
  const outcome = decideBatch(RESERVE, units, list, BOND);
  const openings: (Opening | undefined)[] = list.map((o) => (o.revealed === undefined ? undefined : { amount: o.revealed, blinding: newBlinding() }));
  const board = list.map((o, i) => ({ id: o.id, commitment: pedersenCommit(SALE, openings[i]?.amount ?? 1, openings[i]?.blinding ?? newBlinding()) }));
  const statement = batchStatementOf(SALE, RESERVE, units, board, outcome);
  return { list, outcome, openings, statement };
}

test("the highest orders win a unit each, and each pays what it offered", () => {
  const { outcome } = sale([300_000, 900_000, 500_000, 700_000, 250_000], 3);
  assert.equal(outcome.sold, true);
  assert.deepEqual(outcome.winners, [
    { id: "o1", price: 900_000 },
    { id: "o3", price: 700_000 },
    { id: "o2", price: 500_000 },
  ]);
  assert.equal(outcome.price, 500_000, "the public price is the lowest winning order");
  assert.equal(outcome.marginalId, "o2");
  assert.equal(outcome.standing.o0, "outbid");
  assert.equal(outcome.standing.o4, "outbid");
  assert.equal(outcome.standing.o1, "won");
});

test("of equal orders the earlier one wins", () => {
  const { outcome } = sale([400_000, 400_000, 400_000, 900_000], 2);
  assert.deepEqual(outcome.winners.map((w) => w.id), ["o3", "o0"]);
  assert.equal(outcome.marginalId, "o0");
  assert.equal(outcome.standing.o1, "outbid");
  assert.equal(outcome.standing.o2, "outbid");
});

test("fewer orders than units: every order at the lowest price or above wins, and units are left over", () => {
  const { outcome } = sale([300_000, 150_000, 250_000], 5);
  assert.deepEqual(outcome.winners.map((w) => w.id), ["o0", "o2"]);
  assert.equal(outcome.price, 250_000);
  assert.equal(outcome.standing.o1, "below-reserve");
});

test("an order placing another order can't change what anyone else pays", () => {
  const before = sale([900_000, 500_000, 300_000], 2).outcome;
  // A shill just under the top order: it wins a unit, and the top order still pays its own amount.
  const after = sale([900_000, 500_000, 300_000, 899_999], 2).outcome;
  assert.equal(before.winners.find((w) => w.id === "o0")!.price, 900_000);
  assert.equal(after.winners.find((w) => w.id === "o0")!.price, 900_000);
});

test("orders that don't count: unfunded, short, unopened, too large", () => {
  const { outcome } = sale(
    [
      [500_000, 0], // nothing deposited
      [500_000, 500_000], // the order is covered, the bond is not
      null, // funded, never opened
      [300_000, 100_000], // not even the lowest price
      [BATCH_MAX_ORDER + 1, BATCH_MAX_ORDER + 1 + BOND],
      250_000,
    ],
    3,
  );
  assert.equal(outcome.standing.o0, "no-deposit");
  assert.equal(outcome.standing.o1, "underfunded");
  assert.equal(outcome.standing.o2, "not-revealed");
  assert.equal(outcome.standing.o3, "underfunded");
  assert.equal(outcome.standing.o4, "over-ceiling");
  assert.deepEqual(outcome.winners, [{ id: "o5", price: 250_000 }]);
});

test("nothing sells when no order reaches the lowest price", () => {
  const { outcome } = sale([100_000, 150_000], 2);
  assert.equal(outcome.sold, false);
  assert.deepEqual(outcome.winners, []);
  assert.equal(outcome.price, undefined);
  assert.throws(() => decideBatch(RESERVE, 0, [], BOND));
});

test("the first payout: each winner's price and bond to that unit's escrow, change and refunds home, to the last zatoshi", () => {
  const list = orders([[900_000, 2_050_000], 500_000, 300_000, [700_000, 0]]);
  const outcome = decideBatch(RESERVE, 2, list, BOND);
  const depositors = list.filter((o) => o.deposit > 0).map((o) => ({ id: o.id, deposit: o.deposit, refundAddress: `refund-${o.id}` }));
  const payments = planBatch(SALE, depositors, outcome, { o0: "escrow-0", o1: "escrow-1" }, BOND);
  const to = (address: string) => payments.filter((p) => p.to === address).reduce((s, p) => s + p.zatoshis, 0);
  assert.equal(to("escrow-0"), 900_000 + BOND);
  assert.equal(to("escrow-1"), 500_000 + BOND);
  assert.equal(to("refund-o0"), 2_050_000 - 900_000 - BOND, "what the top order deposited above its price and bond");
  assert.equal(to("refund-o1"), 0, "an exact deposit leaves no change");
  assert.equal(to("refund-o2"), 300_000 + BOND, "a losing order gets everything back");
  assert.equal(
    payments.reduce((s, p) => s + p.zatoshis, 0),
    depositors.reduce((s, d) => s + d.deposit, 0),
  );
  // Nobody is paid the seller's share here: the price is held.
  assert.ok(!payments.some((p) => p.kind === "seller"));
  assert.throws(() => planBatch(SALE, depositors, outcome, { o0: "escrow-0" }, BOND), /no escrow/);
  assert.throws(() => planBatch(SALE, depositors.slice(1), outcome, { o0: "escrow-0", o1: "escrow-1" }, BOND), /no deposit/);
});

test("the first payout when nothing sold returns every deposit", () => {
  const list = orders([100_000, 150_000]);
  const outcome = decideBatch(RESERVE, 2, list, BOND);
  const depositors = list.map((o) => ({ id: o.id, deposit: o.deposit, refundAddress: `refund-${o.id}` }));
  const payments = planBatch(SALE, depositors, outcome, {}, BOND);
  assert.deepEqual(payments.map((p) => p.kind), ["refund", "refund"]);
});

test("the seller's bond is shared between the units that sold; the rest goes back", () => {
  const held = 5 * BOND;
  const split = planBondSplit(SALE, held, 5, "seller", ["e0", "e1", "e2"]);
  assert.deepEqual(split.map((p) => [p.to, p.zatoshis, p.unit]), [
    ["e0", BOND, 0],
    ["e1", BOND, 1],
    ["e2", BOND, 2],
    ["seller", 2 * BOND, null],
  ]);
  assert.ok(split.every((p) => p.pays_fee), "every part carries a share of the fee");
  assert.equal(split.reduce((s, p) => s + p.zatoshis, 0), held);

  // Every unit sold, and the seller put down a little more than asked: the odd zatoshis go back.
  const all = planBondSplit(SALE, 2 * BOND + 7, 2, "seller", ["e0", "e1"]);
  assert.deepEqual(all.map((p) => p.zatoshis), [BOND + 3, BOND + 3, 1]);
  assert.equal(all[2]!.pays_fee, false, "too small to carry a fee share");
  assert.ok(BOND >= FEE_SHARE_FLOOR);

  assert.deepEqual(planBondSplit(SALE, 0, 3, "seller", ["e0"]), [], "a sale without bonds has nothing to share");
  // A bond too small for a share to carry its part of the fee is not shared out: it goes back whole.
  assert.deepEqual(planBondSplit(SALE, 30_000, 2, "seller", ["e0", "e1"]).map((p) => [p.to, p.zatoshis, p.unit, p.pays_fee]), [["seller", 30_000, null, true]]);
  assert.deepEqual(planBondSplit(SALE, 399_980, 20, "seller", Array.from({ length: 20 }, (_, i) => `e${i}`)).map((p) => [p.to, p.zatoshis]), [["seller", 399_980]]);
  assert.throws(() => planBondSplit(SALE, 10_000, 2, "seller", ["e0", "e1"]), /too small/);
  // With nothing sold, whatever is held goes back, whatever its size.
  assert.deepEqual(planBondSplit(SALE, 30_000, 2, "seller", []).map((p) => [p.to, p.zatoshis]), [["seller", 30_000]]);
  assert.throws(() => planBondSplit(SALE, held, 2, "seller", ["e0", "e1", "e2"]), /more units sold/);
});

test("the proof checks out, and tells nothing but the lowest winning order", async () => {
  const { statement, openings, outcome } = sale([300_000, 900_000, 500_000, 700_000, 250_000, 150_000, [800_000, 0], null], 3);
  assert.deepEqual(statement.winners, [1, 2, 3]);
  assert.equal(statement.marginal, 2);
  assert.equal(statement.price, 500_000);
  assert.deepEqual(statement.bids.map((b) => b.status), ["counted", "counted", "counted", "counted", "counted", "counted", "no-deposit", "unopened"]);
  const proof = await proveBatch(statement, openings);
  const verdict = await verifyBatch(statement, proof);
  assert.deepEqual(verdict, { ok: true, problems: [], bids: 8, counted: 6, winners: 3 });
  // Published: one blinding (the lowest winner's) and range proofs. No amount but the price.
  const text = JSON.stringify({ statement, proof });
  for (const w of outcome.winners) if (w.price !== 500_000) assert.ok(!text.includes(String(w.price)));
  assert.equal(proof.marginal_blinding, openings[2]!.blinding);
  assert.deepEqual(Object.keys(proof.ranges).sort(), ["0", "1", "3", "4", "5"]);
});

test("what the result says about each order, by where it sits on the board", () => {
  // Equal orders at 400,000: positions 0 and 2 win (with 3, higher), 4 is too late.
  const { statement } = sale([400_000, 300_000, 400_000, 900_000, 400_000], 3);
  assert.deepEqual(statement.winners, [0, 2, 3]);
  assert.equal(statement.marginal, 2);
  assert.deepEqual(batchBound(statement, 0), { side: "at-least", bound: 400_000 });
  assert.deepEqual(batchBound(statement, 3), { side: "at-least", bound: 400_001 }, "a winner placed after the lowest winner offered more than it");
  assert.deepEqual(batchBound(statement, 1), { side: "at-most", bound: 399_999 }, "an order placed before the lowest winner offered less than it");
  assert.deepEqual(batchBound(statement, 4), { side: "at-most", bound: 400_000 });
});

test("the proof holds with equal orders, with units left over and with nothing sold", async () => {
  for (const [amounts, units] of [
    [[400_000, 300_000, 400_000, 900_000, 400_000], 3],
    [[300_000, 150_000, 250_000], 5],
    [[100_000, 150_000], 2],
    [[250_000], 1],
    [[], 4],
  ] as [number[], number][]) {
    const { statement, openings } = sale(amounts, units);
    const verdict = await verifyBatch(statement, await proveBatch(statement, openings));
    assert.deepEqual(verdict.problems, []);
  }
});

test("a false result can't be proven", async () => {
  const { statement, openings } = sale([300_000, 900_000, 500_000, 700_000], 2);
  assert.deepEqual(statement.winners, [1, 3]);
  // The site would like its friend at position 0 to have won in place of position 3.
  const friend: BatchStatement = { ...statement, winners: [0, 1], marginal: 0, price: 300_000 };
  await assert.rejects(proveBatch(friend, openings), /not true/);
  // Or to hand out one unit fewer than it should.
  const fewer: BatchStatement = { ...statement, winners: [1], marginal: 1, price: 900_000 };
  await assert.rejects(proveBatch(fewer, openings), /not true/);
  // Or to publish a price that is not the lowest winning order.
  const dearer: BatchStatement = { ...statement, price: 800_000 };
  await assert.rejects(proveBatch(dearer, openings), /not the price/);
  // Or to name the wrong order as the lowest winner.
  const wrongMarginal: BatchStatement = { ...statement, marginal: 1, price: 900_000 };
  await assert.rejects(proveBatch(wrongMarginal, openings), /not true/);
});

test("a tie can't be turned around", async () => {
  const { statement, openings } = sale([400_000, 400_000, 900_000], 2);
  assert.deepEqual(statement.winners, [0, 2]);
  const later: BatchStatement = { ...statement, winners: [1, 2], marginal: 1 };
  await assert.rejects(proveBatch(later, openings), /not true/);
});

test("a proof made for one result does not pass for another", async () => {
  const { statement, openings } = sale([300_000, 900_000, 500_000, 700_000, 250_000], 3);
  const proof = await proveBatch(statement, openings);
  const check = async (s: BatchStatement, p: BatchProof = proof) => (await verifyBatch(s, p)).ok;
  assert.ok(await check(statement));
  assert.ok(!(await check({ ...statement, price: 500_001 })));
  assert.ok(!(await check({ ...statement, units: 4 })));
  assert.ok(!(await check({ ...statement, reserve: RESERVE + 1 })));
  assert.ok(!(await check({ ...statement, winners: [0, 1, 3], marginal: 0, price: 300_000 })));
  assert.ok(!(await check({ ...statement, bids: statement.bids.map((b, i) => (i === 4 ? { ...b, status: "no-deposit" as const } : b)) })), "an order can't be dropped from the count afterwards");
  assert.ok(!(await check(statement, { ...proof, marginal_blinding: newBlinding() })));
  assert.ok(!(await check(statement, { ...proof, ranges: { ...proof.ranges, "0": proof.ranges["4"]! } })), "one order's proof does not stand in for another's");
  const { "4": _dropped, ...rest } = proof.ranges;
  assert.ok(!(await check(statement, { ...proof, ranges: rest })), "a counted order with no proof");
  assert.ok(!(await check(statement, { ...proof, ranges: { ...proof.ranges, "2": proof.ranges["0"]! } })), "an entry the result needs none for");
  assert.ok(!(await check({ ...statement, auction_id: "ffeeddccbbaa99887766554433221100" })));
});

test("malformed statements are refused in plain words", async () => {
  const { statement, openings } = sale([300_000, 900_000], 2);
  const proof = await proveBatch(statement, openings);
  const problems = async (s: unknown) => (await verifyBatch(s as BatchStatement, proof)).problems;
  assert.match((await problems({ ...statement, v: 2 }))[0]!, /not a batch sale/);
  assert.match((await problems({ ...statement, winners: [1, 0] }))[0]!, /not distinct orders/);
  assert.match((await problems({ ...statement, winners: [0, 1, 1] })).join(" "), /not distinct orders/);
  assert.match((await problems({ ...statement, units: 1 })).join(" "), /more orders won than there were units/);
  assert.match((await problems({ ...statement, marginal: null })).join(" "), /lowest winning order is not one of the winners/);
  assert.match((await problems({ ...statement, winners: [], marginal: null })).join(" "), /can't have a price/);
  assert.match((await problems({ ...statement, price: BATCH_MAX_ORDER + 1 })).join(" "), /outside what an order can be/);
  assert.equal((await verifyBatch(statement, null as unknown as BatchProof)).problems[0], "the proof is missing");
});

test("the largest order allowed fits the proof", async () => {
  const list: SealedBid[] = [
    { id: "a", order: 0, deposit: BATCH_MAX_ORDER + BOND, revealed: BATCH_MAX_ORDER },
    { id: "b", order: 1, deposit: RESERVE + BOND, revealed: RESERVE },
  ];
  const outcome = decideBatch(RESERVE, 2, list, BOND);
  const openings = list.map((o) => ({ amount: o.revealed!, blinding: newBlinding() }));
  const board = list.map((o, i) => ({ id: o.id, commitment: pedersenCommit(SALE, openings[i]!.amount, openings[i]!.blinding) }));
  const statement = batchStatementOf(SALE, RESERVE, 2, board, outcome);
  assert.equal(statement.marginal, 1);
  assert.ok((await verifyBatch(statement, await proveBatch(statement, openings))).ok);
});

test("each unit has its own lot key", async () => {
  const manage = "ab".repeat(32);
  const a = await unitLotKey(manage, 0);
  const b = await unitLotKey(manage, 1);
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
  assert.deepEqual(a, await unitLotKey(manage, 0));
  assert.notDeepEqual(a, await unitLotKey("cd".repeat(32), 0));
  await assert.rejects(unitLotKey(manage, -1));
  await assert.rejects(unitLotKey("short", 0));
});
