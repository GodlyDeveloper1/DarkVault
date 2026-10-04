// Private auctions: a listing only invited people can read.
//
//   - The seller's browser encrypts the title and description before they are
//     sent. The site stores the ciphertext and can't read what is being sold.
//   - The key that opens it, the invite key, travels in the invite link's
//     #fragment, which browsers never send to a server.
//   - To fetch the auction or to bid, a browser shows the site an access token
//     derived from the invite key. The site stores that token's hash, so it
//     can tell who was invited without ever holding the key.
//   - The invite key is derived from the seller's manage key, so the seller's
//     own link is still all a seller has to keep.
//
// The site still runs the auction, so it knows the reserve, the times and how
// many bids there are. What it can't see is what the lot is.
//
// Primitives: SHA-256 and AES-256-GCM (WebCrypto).

const te = new TextEncoder();

/** Every encrypted listing holds exactly this many bytes, so its size says nothing about the text. */
export const LISTING_BYTES = 4096;
/** What the site stores for a private listing: nonce (12) ‖ ciphertext (LISTING_BYTES + 16-byte tag). */
export const SEALED_LISTING_BYTES = 12 + LISTING_BYTES + 16;
export const LISTING_TITLE_MAX = 80;
export const LISTING_DESCRIPTION_MAX = 1200;

const LISTING_AAD = te.encode("dark-vault/v1/listing");

export interface ListingText {
  title: string;
  description: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(text: string, what: string): Uint8Array {
  if (typeof text !== "string" || !HEX64.test(text)) throw new Error(`${what} must be 64 hex characters`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const buf = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf(te.encode(text)))));
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error("not base64");
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// --- keys --------------------------------------------------------------------

/** The invite key of a seller's auction, derived from their manage key. One-way: an invite key says nothing about the manage key. */
export async function inviteFromManage(manageKey: string): Promise<string> {
  unhex(manageKey, "the manage key");
  return sha256Hex(`dark-vault/v1/invite:${manageKey}`);
}

/** What a browser shows the site to be let into a private auction. The site stores its hash. */
export async function inviteAccess(inviteKey: string): Promise<string> {
  unhex(inviteKey, "the invite key");
  return sha256Hex(`dark-vault/v1/invite-access:${inviteKey}`);
}

/**
 * The key the listing is encrypted with (hex). It opens the listing and
 * nothing else: it is what a winner hands the operator when a dispute needs
 * the description read.
 */
export async function listingKey(inviteKey: string): Promise<string> {
  unhex(inviteKey, "the invite key");
  return sha256Hex(`dark-vault/v1/listing-key:${inviteKey}`);
}

/** Is this what an invite link carries? */
export const isInviteKey = (text: unknown): text is string => typeof text === "string" && HEX64.test(text);

/**
 * Finds the invite key in whatever a person pastes: a whole invite link, the
 * part after the #, or the key by itself. Returns null if there is none.
 */
export function inviteFromText(text: string): string | null {
  const t = text.trim();
  // Followed by anything but another hex digit: a link pasted with a full stop or more words after it still counts.
  const m = /(?:^|[#&?\s])invite=([0-9a-f]{64})(?![0-9a-f])/.exec(t);
  if (m) return m[1]!;
  return HEX64.test(t) ? t : null;
}

// --- the listing -------------------------------------------------------------

function pack({ title, description }: ListingText): Uint8Array {
  if (title.length > LISTING_TITLE_MAX) throw new Error(`the title can have at most ${LISTING_TITLE_MAX} characters`);
  if (description.length > LISTING_DESCRIPTION_MAX) throw new Error(`the description can have at most ${LISTING_DESCRIPTION_MAX} characters`);
  const t = te.encode(title);
  const d = te.encode(description);
  // Fits by construction: a character is at most 3 bytes for each unit of its length.
  if (4 + t.length + d.length > LISTING_BYTES) throw new Error("the listing is too long");
  const out = new Uint8Array(LISTING_BYTES); // the rest stays zero: padding
  const view = new DataView(out.buffer);
  view.setUint16(0, t.length, false);
  out.set(t, 2);
  view.setUint16(2 + t.length, d.length, false);
  out.set(d, 4 + t.length);
  return out;
}

function unpack(bytes: Uint8Array): ListingText {
  if (bytes.length !== LISTING_BYTES) throw new Error("the listing is damaged");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tl = view.getUint16(0, false);
  if (2 + tl + 2 > LISTING_BYTES) throw new Error("the listing is damaged");
  const dl = view.getUint16(2 + tl, false);
  if (4 + tl + dl > LISTING_BYTES) throw new Error("the listing is damaged");
  const strict = new TextDecoder("utf-8", { fatal: true });
  return { title: strict.decode(bytes.subarray(2, 2 + tl)), description: strict.decode(bytes.subarray(4 + tl, 4 + tl + dl)) };
}

async function aes(keyHex: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(unhex(keyHex, "the listing key")), "AES-GCM", false, [usage]);
}

/** Encrypts a listing, padded to a fixed size. Returns base64 of nonce (12) ‖ ciphertext. */
export async function encryptListing(inviteKey: string, text: ListingText): Promise<string> {
  const key = await aes(await listingKey(inviteKey), "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(LISTING_AAD) }, key, buf(pack(text))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return toBase64(out);
}

/** Opens a listing with its listing key. Throws if the key is wrong or the ciphertext was altered. */
export async function decryptListingWithKey(listingKeyHex: string, sealed: string): Promise<ListingText> {
  const bytes = fromBase64(sealed);
  if (bytes.length !== SEALED_LISTING_BYTES) throw new Error("the listing is damaged");
  const key = await aes(listingKeyHex, "decrypt");
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(bytes.subarray(0, 12)), additionalData: buf(LISTING_AAD) }, key, buf(bytes.subarray(12))));
  return unpack(plain);
}

/** Opens a listing with the invite key from the link. */
export async function decryptListing(inviteKey: string, sealed: string): Promise<ListingText> {
  return decryptListingWithKey(await listingKey(inviteKey), sealed);
}

/** Has this the shape of an encrypted listing? All the site can check: it can't open one. */
export function validSealedListing(sealed: unknown): sealed is string {
  if (typeof sealed !== "string" || sealed.length > 6000) return false;
  try {
    return fromBase64(sealed).length === SEALED_LISTING_BYTES;
  } catch {
    return false;
  }
}
