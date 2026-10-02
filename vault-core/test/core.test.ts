import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commit,
  decide,
  FEE_SHARE_FLOOR,
  formatCoins,
  newId,
  newNonce,
  opens,
  parseCoins,
  plan,
  settlementFee,
  type Depositor,
  type SealedBid,
} from "../src/index.ts";

const AUCTION = "00112233445566778899aabbccddeeff";
const NONCE = "ab".repeat(32);

test("a commitment is deterministic and matches a hand-built SHA-256", async () => {
  const c = await commit(AUCTION, 5_000_000, NONCE);
  assert.match(c, /^[0-9a-f]{64}$/);
  assert.equal(c, await commit(AUCTION, 5_000_000, NONCE));

  // The same bytes, assembled independently.
  const { createHash } = await import("node:crypto");
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64BE(5_000_000n);
  const expected = createHash("sha256")
    .update(Buffer.concat([Buffer.from("dark-vault/v1/bid"), Buffer.from([0]), Buffer.from(AUCTION, "hex"), amount, Buffer.from(NONCE, "hex")]))
    .digest("hex");
  assert.equal(c, expected);
});

test("a commitment changes with the amount, the nonce and the auction", async () => {
  const base = await commit(AUCTION, 5_000_000, NONCE);
  assert.notEqual(base, await commit(AUCTION, 5_000_001, NONCE));
  assert.notEqual(base, await commit(AUCTION, 5_000_000, "cd".repeat(32)));
  assert.notEqual(base, await commit("ff".repeat(16), 5_000_000, NONCE));
});

test("only the right amount and nonce open a commitment", async () => {
  const nonce = newNonce();
  const c = await commit(AUCTION, 1_234_567, nonce);
  assert.equal(await opens(AUCTION, c, 1_234_567, nonce), true);
  assert.equal(await opens(AUCTION, c, 1_234_568, nonce), false);
  assert.equal(await opens(AUCTION, c, 1_234_567, newNonce()), false);
  assert.equal(await opens("ff".repeat(16), c, 1_234_567, nonce), false);
  assert.equal(await opens(AUCTION, c, 1_234_567, "not hex"), false);
  assert.equal(await opens(AUCTION, c, -1, nonce), false);
});

test("nonces and ids are fresh each time", () => {
  assert.notEqual(newNonce(), newNonce());
  assert.match(newNonce(), /^[0-9a-f]{64}$/);
  assert.match(newId(), /^[0-9a-f]{32}$/);
});

test("commit refuses malformed input", async () => {
  await assert.rejects(commit("short", 1, NONCE));
  await assert.rejects(commit(AUCTION, 1.5, NONCE));
  await assert.rejects(commit(AUCTION, 1, "abc"));
});

const bid = (id: string, order: number, deposit: number, revealed?: number): SealedBid => ({ id, order, deposit, revealed });

test("the highest bid wins and pays the second-highest", () => {
  const o = decide(100_000, [bid("a", 0, 900_000, 800_000), bid("b", 1, 600_000, 500_000), bid("c", 2, 300_000, 300_000)]);
  assert.equal(o.sold, true);
  assert.equal(o.winnerId, "a");
  assert.equal(o.price, 500_000);
  assert.equal(o.priceSetBy, "b");
  assert.deepEqual(o.standing, { a: "won", b: "outbid", c: "outbid" });
});

test("a single bid pays the reserve", () => {
  const o = decide(250_000, [bid("a", 0, 900_000, 800_000)]);
  assert.equal(o.price, 250_000);
  assert.equal(o.priceSetBy, undefined);
});

test("a second bid below the reserve does not set the price", () => {
  const o = decide(250_000, [bid("a", 0, 900_000, 800_000), bid("b", 1, 200_000, 200_000)]);
  assert.equal(o.winnerId, "a");
  assert.equal(o.price, 250_000);
  assert.equal(o.standing.b, "below-reserve");
});

