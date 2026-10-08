// Delivery: how the thing that was auctioned reaches the winner without the
// site being able to read it.
//
//   - Every bid carries a public key made in the bidder's browser. The matching
//     private key stays in the bidder's ticket.
//   - A seller's keys are derived from their manage key, so the manage link is
//     all a seller has to keep.
//   - A digital lot is encrypted in the seller's browser with a lot key. The
//     site stores the ciphertext and a hash of the key. After the sale the
//     seller's browser seals the lot key to the winner's public key.
//   - A shipping address is sealed by the winner's browser to the seller's
//     public key.
//
// The site relays these sealed envelopes and cannot open them. The one
// exception is a dispute over a digital lot: the winner then hands over their
// delivery key, and `judgeDigitalDelivery` checks who is right.
//
// Primitives: X25519 (noble-curves), HKDF-SHA-256 and AES-256-GCM (WebCrypto).
import { x25519 } from "@noble/curves/ed25519";

const te = new TextEncoder();
const td = new TextDecoder();

/** The largest digital lot, before encryption. */
export const MAX_LOT_BYTES = 1024 * 1024;

// --- bytes -------------------------------------------------------------------

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(text: string, bytes: number, what: string): Uint8Array {
  if (typeof text !== "string" || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) throw new Error(`${what} must be ${bytes * 2} hex characters`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new Error("not base64");
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// WebCrypto wants plain ArrayBuffers.
const buf = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf(concat(...parts))));
}

// --- keys --------------------------------------------------------------------

/** A new delivery key (private), as hex. Made in the bidder's browser and kept in the ticket. */
export function newDeliveryKey(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

/** The public key that goes with a delivery key. */
export function deliveryPublic(privateKey: string): string {
  return hex(x25519.getPublicKey(unhex(privateKey, 32, "the delivery key")));
}

/**
 * Can something be sealed to this public key? A key of low order (all zeros,
 * say) can't: sealing to it fails. Checked when a bid is placed, so that a
 * bidder can't win with a key the seller is unable to deliver to.
 */
export function validDeliveryPublic(publicKey: string): boolean {
  try {
    x25519.getSharedSecret(x25519.utils.randomPrivateKey(), unhex(publicKey, 32, "the delivery key"));
    return true;
  } catch {
    return false;
  }
}

export interface SellerKeys {
  /** AES-256 key the lot is encrypted with. Never sent to the site. */
  lotKey: Uint8Array;
  /** Private key for opening what the winner sends (hex). Never sent to the site. */
  privateKey: string;
  /** Public key, published with the auction (hex). */
  publicKey: string;
}

/** A seller's keys, derived from the manage key in their link. */
export async function sellerKeys(manageKey: string): Promise<SellerKeys> {
  unhex(manageKey, 32, "the manage key");
  const lotKey = await sha256(te.encode(`dark-vault/v1/lot-key:${manageKey}`));
  const privateKey = hex(await sha256(te.encode(`dark-vault/v1/seller-key:${manageKey}`)));
  return { lotKey, privateKey, publicKey: deliveryPublic(privateKey) };
}

/**
 * Order Flow: the key one unit of a batch sale is encrypted with. Each unit has
 * its own, so handing one buyer their unit's key opens nobody else's unit.
 * Derived from the manage key, like everything else the seller holds.
 */
export async function unitLotKey(manageKey: string, index: number): Promise<Uint8Array> {
  unhex(manageKey, 32, "the manage key");
  if (!Number.isInteger(index) || index < 0 || index > 9999) throw new Error("not a unit of this sale");
  return sha256(te.encode(`dark-vault/v1/unit-lot-key:${index}:${manageKey}`));
}

/** What the site stores so that a delivered lot key can be checked: a hash that says nothing about the key. */
export async function lotKeyHash(lotKey: Uint8Array): Promise<string> {
  if (lotKey.length !== 32) throw new Error("the lot key must be 32 bytes");
  return hex(await sha256(te.encode("dark-vault/v1/lot-key-hash"), new Uint8Array([0]), lotKey));
}

// --- sealed envelopes --------------------------------------------------------

/** What an envelope is for. It is bound into the encryption, so an envelope can't be replayed for another purpose or auction. */
export function deliveryContext(auctionId: string, purpose: "lot-key" | "shipping" | "note"): string {
  return `dark-vault/v1/${purpose}:${auctionId}`;
}

async function envelopeKey(shared: Uint8Array, ephemeralPublic: Uint8Array, recipientPublic: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", buf(shared), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(concat(ephemeralPublic, recipientPublic)), info: buf(te.encode("dark-vault/v1/envelope")) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/**
 * Seals bytes so that only the holder of the recipient's private key can read
 * them. Returns base64 of: ephemeral public key (32) ‖ nonce (12) ‖ ciphertext.
 */
export async function seal(recipientPublic: string, plaintext: Uint8Array, context: string): Promise<string> {
  const to = unhex(recipientPublic, 32, "the recipient's public key");
  const ephemeral = crypto.getRandomValues(new Uint8Array(32));
  const ephemeralPublic = x25519.getPublicKey(ephemeral);
  const key = await envelopeKey(x25519.getSharedSecret(ephemeral, to), ephemeralPublic, to, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(te.encode(context)) }, key, buf(plaintext)));
  return toBase64(concat(ephemeralPublic, iv, ct));
}

