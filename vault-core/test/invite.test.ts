import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LISTING_DESCRIPTION_MAX,
  LISTING_TITLE_MAX,
  SEALED_LISTING_BYTES,
  decryptListing,
  decryptListingWithKey,
  encryptListing,
  fromBase64,
  inviteAccess,
  inviteFromManage,
  inviteFromText,
  listingKey,
  manageToken,
  newNonce,
  toBase64,
  validSealedListing,
} from "../src/index.ts";

test("an invited browser reads the listing; the same text never appears in what the site stores", async () => {
  const invite = await inviteFromManage(newNonce());
  const text = { title: "A signed first pressing", description: "Mint, unplayed.\nShips from Lagos. Ünïcödé ✓ 🎵" };
  const sealed = await encryptListing(invite, text);
  assert.deepEqual(await decryptListing(invite, sealed), text);
  assert.ok(validSealedListing(sealed));
  const stored = new TextDecoder("latin1").decode(fromBase64(sealed));
  assert.ok(!stored.includes("signed") && !stored.includes("Lagos"));
});

test("every encrypted listing is the same size, whatever it says", async () => {
  const invite = newNonce();
  const sizes = new Set<number>();
  for (const t of [
    { title: "abc", description: "" },
    { title: "x".repeat(LISTING_TITLE_MAX), description: "y".repeat(LISTING_DESCRIPTION_MAX) },
    { title: "€".repeat(LISTING_TITLE_MAX), description: "€".repeat(LISTING_DESCRIPTION_MAX) }, // three bytes each
    { title: "🎵".repeat(LISTING_TITLE_MAX / 2), description: "🎵".repeat(LISTING_DESCRIPTION_MAX / 2) },
  ]) {
    const sealed = await encryptListing(invite, t);
    sizes.add(fromBase64(sealed).length);
    assert.deepEqual(await decryptListing(invite, sealed), t);
  }
  assert.deepEqual([...sizes], [SEALED_LISTING_BYTES]);
});

test("a listing that is too long is refused, not cut", async () => {
  const invite = newNonce();
  await assert.rejects(encryptListing(invite, { title: "x".repeat(LISTING_TITLE_MAX + 1), description: "" }), /title/);
  await assert.rejects(encryptListing(invite, { title: "ok", description: "y".repeat(LISTING_DESCRIPTION_MAX + 1) }), /description/);
});

test("another invite, or a changed ciphertext, does not open it", async () => {
  const invite = newNonce();
  const sealed = await encryptListing(invite, { title: "Secret lot", description: "for a few" });
  await assert.rejects(decryptListing(newNonce(), sealed));
  const bytes = fromBase64(sealed);
  bytes[40] = bytes[40]! ^ 1;
  await assert.rejects(decryptListing(invite, toBase64(bytes)));
  assert.ok(!validSealedListing(toBase64(bytes.subarray(0, bytes.length - 1))));
  assert.ok(!validSealedListing("not base64 !"));
  assert.ok(!validSealedListing(undefined));
});

test("the keys: all derived one way, each for one job", async () => {
  const manage = newNonce();
  const invite = await inviteFromManage(manage);
  assert.equal(invite, await inviteFromManage(manage)); // the seller's link recovers it
  assert.notEqual(invite, await inviteFromManage(newNonce()));
  const access = await inviteAccess(invite);
  const key = await listingKey(invite);
  // What the site is shown (the access token) is not the invite, not the listing key, and not the seller's token.
  assert.equal(new Set([manage, invite, access, key, await manageToken(manage)]).size, 5);
  // The access token does not open the listing.
  const sealed = await encryptListing(invite, { title: "Secret lot", description: "" });
  await assert.rejects(decryptListingWithKey(access, sealed));
  // The listing key alone does (it is what a dispute hands the operator).
  assert.equal((await decryptListingWithKey(key, sealed)).title, "Secret lot");
  await assert.rejects(inviteAccess("nope"));
});

test("an invite is found in a pasted link, a fragment, or by itself", () => {
  const k = "ab".repeat(32);
  assert.equal(inviteFromText(`https://vault.example/auction/${"0".repeat(32)}#invite=${k}`), k);
  assert.equal(inviteFromText(`  #invite=${k} `), k);
  assert.equal(inviteFromText(`invite=${k}`), k);
  assert.equal(inviteFromText(k), k);
  assert.equal(inviteFromText(`Here you go: https://vault.example/auction/${"0".repeat(32)}#invite=${k}.\nSee you there`), k);
  assert.equal(inviteFromText(`#invite=${k}ab`), null); // too long to be a key
  assert.equal(inviteFromText(`https://vault.example/auction/${"0".repeat(32)}`), null);
  assert.equal(inviteFromText(`#manage=${k}`), null);
  assert.equal(inviteFromText("hello"), null);
});