test("no bid at or above the reserve means no sale", () => {
  const o = decide(500_000, [bid("a", 0, 400_000, 400_000), bid("b", 1, 300_000, 300_000)]);
  assert.equal(o.sold, false);
  assert.equal(o.winnerId, undefined);
});

test("a tie goes to the earlier deposit, at the tied price", () => {
  const o = decide(100_000, [bid("late", 5, 700_000, 700_000), bid("early", 2, 700_000, 700_000)]);
  assert.equal(o.winnerId, "early");
  assert.equal(o.price, 700_000);
});

test("bids that were not revealed, not funded or underfunded do not count", () => {
  const o = decide(100_000, [
    bid("unrevealed", 0, 2_000_000),
    bid("nodeposit", 1, 0, 1_500_000),
    bid("underfunded", 2, 500_000, 900_000),
    bid("honest", 3, 400_000, 350_000),
  ]);
  assert.equal(o.winnerId, "honest");
  assert.equal(o.price, 100_000);
  assert.deepEqual(o.standing, { unrevealed: "not-revealed", nodeposit: "no-deposit", underfunded: "underfunded", honest: "won" });
});

test("bidding your true value is never beaten by bidding lower (second price)", () => {
  // Against a rival at 500k, a bidder who values the lot at 800k pays 500k
  // whether they bid 800k or 600k, and loses the lot if they bid 400k.
  const rival = bid("rival", 0, 500_000, 500_000);
  assert.equal(decide(100_000, [rival, bid("me", 1, 800_000, 800_000)]).price, 500_000);
  assert.equal(decide(100_000, [rival, bid("me", 1, 800_000, 600_000)]).price, 500_000);
  assert.equal(decide(100_000, [rival, bid("me", 1, 800_000, 400_000)]).winnerId, "rival");
});

const who = (id: string, deposit: number): Depositor => ({ id, deposit, refundAddress: `utest1refund${id}` });
const sum = (xs: { zatoshis: number }[]) => xs.reduce((s, x) => s + x.zatoshis, 0);

test("a sale pays the seller the price, the winner their excess and everyone else in full", () => {
  const depositors = [who("a", 900_000), who("b", 600_000), who("c", 300_000)];
  const outcome = decide(100_000, [bid("a", 0, 900_000, 800_000), bid("b", 1, 600_000, 500_000), bid("c", 2, 300_000, 300_000)]);
  const p = plan(AUCTION, "utest1seller", depositors, outcome);
  assert.deepEqual(
    p.map((x) => [x.kind, x.to, x.zatoshis]),
    [
      ["seller", "utest1seller", 500_000],
      ["winner-change", "utest1refunda", 400_000],
      ["refund", "utest1refundb", 600_000],
      ["refund", "utest1refundc", 300_000],
    ],
  );
  assert.equal(sum(p), 1_800_000);
  assert.ok(p.every((x) => x.pays_fee));
});

test("no sale returns every deposit in full", () => {
  const depositors = [who("a", 400_000), who("b", 300_000)];
  const outcome = decide(500_000, [bid("a", 0, 400_000, 400_000), bid("b", 1, 300_000, 300_000)]);
  const p = plan(AUCTION, "utest1seller", depositors, outcome);
  assert.deepEqual(p.map((x) => [x.kind, x.zatoshis]), [["refund", 400_000], ["refund", 300_000]]);
});

test("a winner who deposited exactly the price gets no change payment", () => {
  const outcome = decide(100_000, [bid("a", 0, 500_000, 500_000), bid("b", 1, 500_000, 500_000)]);
  const p = plan(AUCTION, "utest1seller", [who("a", 500_000), who("b", 500_000)], outcome);
  assert.deepEqual(p.map((x) => x.kind), ["seller", "refund"]);
  assert.equal(sum(p), 1_000_000);
});

