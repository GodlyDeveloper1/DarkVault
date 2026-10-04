import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicBeacon, newBlinding, openSealedBid, QUICKNET, roundAfter, roundTimeMs, sealBid, sealedFor, TooEarly, trustedChain } from "../src/index.ts";
import { mockBeacon } from "./mock-beacon.ts";

// tlock-js prints the beacon when it decrypts; keep the test output readable.
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await f();
  } finally {
    console.log = log;
  }
};

test("the round for a closing time is the first one signed after it", () => {
  const { chain } = mockBeacon();
  const close = Date.now() + 60_000;
  const round = roundAfter(chain, close);
  assert.ok(roundTimeMs(chain, round) > close, "not openable at the close");
  assert.ok(roundTimeMs(chain, round) - close <= chain.period * 1000, "and at most one period later");
  assert.ok(roundTimeMs(chain, round - 1) <= close);
  // Exactly on a round boundary: that round's signature may already exist, so the next one is used.
  const onBoundary = roundTimeMs(chain, 500);
  assert.equal(roundAfter(chain, onBoundary), 501);
  assert.throws(() => roundAfter(chain, 0), /before the beacon began/);
});

test("the public network is recognised exactly, and a test beacon is not", () => {
  assert.ok(isPublicBeacon(QUICKNET));
  assert.ok(isPublicBeacon({ ...QUICKNET }));
  assert.ok(!isPublicBeacon(mockBeacon().chain));
  assert.ok(!isPublicBeacon({ ...QUICKNET, public_key: mockBeacon().chain.public_key }), "the same chain id with another key is not the public network");
  assert.ok(!isPublicBeacon(null));
  // The right key with another start time or period would move every round: not the public network either.
  const shifted = { ...QUICKNET, genesis_time: QUICKNET.genesis_time + 30 * 86400 };
  assert.ok(!isPublicBeacon(shifted));
  assert.ok(!isPublicBeacon({ ...QUICKNET, period: 3000 }));
  assert.equal(trustedChain({ ...QUICKNET }), QUICKNET, "the public network is always the built-in constant");
  assert.equal(trustedChain(shifted), shifted);
});

test("sealing needs no network and says which round it is locked to", async () => {
  const { chain } = mockBeacon();
  const round = roundAfter(chain, Date.now() + 60_000);
  const sealed = await sealBid(chain, round, 800_000, newBlinding());
  assert.match(sealed, /^-----BEGIN AGE ENCRYPTED FILE-----/);
  assert.deepEqual(sealedFor(sealed), { round, chain_hash: chain.hash });
  assert.equal(sealedFor("not a sealed bid"), null);
  assert.equal(sealedFor(""), null);
  // Sealing to the real public network also works offline (opening it needs the real beacon).
  const real = await sealBid(QUICKNET, roundAfter(QUICKNET, Date.now() + 60_000), 1, newBlinding());
  assert.equal(sealedFor(real)?.chain_hash, QUICKNET.hash);
});

test("the size of a sealed bid does not depend on the amount", async () => {
  const { chain } = mockBeacon();
  const round = roundAfter(chain, Date.now() + 60_000);
  const sizes = new Set<number>();
  for (const amount of [1, 100_000, 99_999_999, 1_234_567_890_123]) sizes.add((await sealBid(chain, round, amount, newBlinding())).length);
  assert.equal(sizes.size, 1);
});

test("a sealed bid opens with its round's beacon and with nothing else", async () => {
  const { chain, sign } = mockBeacon();
  const blinding = newBlinding();
  // A round already past, so the library's own clock check lets the beacon be used.
  const round = roundAfter(chain, Date.now() - 30_000);
  const sealed = await sealBid(chain, round, 800_000, blinding);
  assert.ok(!sealed.includes("800000") && !sealed.includes(blinding));

  assert.deepEqual(await quiet(() => openSealedBid(chain, sealed, sign(round))), { amount: 800_000, blinding });
  // The signature alone is enough: that is all the server keeps of a beacon.
  assert.deepEqual(await openSealedBid(chain, sealed, { round, signature: sign(round).signature }), { amount: 800_000, blinding });
  // Another round's signature, however valid, opens nothing.
  await assert.rejects(quiet(() => openSealedBid(chain, sealed, sign(round - 1))), "an earlier round");
  await assert.rejects(quiet(() => openSealedBid(chain, sealed, { ...sign(round + 1), round })), "a later round's signature passed off as this one");
  // A signature made with another key is refused before it is used.
  const impostor = mockBeacon("2e".repeat(32));
  await assert.rejects(quiet(() => openSealedBid(chain, sealed, impostor.sign(round))), "another network's signature");
  // A damaged ciphertext is refused.
  const at = sealed.indexOf("\n", 200) + 5; // inside the encrypted body
  const damaged = sealed.slice(0, at) + (sealed[at] === "A" ? "B" : "A") + sealed.slice(at + 1);
  await assert.rejects(quiet(() => openSealedBid(chain, damaged, sign(round))));
});

test("a bid sealed to a future round can't be opened yet, even with a signature in hand", async () => {
  const { chain, sign } = mockBeacon();
  const round = roundAfter(chain, Date.now() + 60_000);
  const sealed = await sealBid(chain, round, 5, newBlinding());
  // The real network would not have signed this round. The library also refuses by the clock.
  await assert.rejects(quiet(() => openSealedBid(chain, sealed, sign(round))), TooEarly);
});

test("opening several bids at once leaves console.log as it was", async () => {
  const { chain, sign } = mockBeacon();
  const round = roundAfter(chain, Date.now() - 30_000);
  const sealed = await Promise.all([1, 2, 3].map((n) => sealBid(chain, round, n, newBlinding())));
  const before = console.log;
  const opened = await Promise.all(sealed.map((s) => openSealedBid(chain, s, sign(round))));
  assert.equal(console.log, before);
  assert.deepEqual(opened.map((o) => o.amount), [1, 2, 3]);
});

test("sealing refuses bad input", async () => {
  const { chain } = mockBeacon();
  // A chain that borrows the public network's id but shifts its clock is refused outright.
  await assert.rejects(() => sealBid({ ...QUICKNET, genesis_time: QUICKNET.genesis_time + 86400 }, 10, 1, newBlinding()), /not the public drand network/);
  await assert.rejects(() => sealBid(chain, 10, -1, newBlinding()));
  await assert.rejects(() => sealBid(chain, 10, 1.5, newBlinding()));
  await assert.rejects(() => sealBid(chain, 10, 1, "short"));
  await assert.rejects(() => sealBid(chain, 0, 1, newBlinding()));
});
