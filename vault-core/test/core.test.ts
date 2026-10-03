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
  minSettlementFee,
  bidToken,
  sha256Hex,
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

test("the highest bid wins and pays what it bid", () => {
  const o = decide(100_000, [bid("a", 0, 900_000, 800_000), bid("b", 1, 600_000, 500_000), bid("c", 2, 300_000, 300_000)]);
  assert.equal(o.sold, true);
  assert.equal(o.winnerId, "a");
  assert.equal(o.price, 800_000);
  assert.deepEqual(o.standing, { a: "won", b: "outbid", c: "outbid" });
});

test("a single bid still pays what it bid, not the reserve", () => {
  const o = decide(250_000, [bid("a", 0, 900_000, 800_000)]);
  assert.equal(o.winnerId, "a");
  assert.equal(o.price, 800_000);
});

test("a bid below the reserve cannot win", () => {
  const o = decide(250_000, [bid("a", 0, 900_000, 800_000), bid("b", 1, 200_000, 200_000)]);
  assert.equal(o.winnerId, "a");
  assert.equal(o.price, 800_000);
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
  assert.equal(o.price, 350_000);
  assert.deepEqual(o.standing, { unrevealed: "not-revealed", nodeposit: "no-deposit", underfunded: "underfunded", honest: "won" });
});