test("a tiny change payment is paid in full and carries no fee share", () => {
  const outcome = decide(100_000, [bid("a", 0, 500_001, 500_001), bid("b", 1, 500_000, 500_000)]);
  const p = plan(AUCTION, "utest1seller", [who("a", 500_001), who("b", 500_000)], outcome);
  const change = p.find((x) => x.kind === "winner-change")!;
  assert.equal(change.zatoshis, 1);
  assert.equal(change.pays_fee, false);
  assert.ok(change.zatoshis < FEE_SHARE_FLOOR);
});

test("bids that did not count are still refunded in full", () => {
  const depositors = [who("unrevealed", 2_000_000), who("underfunded", 500_000), who("honest", 400_000)];
  const outcome = decide(100_000, [bid("unrevealed", 0, 2_000_000), bid("underfunded", 1, 500_000, 900_000), bid("honest", 2, 400_000, 350_000)]);
  const p = plan(AUCTION, "utest1seller", depositors, outcome);
  assert.equal(p.find((x) => x.bidId === "unrevealed")!.zatoshis, 2_000_000);
  assert.equal(p.find((x) => x.bidId === "underfunded")!.zatoshis, 500_000);
  assert.equal(sum(p), 2_900_000);
});

test("the plan always pays out exactly what was deposited", () => {
  // Many random auctions: whatever happens, deposits in equals payments out.
  let seed = 42;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
  for (let round = 0; round < 500; round++) {
    const n = 1 + rnd(8);
    const bids: SealedBid[] = [];
    const depositors: Depositor[] = [];
    for (let i = 0; i < n; i++) {
      const deposit = rnd(4) === 0 ? 0 : 100_000 + rnd(5_000_000);
      const revealed = rnd(5) === 0 ? undefined : rnd(6) === 0 ? deposit + 1 + rnd(1000) : Math.max(0, deposit - rnd(200_000));
      bids.push(bid(`b${i}`, i, deposit, revealed));
      if (deposit > 0) depositors.push(who(`b${i}`, deposit));
    }
    const outcome = decide(100_000 + rnd(1_000_000), bids);
    const total = depositors.reduce((s, d) => s + d.deposit, 0);
    if (total === 0) continue;
    const p = plan(AUCTION, "utest1seller", depositors, outcome);
    assert.equal(sum(p), total);
    if (outcome.sold) {
      assert.equal(p[0]!.kind, "seller");
      assert.equal(p[0]!.zatoshis, outcome.price);
      const winnerDeposit = depositors.find((d) => d.id === outcome.winnerId)!.deposit;
      assert.ok(outcome.price! <= winnerDeposit);
    } else {
      assert.ok(p.every((x) => x.kind === "refund"));
    }
  }
});

test("the plan refuses an outcome that doesn't fit the deposits", () => {
  assert.throws(() => plan(AUCTION, "utest1seller", [who("a", 100_000)], { sold: true, winnerId: "a", price: 200_000, standing: {} }));
  assert.throws(() => plan(AUCTION, "utest1seller", [who("a", 100_000)], { sold: true, winnerId: "zz", price: 50_000, standing: {} }));
});

test("the fee is 5,000 zat per action, at least two", () => {
  assert.equal(settlementFee(1, 1), 10_000);
  assert.equal(settlementFee(3, 4), 20_000);
  assert.equal(settlementFee(6, 2), 30_000);
});

test("coin amounts parse and print without rounding", () => {
  assert.equal(parseCoins("0.05"), 5_000_000);
  assert.equal(parseCoins("1"), 100_000_000);
  assert.equal(parseCoins(" 0.00000001 "), 1);
  assert.equal(parseCoins("0.123456789"), null);
  assert.equal(parseCoins("1e3"), null);
  assert.equal(parseCoins("-1"), null);
  assert.equal(parseCoins(""), null);
  assert.equal(formatCoins(5_000_000), "0.05");
  assert.equal(formatCoins(100_000_000), "1");
  assert.equal(formatCoins(1), "0.00000001");
  assert.equal(formatCoins(0), "0");
});
