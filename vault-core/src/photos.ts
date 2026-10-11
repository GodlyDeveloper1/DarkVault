// Listing photos: up to three per listing, so buyers can see what is for sale.
//
//   - Every photo is redrawn in the seller's browser before it is sent (see
//     the web app's photo picker). A redrawn JPEG carries none of what a camera
//     writes into a file: where it was taken, the phone, the time. The site
//     checks that a public photo has no such block left (`cleanJpeg`).
//   - In a private auction or a deal, each photo is also encrypted in the
//     seller's browser with the listing's key, padded to one fixed size, so the
//     site stores only ciphertext and can't tell one photo from another by
//     its size. Only browsers holding the invite can see them.
//
// Primitives: AES-256-GCM (WebCrypto), as for the encrypted listing.

import { listingKey } from "./invite";

/** At most this many photos per listing. */
export const MAX_PHOTOS = 3;
/** A photo is at most this many bytes once redrawn (a JPEG). */
export const PHOTO_MAX_BYTES = 300_000;
/** The longest side of a redrawn photo, in pixels. */
export const PHOTO_MAX_EDGE = 1600;
/** An encrypted photo: nonce (12) ‖ ciphertext of a 4-byte length, the photo and padding (PHOTO_MAX_BYTES + 4) ‖ tag (16). Every one is this size. */
export const SEALED_PHOTO_BYTES = 12 + 4 + PHOTO_MAX_BYTES + 16;

const te = new TextEncoder();
const buf = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
/** Each photo is bound to its place in the listing: one can't be swapped for another without the key. */
const aad = (index: number) => te.encode(`dark-vault/v1/photo:${index}`);

/**
 * Is this a JPEG with nothing in it but the picture? Walks the blocks before
 * the image data and refuses any that can carry hidden details: APP1 (EXIF
 * and XMP: location, camera, time), APP13 (IPTC), comments and every other
 * application block except APP0 (JFIF), APP2 (a colour profile) and APP14
 * (Adobe colour), which a redrawn photo may carry.
 */
export function cleanJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes.length > PHOTO_MAX_BYTES) return false;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return false;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    // Start of scan: the picture itself begins; no more blocks to check.
    if (marker === 0xda) return true;
    // Markers with no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2 || i + 2 + length > bytes.length) return false;
    const isApp = marker >= 0xe0 && marker <= 0xef;
    if (isApp && marker !== 0xe0 && marker !== 0xe2 && marker !== 0xee) return false;
    if (marker === 0xfe) return false; // a comment
    i += 2 + length;
  }
  return false;
}

async function aesKey(inviteKey: string, usage: KeyUsage): Promise<CryptoKey> {
  const hex = await listingKey(inviteKey);
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return crypto.subtle.importKey("raw", buf(raw), "AES-GCM", false, [usage]);
}

/** Encrypts photo `index` of a private listing with its invite key, padded to SEALED_PHOTO_BYTES. */
export async function encryptPhoto(inviteKey: string, index: number, photo: Uint8Array): Promise<Uint8Array> {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PHOTOS) throw new Error("photo number out of range");
  if (photo.length === 0 || photo.length > PHOTO_MAX_BYTES) throw new Error(`a photo can be at most ${Math.round(PHOTO_MAX_BYTES / 1000)} KB`);
  const plain = new Uint8Array(4 + PHOTO_MAX_BYTES); // the rest stays zero: padding
  new DataView(plain.buffer).setUint32(0, photo.length, false);
  plain.set(photo, 4);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(inviteKey, "encrypt");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(aad(index)) }, key, buf(plain)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

/** Opens photo `index` of a private listing. Throws if the key is wrong or the photo was altered or moved. */
export async function decryptPhoto(inviteKey: string, index: number, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length !== SEALED_PHOTO_BYTES) throw new Error("the photo is damaged");
  const key = await aesKey(inviteKey, "decrypt");
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(sealed.subarray(0, 12)), additionalData: buf(aad(index)) }, key, buf(sealed.subarray(12))),
  );
  const length = new DataView(plain.buffer, plain.byteOffset, plain.byteLength).getUint32(0, false);
  if (length === 0 || length > PHOTO_MAX_BYTES) throw new Error("the photo is damaged");
  return plain.slice(4, 4 + length);
}
