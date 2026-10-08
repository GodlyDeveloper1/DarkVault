// Moving house. Dark Vault has no accounts: a visitor's bids, seller keys and
// invites live in their browser's local storage and nowhere else. This file
// packs all of that into one file they can carry to another browser or
// device, or keep as a backup, and unpacks it again.
//
// Nothing here talks to the server. The file is made and read in the browser.
// With a passphrase it is encrypted (AES-256-GCM, key from PBKDF2-SHA-256);
// without one it is plain text and says so.
import { isInviteKey } from "vault-core";
import { holdsInvite, rememberInvite } from "./invites";
import { allTickets, announce, loadTickets, parseBackup, saveTicket, type Ticket } from "./tickets";
import { addressProblem, loadWallet, maskAddress, saveWallet } from "./wallet";

export const VAULT_FILE_HEADER = "DARK VAULT FILE (Zcash testnet). Keep this private: it holds the bids, seller keys and invites of one browser.";

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;
const PRACTICE = /^[0-9a-f]{24}\.[0-9a-f]{48}$/;
/** PBKDF2 rounds for a new file. (A file says how many it was made with, so older files still open.) */
const ITERATIONS = 600_000;
/** The shortest passphrase a file can be locked with. */
export const MIN_PASSPHRASE = 8;
/** A vault file is small. Anything larger is not one. */
const MAX_FILE_CHARS = 4_000_000;
const MAX_TICKETS = 2000;

export interface VaultBundle {
  v: 1;
  made_at: number;
  tickets: Ticket[];
  /** Auction id to the seller's manage key. */
  manage: Record<string, string>;
  /** Auction id to the invite key of a private auction. */
  invites: Record<string, string>;
  /** The saved refund address, if the visitor chose to save one. */
  refund_address: string | null;
  /** The practice wallet's token. */
  practice: string | null;
}

interface Locked {
  v: 1;
  locked: true;
  kdf: "PBKDF2-SHA-256";
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

export interface Counts {
  bids: number;
  listings: number;
  invites: number;
  practice: boolean;
  refund: boolean;
  /** After a restore: the refund address that was added, shortened, so the visitor can see it is theirs. */
  refundAddress?: string;
}

function keysWith(prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(prefix)) continue;
      const id = k.slice(prefix.length);
      const value = localStorage.getItem(k);
      if (ID.test(id) && value && HEX64.test(value)) out[id] = value;
    }
  } catch {
    /* no storage */
  }
  return out;
}

/** Everything this browser holds. */
export function collect(): VaultBundle {
  let practice: string | null = null;
  try {
    const t = localStorage.getItem("dv-practice");
    practice = t && PRACTICE.test(t) ? t : null;
  } catch {
    /* no storage */
  }
  return {
    v: 1,
    made_at: Date.now(),
    tickets: allTickets(),
    manage: keysWith("dv-manage-"),
    invites: keysWith("dv-invite-"),
    refund_address: loadWallet()?.refund_address ?? null,
    practice,
  };
}

export const countsOf = (b: VaultBundle): Counts => ({
  bids: b.tickets.length,
  listings: Object.keys(b.manage).length,
  invites: Object.keys(b.invites).length,
  practice: !!b.practice,
  refund: !!b.refund_address,
});

export const isEmpty = (c: Counts) => c.bids + c.listings + c.invites === 0 && !c.practice && !c.refund;

const hex = (bytes: Uint8Array) => Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (text: string) => new Uint8Array((text.match(/../g) ?? []).map((x) => parseInt(x, 16)));
function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function keyFrom(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** The text of a vault file. With a passphrase the contents are encrypted. */
export async function packVault(bundle: VaultBundle, passphrase: string): Promise<string> {
  let body: VaultBundle | Locked = bundle;
  if (passphrase && passphrase.length < MIN_PASSPHRASE) throw new Error(`a passphrase needs at least ${MIN_PASSPHRASE} characters`);
  if (passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await keyFrom(passphrase, salt, ITERATIONS);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(JSON.stringify(bundle))));
    body = { v: 1, locked: true, kdf: "PBKDF2-SHA-256", iterations: ITERATIONS, salt: hex(salt), iv: hex(iv), data: b64(data) };
  }
  const note = passphrase ? "Locked with a passphrase. Without it this file can't be opened, by anyone." : "NOT locked: anyone who has this file can read it.";
  return [VAULT_FILE_HEADER, note, "", JSON.stringify(body, null, 1), ""].join("\n");
}

