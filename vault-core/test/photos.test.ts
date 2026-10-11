import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanJpeg, decryptPhoto, encryptPhoto, MAX_PHOTOS, PHOTO_MAX_BYTES, SEALED_PHOTO_BYTES } from "../src/index";

// A minimal JPEG: SOI, the given blocks, a start of scan with a little data, EOI.
function jpeg(...blocks: number[][]): Uint8Array {
  const sos = [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34, 0x56];
  return Uint8Array.from([0xff, 0xd8, ...blocks.flat(), ...sos, 0xff, 0xd9]);
}
const block = (marker: number, body: number[]) => [0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
const jfif = block(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const exif = block(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2, 3, 4]);
const quant = block(0xdb, new Array(65).fill(1));
const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);

test("a redrawn JPEG with only JFIF, tables and a colour profile is clean", () => {
  assert.equal(cleanJpeg(jpeg(jfif, quant)), true);
  assert.equal(cleanJpeg(jpeg(jfif, block(0xe2, [1, 2, 3]), quant)), true);
  assert.equal(cleanJpeg(jpeg(jfif, block(0xee, [1, 2, 3]), quant)), true);
});

test("camera details, IPTC, comments and other app blocks are refused", () => {
  assert.equal(cleanJpeg(jpeg(jfif, exif, quant)), false, "EXIF (location, camera)");
  assert.equal(cleanJpeg(jpeg(exif)), false);
  assert.equal(cleanJpeg(jpeg(jfif, block(0xed, [1, 2]))), false, "IPTC");
  assert.equal(cleanJpeg(jpeg(jfif, block(0xfe, [0x68, 0x69]))), false, "a comment");
  assert.equal(cleanJpeg(jpeg(jfif, block(0xe5, [1]))), false, "APP5");
});

test("anything that is not a whole JPEG is refused", () => {
  assert.equal(cleanJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false, "a PNG");
  const cut = jpeg(jfif, quant).slice(0, -2);
  assert.equal(cleanJpeg(cut), false, "no end marker");
  assert.equal(cleanJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x40, 0xff, 0xd9])), false, "a block longer than the file");
  assert.equal(cleanJpeg(new Uint8Array(PHOTO_MAX_BYTES + 1)), false, "too large");
});

test("a private photo opens with its invite key, at its place, and every one is the same size", async () => {
  const small = jpeg(jfif, quant);
  const big = new Uint8Array(PHOTO_MAX_BYTES).fill(7);
  const a = await encryptPhoto(KEY, 0, small);
  const b = await encryptPhoto(KEY, 2, big);
  assert.equal(a.length, SEALED_PHOTO_BYTES);
  assert.equal(b.length, SEALED_PHOTO_BYTES, "the size says nothing about the photo");
  assert.deepEqual(await decryptPhoto(KEY, 0, a), small);
  assert.deepEqual(await decryptPhoto(KEY, 2, b), big);
  await assert.rejects(decryptPhoto(OTHER, 0, a), "another invite can't open it");
  await assert.rejects(decryptPhoto(KEY, 1, a), "a photo can't be moved to another place");
  const altered = a.slice();
  altered[100] = altered[100]! ^ 1;
  await assert.rejects(decryptPhoto(KEY, 0, altered), "altered");
  await assert.rejects(decryptPhoto(KEY, 0, a.slice(0, -1)), "cut short");
});

test("photo numbers and sizes are bounded", async () => {
  await assert.rejects(encryptPhoto(KEY, MAX_PHOTOS, new Uint8Array(10)));
  await assert.rejects(encryptPhoto(KEY, -1, new Uint8Array(10)));
  await assert.rejects(encryptPhoto(KEY, 0, new Uint8Array(0)));
  await assert.rejects(encryptPhoto(KEY, 0, new Uint8Array(PHOTO_MAX_BYTES + 1)));
});
