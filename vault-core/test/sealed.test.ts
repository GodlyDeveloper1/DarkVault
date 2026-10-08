import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boardStatusOf,
  decideSealed,
  fairnessBound,
  hidingDeposit,
  newBlinding,
  newId,
  newSiteKey,
  pedersenCommit,
  proveFairness,
  sealedHash,
  signReceipt,
  sitePublicKey,
  suggestedCeiling,
  verifyBeacon,
  verifyFairness,
  verifyReceipt,
  type FairnessStatement,
  type SealedBid,
} from "../src/index.ts";
import { mockBeacon } from "./mock-beacon.ts";

const RESERVE = 300_000;
const CEILING = 1_500_000;
const BOND = 50_000;
const FULL = CEILING + BOND;

const bid = (id: string, order: number, deposit: number, revealed?: number): SealedBid => ({ id, order, deposit, revealed });

test("same-size deposits: every bid deposits the ceiling plus the bond, whatever it bids", () => {
  const out = decideSealed(RESERVE, CEILING, [bid("a", 0, FULL, 400_000), bid("b", 1, FULL, 900_000), bid("c", 2, FULL, 300_000)], BOND);
  assert.deepEqual(out, { sold: true, winnerId: "b", price: 900_000, standing: { a: "outbid", b: "won", c: "outbid" } });
});

test("same-size deposits: a deposit that only covers the bid is not enough", () => {
  // Under the old rule this bid would count: 900,000 + bond is deposited. Here every deposit must be the full amount.
  const out = decideSealed(RESERVE, CEILING, [bid("a", 0, 950_000, 900_000), bid("b", 1, FULL, 400_000)], BOND);
  assert.equal(out.standing.a, "underfunded");
  assert.equal(out.winnerId, "b");
  // One zatoshi short is short.
  assert.equal(decideSealed(RESERVE, CEILING, [bid("a", 0, FULL - 1, 400_000)], BOND).standing.a, "underfunded");
  // More than asked is fine: the rest comes back.
  assert.equal(decideSealed(RESERVE, CEILING, [bid("a", 0, FULL + 7, 400_000)], BOND).standing.a, "won");
});

test("same-size deposits: a bid above the ceiling does not count", () => {
  const out = decideSealed(RESERVE, CEILING, [bid("a", 0, FULL, CEILING + 1), bid("b", 1, FULL, CEILING)], BOND);
  assert.equal(out.standing.a, "over-ceiling");
  assert.deepEqual([out.winnerId, out.price], ["b", CEILING]);
});

test("same-size deposits: ties go to the bid placed first, not the one funded first", () => {
  const out = decideSealed(RESERVE, CEILING, [bid("late", 5, FULL, 700_000), bid("early", 2, FULL, 700_000), bid("low", 0, FULL, 500_000)], 0);
  assert.equal(out.winnerId, "early");
  assert.equal(out.standing.late, "outbid");
});

test("same-size deposits: unopened, unfunded and below-reserve bids", () => {
  const out = decideSealed(RESERVE, CEILING, [bid("a", 0, 0, 900_000), bid("b", 1, FULL), bid("c", 2, FULL, RESERVE - 1)], BOND);
  assert.deepEqual(out, { sold: false, standing: { a: "no-deposit", b: "not-revealed", c: "below-reserve" } });
  assert.throws(() => decideSealed(RESERVE, RESERVE - 1, []), /ceiling/);
  assert.deepEqual(decideSealed(RESERVE, RESERVE, []), { sold: false, standing: {} });
});

test("the board status of each standing", () => {
  assert.equal(boardStatusOf("won"), "counted");
  assert.equal(boardStatusOf("outbid"), "counted");
  assert.equal(boardStatusOf("below-reserve"), "counted");
  assert.equal(boardStatusOf("no-deposit"), "no-deposit");
  assert.equal(boardStatusOf("underfunded"), "underfunded");
  assert.equal(boardStatusOf("not-revealed"), "unopened");
  assert.equal(boardStatusOf("over-ceiling"), "unopened");
  assert.equal(suggestedCeiling(RESERVE), 1_500_000);
});