/** Keeps only what is well formed: a file is somebody's typing, or somebody's trick. */
function clean(raw: unknown): VaultBundle | null {
  const x = raw as Partial<VaultBundle> | null;
  if (!x || typeof x !== "object" || x.v !== 1) return null;
  const pairs = (m: unknown, ok: (v: unknown) => boolean) =>
    Object.fromEntries(Object.entries(m && typeof m === "object" ? (m as Record<string, unknown>) : {}).filter(([id, v]) => ID.test(id) && ok(v))) as Record<string, string>;
  return {
    v: 1,
    made_at: Number.isSafeInteger(x.made_at) ? (x.made_at as number) : 0,
    tickets: parseBackup(JSON.stringify(Array.isArray(x.tickets) ? x.tickets.slice(0, MAX_TICKETS) : [])),
    manage: pairs(x.manage, (v) => typeof v === "string" && HEX64.test(v)),
    invites: pairs(x.invites, isInviteKey),
    // Only something that looks like a testnet unified address: it will be offered wherever a refund address is asked for.
    refund_address: typeof x.refund_address === "string" && x.refund_address.trim() !== "" && x.refund_address.length <= 400 && addressProblem(x.refund_address) === null ? x.refund_address.trim() : null,
    practice: typeof x.practice === "string" && PRACTICE.test(x.practice) ? x.practice : null,
  };
}

export type Opened = { kind: "bundle"; bundle: VaultBundle } | { kind: "locked" } | { kind: "wrong-passphrase" } | { kind: "not-a-vault-file" };

/**
 * Reads a file back. It takes a vault file, and also the older ticket files
 * (one ticket, or a backup of all tickets), which become a bundle of bids.
 */
export async function openVault(text: string, passphrase = ""): Promise<Opened> {
  if (text.length > MAX_FILE_CHARS) return { kind: "not-a-vault-file" };
  const start = text.search(/^[[{]/m);
  if (start < 0) return { kind: "not-a-vault-file" };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start));
  } catch {
    return { kind: "not-a-vault-file" };
  }
  const locked = raw as Partial<Locked>;
  if (locked && locked.locked === true) {
    if (!passphrase) return { kind: "locked" };
    try {
      const iterations = Number.isSafeInteger(locked.iterations) && locked.iterations! >= 1000 && locked.iterations! <= 5_000_000 ? locked.iterations! : ITERATIONS;
      const key = await keyFrom(passphrase, unhex(String(locked.salt)), iterations);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(String(locked.iv)) as BufferSource }, key, unb64(String(locked.data)) as BufferSource);
      const bundle = clean(JSON.parse(new TextDecoder().decode(plain)));
      return bundle ? { kind: "bundle", bundle } : { kind: "not-a-vault-file" };
    } catch {
      return { kind: "wrong-passphrase" };
    }
  }
  const bundle = clean(raw);
  if (bundle) return { kind: "bundle", bundle };
  // An older ticket file.
  const tickets = parseBackup(text);
  return tickets.length ? { kind: "bundle", bundle: { v: 1, made_at: 0, tickets, manage: {}, invites: {}, refund_address: null, practice: null } } : { kind: "not-a-vault-file" };
}

/**
 * Adds a bundle to this browser. It only adds: a bid, key or invite this
 * browser already holds is left as it is, and so is a practice wallet or a
 * saved address it already has. Returns what was new.
 *
 * A file can come from anyone, so what it adds is only ever a claim. The pages
 * check each claim with the site before acting on it: a ticket's payment
 * address is never shown (the site's own record is), and a seller key or an
 * invite that isn't the right one simply opens nothing.
 */
export function applyVault(bundle: VaultBundle): Counts {
  const added: Counts = { bids: 0, listings: 0, invites: 0, practice: false, refund: false };
  try {
    for (const [id, key] of Object.entries(bundle.manage)) {
      if (localStorage.getItem(`dv-manage-${id}`)) continue;
      localStorage.setItem(`dv-manage-${id}`, key);
      added.listings++;
    }
    for (const [id, invite] of Object.entries(bundle.invites)) {
      if (holdsInvite(id)) continue;
      rememberInvite(id, invite);
      added.invites++;
    }
    if (bundle.practice && !localStorage.getItem("dv-practice")) {
      localStorage.setItem("dv-practice", bundle.practice);
      added.practice = true;
    }
  } catch {
    /* no storage: nothing more can be kept */
  }
  // Tickets last: a ticket carries an invite of its own, which must not get in ahead of the ones above.
  for (const t of bundle.tickets) {
    if (loadTickets(t.auction_id).some((mine) => mine.bid_id === t.bid_id)) continue;
    saveTicket(t);
    added.bids++;
  }
  if (bundle.refund_address && !loadWallet()) {
    saveWallet({ kind: "own", refund_address: bundle.refund_address, connected_at: Date.now() });
    added.refund = true;
    added.refundAddress = maskAddress(bundle.refund_address);
  }
  announce();
  return added;
}

/** "2 bids, 1 listing and a practice wallet". */
export function describe(c: Counts): string {
  const parts = [
    c.bids ? `${c.bids} ${c.bids === 1 ? "bid" : "bids"}` : "",
    c.listings ? `${c.listings} ${c.listings === 1 ? "listing" : "listings"}` : "",
    c.invites ? `${c.invites} ${c.invites === 1 ? "invite" : "invites"}` : "",
    c.practice ? "a practice wallet" : "",
    c.refund ? "a saved refund address" : "",
  ].filter(Boolean);
  if (parts.length === 0) return "nothing";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