/** Opens an envelope. Throws if it was not sealed to this key, for this context, or was altered. */
export async function open(privateKey: string, envelope: string, context: string): Promise<Uint8Array> {
  const priv = unhex(privateKey, 32, "the private key");
  const bytes = fromBase64(envelope);
  if (bytes.length < 32 + 12 + 16) throw new Error("the envelope is too short");
  const ephemeralPublic = bytes.subarray(0, 32);
  const iv = bytes.subarray(32, 44);
  const key = await envelopeKey(x25519.getSharedSecret(priv, ephemeralPublic), ephemeralPublic, x25519.getPublicKey(priv), "decrypt");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(te.encode(context)) }, key, buf(bytes.subarray(44))));
}

export const sealText = (recipientPublic: string, text: string, context: string) => seal(recipientPublic, te.encode(text), context);
export const openText = async (privateKey: string, envelope: string, context: string) => td.decode(await open(privateKey, envelope, context));

// --- digital lots ------------------------------------------------------------

export interface LotHeader {
  kind: "text" | "file";
  /** File name, for a file. */
  name?: string;
  /** Media type, for a file. */
  type?: string;
}

const LOT_AAD = te.encode("dark-vault/v1/lot");

/**
 * Encrypts a digital lot. Returns: nonce (12) ‖ ciphertext of
 * [header length (u32, big-endian) ‖ header JSON ‖ content].
 * The file name and type are inside the encryption.
 */
export async function encryptLot(lotKey: Uint8Array, header: LotHeader, content: Uint8Array): Promise<Uint8Array> {
  if (content.length === 0) throw new Error("the lot is empty");
  if (content.length > MAX_LOT_BYTES) throw new Error("the lot is larger than 1 MB");
  const head = te.encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, head.length, false);
  const key = await crypto.subtle.importKey("raw", buf(lotKey), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(LOT_AAD) }, key, buf(concat(length, head, content))));
  return concat(iv, ct);
}

/** Decrypts a digital lot. Throws if the key is wrong or the ciphertext was altered. */
export async function decryptLot(lotKey: Uint8Array, encrypted: Uint8Array): Promise<{ header: LotHeader; content: Uint8Array }> {
  if (lotKey.length !== 32) throw new Error("the lot key must be 32 bytes");
  if (encrypted.length < 12 + 16 + 4) throw new Error("the lot is too short");
  const key = await crypto.subtle.importKey("raw", buf(lotKey), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(encrypted.subarray(0, 12)), additionalData: buf(LOT_AAD) }, key, buf(encrypted.subarray(12))));
  const headLength = new DataView(plain.buffer, plain.byteOffset).getUint32(0, false);
  if (headLength > plain.length - 4) throw new Error("the lot header is damaged");
  const raw = JSON.parse(td.decode(plain.subarray(4, 4 + headLength))) as LotHeader;
  const header: LotHeader = { kind: raw.kind === "file" ? "file" : "text" };
  if (typeof raw.name === "string") header.name = raw.name.slice(0, 200);
  if (typeof raw.type === "string") header.type = raw.type.slice(0, 100);
  return { header, content: plain.subarray(4 + headLength) };
}

// --- disputes over a digital lot ---------------------------------------------

export type DeliveryVerdict =
  /** The delivery key handed over is not the one this bid registered. The dispute is not accepted. */
  | "not-your-key"
  /** The envelope doesn't open, the key doesn't match the listing, or it doesn't decrypt the lot. */
  | "seller-cheated"
  /** The seller delivered the key that was promised and it decrypts the lot. */
  | "key-was-right";

/**
 * Settles a dispute over a digital lot, with no judgement call: the winner
 * hands over their delivery key, and the same steps their browser took are
 * repeated. Whoever runs this learns the lot key if the verdict is
 * "key-was-right".
 */
export async function judgeDigitalDelivery(input: {
  auctionId: string;
  /** What the seller delivered. */
  envelope: string;
  /** The winner's delivery key (private), handed over for the dispute. */
  deliveryKey: string;
  /** The public key the winning bid registered when it was placed. */
  deliveryPublic: string;
  /** The hash of the lot key, from the listing. */
  keyHash: string;
  /** The encrypted lot, from the listing. */
  lot: Uint8Array;
}): Promise<DeliveryVerdict> {
  try {
    if (deliveryPublic(input.deliveryKey) !== input.deliveryPublic) return "not-your-key";
  } catch {
    return "not-your-key";
  }
  try {
    const lotKey = await open(input.deliveryKey, input.envelope, deliveryContext(input.auctionId, "lot-key"));
    if ((await lotKeyHash(lotKey)) !== input.keyHash) return "seller-cheated";
    await decryptLot(lotKey, input.lot);
    return "key-was-right";
  } catch {
    return "seller-cheated";
  }
}