test("a decided auction turns into a statement whose proof checks out", async () => {
  // The path the server takes: decide, build the statement from the standings, prove, verify.
  const auctionId = newId();
  const amounts = [400_000, 900_000, undefined, 900_000, 100_000, 2_000_000];
  const deposits = [FULL, FULL, FULL, FULL, FULL, FULL];
  deposits[2] = 0;
  const openings = amounts.map((amount) => (amount === undefined ? undefined : { amount, blinding: newBlinding() }));
  const commitments = openings.map((o) => (o ? pedersenCommit(auctionId, o.amount, o.blinding) : pedersenCommit(auctionId, 1, newBlinding())));
  const out = decideSealed(
    RESERVE,
    CEILING,
    amounts.map((a, i) => bid(String(i), i, deposits[i]!, a)),
    BOND,
  );
  assert.equal(out.winnerId, "1", "the earlier of the two equal top bids");
  assert.equal(out.standing["5"], "over-ceiling");
  const statement: FairnessStatement = {
    v: 2,
    auction_id: auctionId,
    reserve: RESERVE,
    ceiling: CEILING,
    bids: commitments.map((commitment, i) => ({ commitment, status: boardStatusOf(out.standing[String(i)]!) })),
    sold: out.sold,
    price: out.price ?? null,
    winner: out.sold ? Number(out.winnerId) : null,
  };
  assert.deepEqual(statement.bids.map((b) => b.status), ["counted", "counted", "no-deposit", "counted", "counted", "unopened"]);
  assert.equal(fairnessBound(statement, 0), 899_999, "placed before the winner: must be strictly lower");
  assert.equal(fairnessBound(statement, 3), 900_000, "placed after: may be equal");
  const proof = await proveFairness(statement, openings);
  const verdict = await verifyFairness(statement, proof);
  assert.deepEqual(verdict, { ok: true, problems: [], bids: 6, counted: 4 });
  // The same proof does not fit a result that names the later of the tied bids.
  const wrong = { ...statement, winner: 3 };
  assert.equal((await verifyFairness(wrong, proof)).ok, false);
});

test("receipts: the site's signature over what it accepted", () => {
  const secret = newSiteKey();
  const pub = sitePublicKey(secret);
  assert.match(pub, /^[0-9a-f]{64}$/);
  const auctionId = newId();
  const fields = { auction_id: auctionId, commitment: pedersenCommit(auctionId, 5, newBlinding()), sealed_hash: sealedHash("-----BEGIN AGE ENCRYPTED FILE-----\nabc\n"), position: 3, placed_at: 1_760_000_000_000 };
  const receipt = signReceipt(secret, fields);
  assert.ok(verifyReceipt(pub, receipt));
  // Any change breaks it.
  assert.ok(!verifyReceipt(pub, { ...receipt, position: 2 }));
  assert.ok(!verifyReceipt(pub, { ...receipt, placed_at: receipt.placed_at + 1 }));
  assert.ok(!verifyReceipt(pub, { ...receipt, sealed_hash: sealedHash("other") }));
  assert.ok(!verifyReceipt(pub, { ...receipt, commitment: pedersenCommit(auctionId, 6, newBlinding()) }));
  assert.ok(!verifyReceipt(pub, { ...receipt, auction_id: newId() }));
  // Another key's signature is not the site's.
  assert.ok(!verifyReceipt(sitePublicKey(newSiteKey()), receipt));
  assert.ok(!verifyReceipt("zz", receipt));
  assert.ok(!verifyReceipt(pub, { ...receipt, signature: "00".repeat(64) }));
  assert.throws(() => signReceipt(secret, { ...fields, position: 0 }));
  assert.throws(() => signReceipt("short", fields));
  assert.notEqual(sealedHash("a"), sealedHash("b"));
});

test("a beacon is checked against the chain's key", () => {
  const { chain, sign } = mockBeacon();
  assert.ok(verifyBeacon(chain, sign(1234)));
  assert.ok(!verifyBeacon(chain, { ...sign(1234), round: 1235 }), "a signature for another round");
  assert.ok(!verifyBeacon(chain, mockBeacon("2e".repeat(32)).sign(1234)), "another network's signature");
  assert.ok(!verifyBeacon(chain, { round: 1234, signature: "00".repeat(48) }));
  assert.ok(!verifyBeacon(chain, { round: 1234, signature: "nonsense" }));
  assert.ok(!verifyBeacon({ ...chain, scheme: "pedersen-bls-chained" }, sign(1234)), "a scheme this code doesn't know");
});

// --- auctions without a ceiling: a deposit is the bid plus the bond, or more ---

test("no ceiling: a bid counts when its deposit covers the bid and the bond", () => {
  const out = decideSealed(RESERVE, null, [bid("a", 0, 400_000 + BOND, 400_000), bid("b", 1, 900_000 + BOND, 900_000), bid("c", 2, 300_000 + BOND, 300_000)], BOND);
  assert.deepEqual(out, { sold: true, winnerId: "b", price: 900_000, standing: { a: "outbid", b: "won", c: "outbid" } });
});

test("no ceiling: there is no highest bid", () => {
  const huge = RESERVE * 5_000;
  const out = decideSealed(RESERVE, null, [bid("a", 0, huge + BOND, huge), bid("b", 1, 400_000 + BOND, 400_000)], BOND);
  assert.equal(out.winnerId, "a");
  assert.equal(out.price, huge);
});

test("no ceiling: a deposit one zatoshi short of the bid and the bond does not count", () => {
  const out = decideSealed(RESERVE, null, [bid("short", 0, 900_000 + BOND - 1, 900_000), bid("ok", 1, 400_000 + BOND, 400_000)], BOND);
  assert.equal(out.standing.short, "underfunded");
  assert.equal(out.winnerId, "ok");
  // The bond is part of it: a deposit of exactly the bid is short by the bond.
  assert.equal(decideSealed(RESERVE, null, [bid("a", 0, 400_000, 400_000)], BOND).standing.a, "underfunded");
  assert.equal(decideSealed(RESERVE, null, [bid("a", 0, 400_000, 400_000)], 0).standing.a, "won");
});

