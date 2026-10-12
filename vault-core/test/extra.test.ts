// Only the bond asked for is ever at stake: whatever a seller sends above it comes back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { planBondSplit, planEscrowPayout } from "../src/index.ts";

const A = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const winner = { bidId: "w", refundAddress: "utest1winner" };
const sum = (ps: { zatoshis: number }[]) => ps.reduce((s, p) => s + p.zatoshis, 0);
const to = (ps: { to: string; zatoshis: number }[], who: string) => ps.filter((p) => p.to === who).reduce((s, p) => s + p.zatoshis, 0);

// Price 300,000, seller asked for 100,000 but sent 250,000, winner's bond 50,000.
const held = { total: 300_000 + 100_000 + 150_000 + 50_000, sellerBond: 100_000, sellerExtra: 150_000, buyerBond: 50_000 };

test("a seller's extra goes back on a release", () => {
  const p = planEscrowPayout(A, held, "release", "none", "utest1seller", winner);
  assert.equal(to(p, "utest1seller"), 300_000 + 100_000 + 150_000);
  assert.equal(to(p, "utest1winner"), 50_000);
  assert.equal(sum(p), held.total);
});

test("a seller at fault loses the bond asked for, never the extra", () => {
  const p = planEscrowPayout(A, held, "refund", "seller", "utest1seller", winner);
  assert.equal(to(p, "utest1winner"), 300_000 + 50_000 + 100_000, "price, own bond, and only the bond asked for");
  assert.equal(to(p, "utest1seller"), 150_000, "the extra comes back to the seller");
  assert.ok(p.find((x) => x.to === "utest1seller")!.memo.includes("above your bond"));
  assert.equal(sum(p), held.total);
});

test("a winner at fault: the seller gets the winner's bond and keeps the extra", () => {
  const p = planEscrowPayout(A, held, "release", "winner", "utest1seller", winner);
  assert.equal(to(p, "utest1seller"), held.total);
  const r = planEscrowPayout(A, held, "refund", "winner", "utest1seller", winner);
  assert.equal(to(r, "utest1winner"), 300_000);
  assert.equal(to(r, "utest1seller"), 100_000 + 150_000 + 50_000);
});

test("no extra: the payout is what it always was", () => {
  const plain = { total: 450_000, sellerBond: 100_000, buyerBond: 50_000 };
  const p = planEscrowPayout(A, plain, "refund", "seller", "utest1seller", winner);
  assert.equal(to(p, "utest1winner"), 450_000);
  assert.equal(to(p, "utest1seller"), 0);
});

test("Order Flow: a unit's share is never more than its part of the bond asked for", () => {
  // Asked 200,000 for 2 units; the seller sent 500,000.
  const split = planBondSplit(A, 500_000, 2, "utest1seller", ["e0", "e1"], 200_000);
  assert.deepEqual(split.map((p) => [p.to, p.zatoshis]), [["e0", 100_000], ["e1", 100_000], ["utest1seller", 300_000]]);
  // Without the asked amount (old records), everything is shared as before.
  assert.deepEqual(planBondSplit(A, 500_000, 2, "utest1seller", ["e0", "e1"]).map((p) => p.zatoshis), [250_000, 250_000]);
  // Less than asked (it can't happen once a sale is open, but the plan still adds up).
  assert.equal(sum(planBondSplit(A, 150_000, 2, "utest1seller", ["e0", "e1"], 200_000)), 150_000);
});

test("a split shares the price; both bonds go back; the larger part carries the fee", () => {
  const h = { total: 400_000 + 50_000 + 50_000, sellerBond: 50_000, buyerBond: 50_000, winnerPercent: 30 };
  const p = planEscrowPayout(A, h, "split", "none", "utest1seller", winner);
  assert.equal(to(p, "utest1winner"), 120_000 + 50_000);
  assert.equal(to(p, "utest1seller"), 280_000 + 50_000);
  assert.equal(sum(p), h.total);
  assert.equal(p.find((x) => x.to === "utest1seller")!.pays_fee, true);
  assert.equal(p.find((x) => x.to === "utest1winner")!.pays_fee, false);
  const q = planEscrowPayout(A, { ...h, winnerPercent: 80 }, "split", "none", "utest1seller", winner);
  assert.equal(q.find((x) => x.to === "utest1winner")!.pays_fee, true, "the winner gets the larger part and carries the fee");
  // With a seller's extra, it still goes back to the seller.
  const e = planEscrowPayout(A, { ...h, total: h.total + 70_000, sellerExtra: 70_000 }, "split", "none", "utest1seller", winner);
  assert.equal(to(e, "utest1seller"), 280_000 + 50_000 + 70_000);
  assert.throws(() => planEscrowPayout(A, { ...h, winnerPercent: 0 }, "split", "none", "utest1seller", winner), /1% to 99%/);
  assert.throws(() => planEscrowPayout(A, h, "split", "seller", "utest1seller", winner), /nobody is at fault/);
});