test("no other bid can change what the winner pays", () => {
  // A fake bid placed just under the top one (by a seller, say) changes nothing:
  // the winner pays their own bid whatever else is on the board.
  const me = bid("me", 1, 800_000, 800_000);
  assert.equal(decide(100_000, [me]).price, 800_000);
  assert.equal(decide(100_000, [bid("rival", 0, 500_000, 500_000), me]).price, 800_000);
  assert.equal(decide(100_000, [bid("shill", 0, 799_999, 799_999), me]).price, 800_000);
  // A higher fake bid wins the lot itself and has to pay for it in full.
  const o = decide(100_000, [bid("shill", 0, 900_000, 900_000), me]);
  assert.equal(o.winnerId, "shill");
  assert.equal(o.price, 900_000);
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
      ["seller", "utest1seller", 800_000],
      ["winner-change", "utest1refunda", 100_000],
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
  const outcome = decide(100_000, [bid("a", 0, 500_001, 500_000), bid("b", 1, 400_000, 400_000)]);
  const p = plan(AUCTION, "utest1seller", [who("a", 500_001), who("b", 400_000)], outcome);
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

test("the least fee is 5,000 zat per action, at least two", () => {
  assert.equal(minSettlementFee(1, 1), 10_000);
  assert.equal(minSettlementFee(3, 4), 20_000);
  assert.equal(minSettlementFee(6, 2), 30_000);
});

test("a bid token is derived from the nonce and gives nothing away about the amount", async () => {
  const nonce = newNonce();
  const token = await bidToken(nonce);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(token, await bidToken(nonce));
  assert.notEqual(token, await bidToken(newNonce()));
  assert.notEqual(token, nonce);
  // It can't be used to open the commitment: it is not the nonce.
  const c = await commit(AUCTION, 700_000, nonce);
  assert.equal(await opens(AUCTION, c, 700_000, token), false);
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  await assert.rejects(bidToken("short"));
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

// ---------------------------------------------------------------------------
// Escrow and delivery
// ---------------------------------------------------------------------------
import {
  decryptLot,
  deliveryContext,
  deliveryPublic,
  encryptLot,
  judgeDigitalDelivery,
  lotKeyHash,
  MAX_LOT_BYTES,
  newDeliveryKey,
  open,
  openText,
  planEscrowPayout,
  seal,
  sealText,
  sellerKeys,
  manageToken,
  bondFor,
  MIN_BOND,
} from "../src/index.ts";

const MANAGE = "5e".repeat(32);
const bytes = (t: string) => new TextEncoder().encode(t);

test("with escrow the price goes to the escrow vault and nobody else's payment changes", () => {
  const depositors: Depositor[] = [
    { id: "a", deposit: 900_000, refundAddress: "utest1a" },
    { id: "b", deposit: 500_000, refundAddress: "utest1b" },
  ];
  const outcome = { sold: true, winnerId: "a", price: 800_000, standing: { a: "won", b: "outbid" } } as const;
  const direct = plan(AUCTION, "utest1seller", depositors, outcome);
  const held = plan(AUCTION, "utest1seller", depositors, outcome, "utest1escrow");
  assert.equal(held.length, direct.length);
  assert.deepEqual(held[0], { ...direct[0], kind: "escrow", to: "utest1escrow", memo: held[0]!.memo });
  assert.ok(!held.some((p) => p.to === "utest1seller"), "the seller is not paid yet");
  assert.deepEqual(held.slice(1), direct.slice(1));
  assert.equal(held.reduce((s, p) => s + p.zatoshis, 0), 1_400_000);
});

test("escrow has no effect when the lot did not sell", () => {
  const depositors: Depositor[] = [{ id: "a", deposit: 300_000, refundAddress: "utest1a" }];
  const outcome = { sold: false, standing: { a: "below-reserve" } } as const;
  assert.deepEqual(plan(AUCTION, "utest1seller", depositors, outcome, "utest1escrow"), plan(AUCTION, "utest1seller", depositors, outcome));
});

test("without bonds the escrow payout sends everything held to exactly one party", () => {
  const winner = { bidId: "a", refundAddress: "utest1a" };
  const held = { total: 795_000, sellerBond: 0, buyerBond: 0 };
  const release = planEscrowPayout(AUCTION, held, "release", "none", "utest1seller", winner);
  assert.deepEqual(release.map((p) => [p.kind, p.to, p.zatoshis, p.pays_fee]), [["seller", "utest1seller", 795_000, true]]);
  const refund = planEscrowPayout(AUCTION, held, "refund", "seller", "utest1seller", winner);
  assert.deepEqual(refund.map((p) => [p.kind, p.bidId, p.to, p.zatoshis, p.pays_fee]), [["escrow-refund", "a", "utest1a", 795_000, true]]);
  assert.throws(() => planEscrowPayout(AUCTION, { total: 1000, sellerBond: 0, buyerBond: 0 }, "release", "none", "utest1seller", winner), /too small/);
});

test("the bond for a reserve is a tenth of it, never less than the minimum, and can be switched off", () => {
  assert.equal(bondFor(2_000_000), 200_000);
  assert.equal(bondFor(200_000), MIN_BOND);
  assert.equal(bondFor(1_234_567), 123_456);
  assert.equal(bondFor(2_000_000, 25), 500_000);
  assert.equal(bondFor(2_000_000, 0), 0);
});

test("with a bond, a bid counts only if its deposit covers the bid and the bond", () => {
  const bids: SealedBid[] = [
    { id: "exact", order: 0, deposit: 800_000, revealed: 800_000 }, // no room for the bond
    { id: "covered", order: 1, deposit: 750_000, revealed: 700_000 },
    { id: "one-short", order: 2, deposit: 749_999, revealed: 700_000 },
  ];
  const o = decide(200_000, bids, 50_000);
  assert.deepEqual(o.standing, { exact: "underfunded", covered: "won", "one-short": "underfunded" });
  assert.equal(o.price, 700_000);
  // The same bids with no bond: the highest wins.
  assert.equal(decide(200_000, bids).winnerId, "exact");
});

test("with a bond, the price and the bond go into escrow and only the rest comes back now", () => {
  const depositors: Depositor[] = [
    { id: "a", deposit: 900_000, refundAddress: "utest1a" },
    { id: "b", deposit: 500_000, refundAddress: "utest1b" },
  ];
  const outcome = { sold: true, winnerId: "a", price: 800_000, standing: { a: "won", b: "outbid" } } as const;
  const p = plan(AUCTION, "utest1seller", depositors, outcome, "utest1escrow", 50_000);
  assert.deepEqual(p.map((x) => [x.kind, x.zatoshis]), [["escrow", 850_000], ["winner-change", 50_000], ["refund", 500_000]]);
  assert.equal(p.reduce((s, x) => s + x.zatoshis, 0), 1_400_000);
  assert.throws(() => plan(AUCTION, "utest1seller", depositors, outcome, undefined, 50_000), /needs an escrow/);
  assert.throws(() => plan(AUCTION, "utest1seller", depositors, outcome, "utest1escrow", 150_000), /more than the winner deposited/);
  // A winner who deposited exactly bid + bond gets nothing back now.
  const tight = plan(AUCTION, "utest1seller", [{ id: "a", deposit: 850_000, refundAddress: "utest1a" }], { ...outcome, standing: { a: "won" } }, "utest1escrow", 50_000);
  assert.deepEqual(tight.map((x) => [x.kind, x.zatoshis]), [["escrow", 850_000]]);
});

test("the escrow payout gives the bond of whoever is at fault to the other side", () => {
  const winner = { bidId: "a", refundAddress: "utest1a" };
  // Held: 800,000 price (less a fee share of 5,000 already paid) + 100,000 seller bond + 50,000 winner bond.
  const held = { total: 945_000, sellerBond: 100_000, buyerBond: 50_000 };
  const split = (decision: "release" | "refund", fault: "seller" | "winner" | "none") => {
    const p = planEscrowPayout(AUCTION, held, decision, fault, "utest1seller", winner);
    assert.equal(p.reduce((s, x) => s + x.zatoshis, 0), held.total, "everything held is paid out");
    return { seller: p.find((x) => x.kind === "seller")?.zatoshis ?? 0, winner: p.find((x) => x.kind === "escrow-refund")?.zatoshis ?? 0 };
  };
  // Honest sale: the seller gets the price and their bond; the winner gets their bond back.
  assert.deepEqual(split("release", "none"), { seller: 895_000, winner: 50_000 });
  // The winner opened a dispute and lost: their bond goes to the seller too.
  assert.deepEqual(split("release", "winner"), { seller: 945_000, winner: 0 });
  // The seller didn't deliver, or lost a dispute: everything goes to the winner.
  assert.deepEqual(split("refund", "seller"), { seller: 0, winner: 945_000 });
  // The winner never said where to send it: they get the price back, the seller keeps both bonds.
  assert.deepEqual(split("refund", "winner"), { seller: 150_000, winner: 795_000 });
  // Undone with nobody to blame: each side gets their own bond.
  assert.deepEqual(split("refund", "none"), { seller: 100_000, winner: 845_000 });
  // The fee is carried by whoever receives the price; a bond travelling alone arrives in full.
  const payers = (decision: "release" | "refund", fault: "seller" | "winner" | "none") =>
    planEscrowPayout(AUCTION, held, decision, fault, "utest1seller", winner).map((p) => `${p.kind}:${p.pays_fee}`);
  assert.deepEqual(payers("release", "none"), ["seller:true", "escrow-refund:false"]);
  assert.deepEqual(payers("refund", "none"), ["seller:false", "escrow-refund:true"]);
  assert.deepEqual(payers("refund", "winner"), ["seller:false", "escrow-refund:true"]);
  assert.deepEqual(payers("refund", "seller"), ["escrow-refund:true"]);
  assert.deepEqual(payers("release", "winner"), ["seller:true"]);
  // A seller at fault is never paid the price.
  assert.throws(() => planEscrowPayout(AUCTION, held, "release", "seller", "utest1seller", winner), /at fault/);
  assert.throws(() => planEscrowPayout(AUCTION, { total: 100_000, sellerBond: 100_000, buyerBond: 50_000 }, "release", "none", "utest1seller", winner), /more than/);
});

test("a lot that did not sell returns the seller's bond and nothing else", () => {
  const p = planEscrowPayout(AUCTION, { total: 100_000, sellerBond: 100_000, buyerBond: 0 }, "return-bond", "none", "utest1seller");
  assert.deepEqual(p.map((x) => [x.kind, x.to, x.zatoshis, x.pays_fee]), [["seller", "utest1seller", 100_000, true]]);
  assert.throws(() => planEscrowPayout(AUCTION, { total: 150_000, sellerBond: 100_000, buyerBond: 50_000 }, "return-bond", "none", "utest1seller"), /no winner's bond/);
});

test("a seller's keys come from the manage key alone and differ from each other", async () => {
  const a = await sellerKeys(MANAGE);
  const b = await sellerKeys(MANAGE);
  assert.equal(a.publicKey, b.publicKey);
  assert.deepEqual(a.lotKey, b.lotKey);
  assert.notEqual(a.privateKey, Buffer.from(a.lotKey).toString("hex"));
  assert.notEqual((await sellerKeys("5f".repeat(32))).publicKey, a.publicKey);
  await assert.rejects(() => sellerKeys("short"));
  // The stored hash is not the plain SHA-256 of the key.
  const { createHash } = await import("node:crypto");
  assert.notEqual(await lotKeyHash(a.lotKey), createHash("sha256").update(a.lotKey).digest("hex"));
});

test("an envelope opens only with the recipient's key, for the same context, unaltered", async () => {
  const key = newDeliveryKey();
  const pub = deliveryPublic(key);
  const ctx = deliveryContext(AUCTION, "shipping");
  const env = await sealText(pub, "12 Example Street", ctx);
  assert.equal(await openText(key, env, ctx), "12 Example Street");
  assert.notEqual(env, await sealText(pub, "12 Example Street", ctx), "sealing twice gives different envelopes");
  await assert.rejects(() => openText(newDeliveryKey(), env, ctx), "another key");
  await assert.rejects(() => openText(key, env, deliveryContext(AUCTION, "note")), "another purpose");
  await assert.rejects(() => openText(key, env, deliveryContext("ff".repeat(16), "shipping")), "another auction");
  const raw = Buffer.from(env, "base64");
  raw[raw.length - 1]! ^= 1;
  await assert.rejects(() => openText(key, raw.toString("base64"), ctx), "altered");
  await assert.rejects(() => openText(key, "AAAA", ctx), "too short");
  assert.ok(!env.includes("Example"));
});

test("a lot round-trips, hides its name, and fails with the wrong key", async () => {
  const { lotKey } = await sellerKeys(MANAGE);
  const sealed = await encryptLot(lotKey, { kind: "file", name: "licence.txt", type: "text/plain" }, bytes("KEY-1234-ABCD"));
  assert.ok(!Buffer.from(sealed).toString("latin1").includes("licence"));
  const back = await decryptLot(lotKey, sealed);
  assert.deepEqual(back.header, { kind: "file", name: "licence.txt", type: "text/plain" });
  assert.equal(new TextDecoder().decode(back.content), "KEY-1234-ABCD");
  const wrong = (await sellerKeys("5f".repeat(32))).lotKey;
  await assert.rejects(() => decryptLot(wrong, sealed));
  await assert.rejects(() => encryptLot(lotKey, { kind: "text" }, new Uint8Array(0)), /empty/);
  await assert.rejects(() => encryptLot(lotKey, { kind: "text" }, new Uint8Array(MAX_LOT_BYTES + 1)), /larger/);
});

test("a dispute over a digital lot is decided by the keys, not by anyone's word", async () => {
  const seller = await sellerKeys(MANAGE);
  const lot = await encryptLot(seller.lotKey, { kind: "text" }, bytes("the secret"));
  const keyHash = await lotKeyHash(seller.lotKey);
  const winnerKey = newDeliveryKey();
  const winnerPub = deliveryPublic(winnerKey);
  const ctx = deliveryContext(AUCTION, "lot-key");
  const base = { auctionId: AUCTION, deliveryKey: winnerKey, deliveryPublic: winnerPub, keyHash, lot };

  // Honest seller, lying winner.
  const good = await seal(winnerPub, seller.lotKey, ctx);
  assert.equal(await judgeDigitalDelivery({ ...base, envelope: good }), "key-was-right");
  // The winner's own check gives the same answer.
  assert.equal(new TextDecoder().decode((await decryptLot(await open(winnerKey, good, ctx), lot)).content), "the secret");

  // The seller sends a different key.
  const other = (await sellerKeys("5f".repeat(32))).lotKey;
  assert.equal(await judgeDigitalDelivery({ ...base, envelope: await seal(winnerPub, other, ctx) }), "seller-cheated");
  // The seller seals the right key to someone else.
  assert.equal(await judgeDigitalDelivery({ ...base, envelope: await seal(deliveryPublic(newDeliveryKey()), seller.lotKey, ctx) }), "seller-cheated");
  // The seller sends rubbish.
  assert.equal(await judgeDigitalDelivery({ ...base, envelope: "AAAA" }), "seller-cheated");
  // The listing's hash matches the key, but the uploaded lot was never encrypted with it.
  const junk = await encryptLot(other, { kind: "text" }, bytes("x"));
  assert.equal(await judgeDigitalDelivery({ ...base, envelope: good, lot: junk }), "seller-cheated");

  // A winner can't dispute with a key that isn't the one their bid registered.
  assert.equal(await judgeDigitalDelivery({ ...base, envelope: good, deliveryKey: newDeliveryKey() }), "not-your-key");
  assert.equal(await judgeDigitalDelivery({ ...base, envelope: good, deliveryKey: "nonsense" }), "not-your-key");
});

test("the manage token proves ownership without giving away the seller's keys", async () => {
  const token = await manageToken(MANAGE);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(token, await manageToken(MANAGE));
  assert.notEqual(token, MANAGE);
  const keys = await sellerKeys(MANAGE);
  assert.notEqual(token, keys.privateKey);
  assert.notEqual(token, Buffer.from(keys.lotKey).toString("hex"));
  // The token alone gives different keys from the manage key: it can't stand in for it.
  assert.notEqual((await sellerKeys(token)).publicKey, keys.publicKey);
  await assert.rejects(() => manageToken("short"));
});