test("no ceiling: a larger deposit than the bid needs is fine, and wins nothing by itself", () => {
  const out = decideSealed(RESERVE, null, [bid("padded", 0, 3_000_000 + BOND, 400_000), bid("exact", 1, 500_000 + BOND, 500_000)], BOND);
  assert.deepEqual(out.standing, { padded: "outbid", exact: "won" });
  assert.equal(out.price, 500_000);
});

test("no ceiling: unfunded, too small to count, unopened and below-reserve bids; ties go to the first placed", () => {
  const out = decideSealed(
    RESERVE,
    null,
    [bid("none", 0, 0, 900_000), bid("tiny", 1, RESERVE + BOND - 1), bid("shut", 2, RESERVE + BOND), bid("low", 3, RESERVE + BOND, RESERVE - 1), bid("late", 6, 750_000, 700_000), bid("early", 4, 750_000, 700_000)],
    BOND,
  );
  assert.deepEqual(out.standing, { none: "no-deposit", tiny: "underfunded", shut: "not-revealed", low: "below-reserve", late: "outbid", early: "won" });
  assert.deepEqual(decideSealed(RESERVE, null, []), { sold: false, standing: {} });
});

test("hiding a bid: the deposit is the next round amount above it", () => {
  // Reserve 300,000: the amounts are 600,000, 1,500,000, 3,000,000, 6,000,000, 15,000,000…
  assert.equal(hidingDeposit(RESERVE, 300_000), 600_000);
  assert.equal(hidingDeposit(RESERVE, 599_999), 600_000);
  assert.equal(hidingDeposit(RESERVE, 600_000), 1_500_000); // always above the bid, never equal to it
  assert.equal(hidingDeposit(RESERVE, 1_400_000), 1_500_000);
  assert.equal(hidingDeposit(RESERVE, 2_999_999), 3_000_000);
  assert.equal(hidingDeposit(RESERVE, 3_000_000), 6_000_000);
  assert.equal(hidingDeposit(100_000, 40_000_000), 50_000_000);
  // Many bids share one deposit: that is the point.
  assert.equal(new Set([310_000, 420_000, 555_000, 599_000].map((b) => hidingDeposit(RESERVE, b))).size, 1);
  for (const b of [300_000, 777_777, 12_345_678]) assert.ok(hidingDeposit(RESERVE, b) > b);
  assert.throws(() => hidingDeposit(0, 5), /reserve/);
});

test("no ceiling: the result is proven with the price as the bound", async () => {
  const id = newId();
  const amounts = [400_000, 2_750_000, 2_750_000, 900_000, 310_000];
  const blindings = amounts.map(() => newBlinding());
  const bids = amounts.map((a, i) => bid(String(i), i, a + BOND + (i === 3 ? 600_000 : 0), a));
  const out = decideSealed(RESERVE, null, bids, BOND);
  assert.equal(out.winnerId, "1"); // of the two equal bids, the one placed first
  const statement: FairnessStatement = {
    v: 2,
    auction_id: id,
    reserve: RESERVE,
    ceiling: out.price!,
    bids: amounts.map((a, i) => ({ commitment: pedersenCommit(id, a, blindings[i]!), status: boardStatusOf(out.standing[String(i)]!) })),
    sold: true,
    price: out.price!,
    winner: 1,
  };
  const openings = amounts.map((amount, i) => ({ amount, blinding: blindings[i]! }));
  const proof = await proveFairness(statement, openings);
  assert.deepEqual(await verifyFairness(statement, proof), { ok: true, problems: [], bids: 5, counted: 5 });
  // The same proof does not pass for a lower price, or for the other equal bid as winner.
  assert.equal((await verifyFairness({ ...statement, price: 2_000_000, ceiling: 2_000_000 }, proof)).ok, false);
  assert.equal((await verifyFairness({ ...statement, winner: 2 }, proof)).ok, false);
  // And a statement that a lower bid won can't be proven at all.
  await assert.rejects(proveFairness({ ...statement, price: 900_000, ceiling: 900_000, winner: 3 }, openings), /higher than the result allows|not the price/);

  // Unsold: the bound is the reserve.
  const lowAmounts = [100_000, 299_999];
  const lowBl = lowAmounts.map(() => newBlinding());
  const unsold: FairnessStatement = { v: 2, auction_id: id, reserve: RESERVE, ceiling: RESERVE, bids: lowAmounts.map((a, i) => ({ commitment: pedersenCommit(id, a, lowBl[i]!), status: "counted" as const })), sold: false, price: null, winner: null };
  const p2 = await proveFairness(unsold, lowAmounts.map((amount, i) => ({ amount, blinding: lowBl[i]! })));
  assert.equal((await verifyFairness(unsold, p2)).ok, true);
});
