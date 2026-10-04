// Auction records: one JSON file each in <data>/auctions/. A per-auction lock
// makes every change read-modify-write, one at a time, in this one server process.
import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./datadir";
import type { Auction } from "./types";

const DIR = path.join(DATA_DIR, "auctions");
const ID = /^[0-9a-f]{32}$/;

function fileFor(id: string): string {
  if (!ID.test(id)) throw new Error("bad auction id");
  return path.join(DIR, `${id}.json`);
}

export async function loadAuction(id: string): Promise<Auction | null> {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf8")) as Auction;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function write(auction: Auction): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  const file = fileFor(auction.id);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(auction, null, 1), "utf8");
  await fs.rename(tmp, file); // atomic replace
}

export async function createAuction(auction: Auction): Promise<void> {
  if (await loadAuction(auction.id)) throw new Error("auction already exists");
  await write(auction);
}

export async function listAuctions(): Promise<Auction[]> {
  let names: string[];
  try {
    names = await fs.readdir(DIR);
  } catch {
    return [];
  }
  const out: Auction[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    const a = await loadAuction(name.slice(0, 32));
    if (a) out.push(a);
  }
  return out.sort((a, b) => b.created_at - a.created_at);
}

// The locks survive hot reloads in development by living on globalThis.
const locks: Map<string, Promise<unknown>> = ((globalThis as Record<string, unknown>).__dvLocks ??= new Map()) as Map<string, Promise<unknown>>;

/**
 * Runs `change` with the auction loaded, one caller at a time per auction, and
 * saves the record afterwards if `change` returns true or a value other than false.
 * Returns whatever `change` returned.
 */
export async function withAuction<T>(id: string, change: (auction: Auction) => Promise<T> | T): Promise<T | null> {
  const previous = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = previous.then(() => mine);
  locks.set(id, chained);
  await previous.catch(() => {});
  try {
    const auction = await loadAuction(id);
    if (!auction) return null;
    const before = JSON.stringify(auction);
    const result = await change(auction);
    if (JSON.stringify(auction) !== before) await write(auction);
    return result;
  } finally {
    release();
    if (locks.get(id) === chained) locks.delete(id);
  }
}

// --- encrypted digital lots: <data>/lots/<auction id>.bin ---------------------

const LOTS = path.join(DATA_DIR, "lots");

export async function saveLot(id: string, bytes: Uint8Array): Promise<void> {
  if (!ID.test(id)) throw new Error("bad auction id");
  await fs.mkdir(LOTS, { recursive: true });
  await fs.writeFile(path.join(LOTS, `${id}.bin`), bytes, { flag: "wx" }); // never overwritten
}

export async function loadLot(id: string): Promise<Uint8Array | null> {
  if (!ID.test(id)) return null;
  try {
    return new Uint8Array(await fs.readFile(path.join(LOTS, `${id}.bin`)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// --- results and their proofs: <data>/proofs/<auction id>.json ----------------
//
// Public once the auction is decided: the statement lists the board and the result, and the
// proof shows the result is right without giving away the losing bids.

const PROOFS = path.join(DATA_DIR, "proofs");

/**
 * Saves a result and its proof, and returns its size in bytes. Called once, as
 * the auction is decided; the file is served only after the auction record
 * says so, so a pass that was interrupted before that can safely write again.
 */
export async function saveProof(id: string, body: unknown): Promise<number> {
  if (!ID.test(id)) throw new Error("bad auction id");
  await fs.mkdir(PROOFS, { recursive: true });
  const text = JSON.stringify(body);
  const file = path.join(PROOFS, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
  return Buffer.byteLength(text);
}

export async function loadProof(id: string): Promise<string | null> {
  if (!ID.test(id)) return null;
  try {
    return await fs.readFile(path.join(PROOFS, `${id}.json`), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
