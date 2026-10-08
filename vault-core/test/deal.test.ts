import assert from "node:assert/strict";
import { test } from "node:test";
import { bondFor, decideDeal, plan, planEscrowPayout } from "../src/index.ts";

const PRICE = 2_000_000;
const BOND = bondFor(PRICE);
const id = "ab".repeat(16);

test("a deal is taken by the first payment that covers the price and the bond", () => {
  const o = decideDeal(PRICE, [{ id: "a", order: 0, deposit: PRICE + BOND }], BOND);
  assert.equal(o.sold, true);
  assert.equal(o.winnerId, "a");
  assert.equal(o.price, PRICE);
});

test("a deal nobody paid for is not settled", () => {
  assert.equal(decideDeal(PRICE, [], BOND).sold, false);
  const o = decideDeal(PRICE, [{ id: "a", order: 0, deposit: 0 }], BOND);
  assert.equal(o.sold, false);
  assert.equal(o.standing.a, "no-deposit");
});

test("a payment one zatoshi short, or without the bond, does not take the deal", () => {
  const short = decideDeal(PRICE, [{ id: "a", order: 0, deposit: PRICE + BOND - 1 }], BOND);
  assert.equal(short.sold, false);
  assert.equal(short.standing.a, "underfunded");
  assert.equal(decideDeal(PRICE, [{ id: "a", order: 0, deposit: PRICE }], BOND).sold, false);
});

test("of two full payments the earlier takes the deal and the other is returned", () => {
  const o = decideDeal(
    PRICE,
    [
      { id: "late", order: 1, deposit: PRICE + BOND },
      { id: "early", order: 0, deposit: PRICE + BOND },
      { id: "short", order: 2, deposit: PRICE },
    ],
    BOND,
  );
  assert.equal(o.winnerId, "early");
  assert.equal(o.standing.late, "outbid");
  assert.equal(o.standing.short, "underfunded");
  // The plan pays out every zatoshi that came in: the price and bond to escrow, the rest back.
  const depositors = [
    { id: "early", deposit: PRICE + BOND, refundAddress: "utest1early" },
    { id: "late", deposit: PRICE + BOND, refundAddress: "utest1late" },
    { id: "short", deposit: PRICE, refundAddress: "utest1short" },
  ];
  const payments = plan(id, "utest1seller", depositors, o, "utest1escrow", BOND);
  assert.equal(
    payments.reduce((s, p) => s + p.zatoshis, 0),
    depositors.reduce((s, d) => s + d.deposit, 0),
  );
  assert.equal(payments.find((p) => p.kind === "escrow")?.zatoshis, PRICE + BOND);
  assert.equal(payments.find((p) => p.bidId === "late")?.zatoshis, PRICE + BOND);
  assert.equal(payments.find((p) => p.bidId === "short")?.zatoshis, PRICE);
  assert.ok(!payments.some((p) => p.kind === "seller"));
});

test("paying more than asked still pays only the price: the rest comes back", () => {
  const o = decideDeal(PRICE, [{ id: "a", order: 0, deposit: PRICE + BOND + 700_000 }], BOND);
  assert.equal(o.price, PRICE);
  const payments = plan(id, "utest1seller", [{ id: "a", deposit: PRICE + BOND + 700_000, refundAddress: "utest1a" }], o, "utest1escrow", BOND);
  assert.equal(payments.find((p) => p.kind === "winner-change")?.zatoshis, 700_000);
});

test("a completed deal releases the price to the seller and returns both bonds", () => {
  const total = PRICE + BOND + BOND;
  const payments = planEscrowPayout(id, { total, sellerBond: BOND, buyerBond: BOND }, "release", "none", "utest1seller", { bidId: "a", refundAddress: "utest1a" });
  assert.equal(payments.reduce((s, p) => s + p.zatoshis, 0), total);
  assert.equal(payments.find((p) => p.kind === "seller")?.zatoshis, PRICE + BOND);
  assert.equal(payments.find((p) => p.kind === "escrow-refund")?.zatoshis, BOND);
});

test("a price below the smallest amount is refused", () => {
  assert.throws(() => decideDeal(10, [], 0));
});
