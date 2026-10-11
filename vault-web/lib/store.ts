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

/** Any record, whatever it is. Routes use `loadAuction`, which leaves out the units of a batch sale. */
export async function loadRecord(id: string): Promise<Auction | null> {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf8")) as Auction;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * An auction, a deal or a batch sale. A sold unit of a batch sale is a record
 * too, but not one anybody may ask for by id: here it does not exist.
 */
export async function loadAuction(id: string): Promise<Auction | null> {
  const record = await loadRecord(id);
  return record && !record.unit_of ? record : null;
}

/** One sold unit of a batch sale. For the engine and the sale's own routes. */
export async function loadUnit(id: string): Promise<Auction | null> {
  const record = await loadRecord(id);
  return record?.unit_of ? record : null;
}

async function write(auction: Auction): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  const file = fileFor(auction.id);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(auction, null, 1), "utf8");
  await fs.rename(tmp, file); // atomic replace
}

export async function createAuction(auction: Auction): Promise<void> {
  if (await loadRecord(auction.id)) throw new Error("auction already exists");
  await write(auction);
}

/** Every record, the units of batch sales included. For the engine's timer and the operator. */
export async function listRecords(): Promise<Auction[]> {
  let names: string[];
  try {
    names = await fs.readdir(DIR);
  } catch {
    return [];
  }
  const out: Auction[] = [];
  for (const name of names) {
    if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
    const a = await loadRecord(name.slice(0, 32));
    if (a) out.push(a);
  }
  return out.sort((a, b) => b.created_at - a.created_at);
}

/** Auctions, deals and batch sales. Never a batch sale's units. */
export async function listAuctions(): Promise<Auction[]> {
  return (await listRecords()).filter((a) => !a.unit_of);
}

// The locks survive hot reloads in development by living on globalThis.
const locks: Map<string, Promise<unknown>> = ((globalThis as Record<string, unknown>).__dvLocks ??= new Map()) as Map<string, Promise<unknown>>;

async function withRecord<T>(id: string, unit: boolean, change: (auction: Auction) => Promise<T> | T): Promise<T | null> {
  const previous = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = previous.then(() => mine);
  locks.set(id, chained);
  await previous.catch(() => {});
  try {
    const auction = await loadRecord(id);
    if (!auction || !!auction.unit_of !== unit) return null;
    const before = JSON.stringify(auction);
    const result = await change(auction);
    if (JSON.stringify(auction) !== before) await write(auction);
    return result;
  } finally {
    release();
    if (locks.get(id) === chained) locks.delete(id);
  }
}

/**
 * Runs `change` with the auction loaded, one caller at a time per auction, and
 * saves the record afterwards if `change` changed it. Returns whatever
 * `change` returned, or null if there is no such auction (a batch sale's unit
 * is not one: see `withUnit`).
 */
export function withAuction<T>(id: string, change: (auction: Auction) => Promise<T> | T): Promise<T | null> {
  return withRecord(id, false, change);
}

/**
 * The same for one sold unit of a batch sale. Never called while that unit's
 * own lock is held, and a unit's `change` never takes the sale's lock, so the
 * two can't wait on each other.
 */
export function withUnit<T>(id: string, change: (unit: Auction) => Promise<T> | T): Promise<T | null> {
  return withRecord(id, true, change);
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

// --- listing photos: <data>/photos/<auction id>.<n>.bin ----------------------

const PHOTOS = path.join(DATA_DIR, "photos");
const photoFile = (id: string, index: number) => {
  if (!ID.test(id) || !Number.isInteger(index) || index < 0 || index > 9) throw new Error("bad photo");
  return path.join(PHOTOS, `${id}.${index}.bin`);
};

export async function savePhoto(id: string, index: number, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(PHOTOS, { recursive: true });
  await fs.writeFile(photoFile(id, index), bytes, { flag: "wx" }); // never overwritten
}

export async function loadPhoto(id: string, index: number): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fs.readFile(photoFile(id, index)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

// Order Flow: each unit of a batch sale has its own encrypted lot, <data>/lots/<sale id>.u<n>.bin

const unitLotFile = (id: string, index: number) => {
  if (!ID.test(id) || !Number.isInteger(index) || index < 0 || index > 999) throw new Error("bad unit");
  return path.join(LOTS, `${id}.u${index}.bin`);
};

export async function saveUnitLot(id: string, index: number, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(LOTS, { recursive: true });
  await fs.writeFile(unitLotFile(id, index), bytes, { flag: "wx" }); // never overwritten
}

export async function loadUnitLot(id: string, index: number): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fs.readFile(unitLotFile(id, index)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** The encrypted lot a record's delivery is about: its own, or, for a unit of a batch sale, that unit's. */
export function lotOf(auction: Auction): Promise<Uint8Array | null> {
  return auction.unit_of ? loadUnitLot(auction.unit_of.parent, auction.unit_of.index) : loadLot(auction.id);
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
