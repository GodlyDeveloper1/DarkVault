import assert from "node:assert/strict";
import { test } from "node:test";
import {
  boardStatusOf,
  decideSealed,
  fairnessBound,
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
