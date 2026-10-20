// The house purse: the coins behind practice auctions.
//
// It lives in a second signer (the house signer), which is a wallet of its
// own. From the main signer's side a payment from the purse is a deposit from
// outside, the same as one from a visitor's wallet.
//
// That signer has one way to spend: pay out everything a vault holds, in one
// transaction, once every coin in it is confirmed. The purse is built to fit:
//
//   treasury   one vault that everything comes back to: refunds, sale
//              proceeds, top-ups from whoever runs the site.
//   slots      small vaults holding exactly one deposit each, made ahead of
//              time. Paying a deposit empties one slot, so several deposits
//              can be paid at the same moment without waiting on each other.
//
// "Refilling" pays out the treasury: a few new slots, and the rest to a new
// treasury vault (the old one takes no new addresses once it has paid out).
// Coins that reach a vault the purse has finished with (an old treasury, or a
// slot whose payment expired unmined) are swept on to the current treasury.
//
// Money only moves in `refill`, `sweep` and `payFromSlot`, always to an
// address this module chose: a slot, a treasury, or the deposit address the
// caller gives `payFromSlot`.
//
// Before any payment is asked for, what it is for is written to disk. If the
// answer is lost (the server stops, the connection drops), the next pass asks
// the signer what happened and carries on from there, so nothing is paid
// twice and no vault holding coins is forgotten.
import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../datadir";
import { replaceFile } from "../store";
import { houseSigner, vaultInfo as mainVaultInfo } from "../signer";
import { HOUSE, slotAmount } from "./config";

const DIR = path.join(DATA_DIR, "house");
const FILE = path.join(DIR, "purse.json");

export interface Slot {
  /** PRIVATE. A vault in the house signer holding one deposit. */
  vault_id: string;
  address: string;
  zatoshis: number;
  made_at: number;
  /** Its coins are confirmed enough to spend. */
  ready: boolean;
  /** A payment from this slot was asked for. Cleared when it is known to have gone, or not. */
  paying?: { to: string; at: number };
}

/** A vault the purse has finished with. Coins can still turn up in it and are swept on. */
interface Finished {
  vault_id: string;
  kind: "treasury" | "slot";
  at: number;
  checked_at?: number;
}

/** A refill that has been asked for: the treasury it empties and the vaults it fills. */
interface RefillPlan {
  source: string;
  /** How many payouts the source had made before this one. */
  settled_before: number;
  next: string;
  next_address: string;
  slots: Slot[];
  made_at: number;
}

export interface Purse {
  treasury: { vault_id: string; made_at: number } | null;
  /** What the treasury held when last looked at. */
  treasury_seen?: { total: number; spendable: number; at: number };
  finished: Finished[];
  slots: Slot[];
  refill?: RefillPlan;
  /** Practice auctions listed so far. */
  counter: number;
  /** Practice auctions listed, per day, to cap them. */
  started: { day: string; n: number };
  /** The latest practice auction. */
  current: string | null;
  /** Practice auctions the house still has something to do in (as seller or bidder). */
  active: string[];
  /** Since when no practice auction has had anything left to pay. */
  idle_since?: number;
  /** Practice wallets made, per day, to cap them. */
  wallets: { day: string; made: number };
  /** The last thing that went wrong, for whoever runs the site. */
  last_error?: string;
}

const EMPTY: Purse = { treasury: null, finished: [], slots: [], counter: 0, started: { day: "", n: 0 }, current: null, active: [], wallets: { day: "", made: 0 } };

async function load(): Promise<Purse> {
  try {
    return { ...structuredClone(EMPTY), ...(JSON.parse(await fs.readFile(FILE, "utf8")) as Purse) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
    throw e;
  }
}

/** Writes the purse now. Used before a payment is asked for, so that what it was for survives a crash. */
export async function savePurse(purse: Purse): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await replaceFile(FILE, JSON.stringify(purse, null, 1));
}

// One change to the purse at a time, in this one server process. The queue
// lives on globalThis and is read from there on every call: the development
// server can load this file more than once (the timer keeps an old copy after
// a reload), and each copy holding its own queue would let two changes run at
// once and one overwrite the other.
const shared = globalThis as { __dvPurse?: Promise<unknown> };

/** Runs `change` with the purse loaded, one caller at a time, and saves it afterwards if it changed. */
export function withPurse<T>(change: (purse: Purse) => Promise<T> | T): Promise<T> {
  const run = (shared.__dvPurse ?? Promise.resolve()).then(async () => {
    const purse = await load();
    const before = JSON.stringify(purse);
    try {
      return await change(purse);
    } finally {
      // Saved even when `change` throws: what it had already done (a slot spent, say) must not be forgotten.
      if (JSON.stringify(purse) !== before) await savePurse(purse);
    }
  });
  shared.__dvPurse = run.catch(() => {});
  return run;
}

export const readPurse = load;
export const today = () => new Date().toISOString().slice(0, 10);

const signer = () => {
  if (!houseSigner) throw new Error("this site has no house purse");
  return houseSigner;
};

/** Has this vault made a payout that still stands (pending or mined)? */
const paidOut = (info: { settlements: { status: string }[] }, before = 0) => info.settlements.slice(before).some((s) => s.status !== "expired");

/** The treasury, made on first use. */
async function treasuryOf(purse: Purse): Promise<string> {
  if (!purse.treasury) {
    const vault_id = (await signer().createVault()).vault_id;
    // The house must be a wallet of its own. If the main signer knows this
    // vault, both addresses lead to one wallet: its payments to itself would
    // not count as deposits, and practice bids would never be funded.
    const same = await mainVaultInfo(vault_id, true).then(
      () => true,
      () => false,
    );
    if (same) throw new Error("HOUSE_SIGNER_URL leads to the main signer. The house needs a second signer with its own data folder (scripts/house-signer.ps1).");
    purse.treasury = { vault_id, made_at: Date.now() };
  }
  return purse.treasury.vault_id;
}

/**
 * A fresh address of the treasury: where a refund, the sale proceeds or a
 * top-up should go. Call inside `withPurse`.
 */
export async function treasuryAddress(purse: Purse): Promise<string> {
  // A refill that was asked for and may have happened: find out first, or the old treasury would refuse.
  if (purse.refill) await resumeRefill(purse, Date.now());
  return signer().newDepositAddress(await treasuryOf(purse));
}

/** Slots that can pay a deposit right now. */
export const readySlots = (purse: Purse) => purse.slots.filter((s) => s.ready && !s.paying && s.zatoshis >= HOUSE.ceiling + 10_000);

function finish(purse: Purse, slot: Slot, now: number): void {
  purse.slots = purse.slots.filter((s) => s !== slot);
  // Kept an eye on for a while: if its payment expires unmined, the coins are back in it.
  purse.finished.push({ vault_id: slot.vault_id, kind: "slot", at: now });
}

/**
 * Pays one deposit: empties a ready slot into `to`. Returns what arrived (the
 * slot, less the network fee). Asking twice for the same address pays once.
 * Call inside `withPurse`.
 */
export async function payFromSlot(purse: Purse, to: string): Promise<{ sent: number; txid: string }> {
  const now = Date.now();
  // A payment to this address was asked for before and its answer never came: see what became of it.
  const earlier = purse.slots.find((s) => s.paying?.to === to);
  if (earlier) {
    const info = await signer().vaultInfo(earlier.vault_id, true);
    const done = [...info.settlements].reverse().find((s) => s.status !== "expired");
    if (done) {
      finish(purse, earlier, now);
      return { sent: done.payments[0]?.zatoshis ?? earlier.zatoshis, txid: done.txid };
    }
    delete earlier.paying; // it never happened
  }

  let problem: unknown = new Error("the practice purse has no coins ready right now");
  for (const slot of readySlots(purse)) {
    slot.paying = { to, at: now };
    await savePurse(purse); // on disk before the payment is asked for
    try {
      const result = await signer().settleVault(slot.vault_id, [{ to, zatoshis: slot.zatoshis, pays_fee: true }]);
      finish(purse, slot, now);
      return { sent: result.payments[0]?.zatoshis ?? slot.zatoshis, txid: result.txid };
    } catch (e) {
      problem = e;
      // Did it go out all the same? If the signer can't say, stop: the mark stays, and the next try looks before paying.
      const info = await signer().vaultInfo(slot.vault_id, true);
      const done = [...info.settlements].reverse().find((s) => s.status !== "expired");
      if (done) {
        finish(purse, slot, now);
        return { sent: done.payments[0]?.zatoshis ?? slot.zatoshis, txid: done.txid };
      }
      delete slot.paying;
      slot.ready = false; // looked ready and wasn't: checked again on the next pass, and the next slot is tried now
    }
  }
  throw problem;
}

/** Looks at the slots that are not ready: confirmed by now? a payment that went out after all? funding that never came? */
async function checkSlots(purse: Purse, now: number): Promise<void> {
  for (const slot of [...purse.slots]) {
    // A slot from before the deposit size was raised can't pay a deposit any more: its coins go back to the treasury.
    if (slot.ready && !slot.paying && slot.zatoshis < HOUSE.ceiling + 10_000) {
      purse.slots = purse.slots.filter((s) => s !== slot);
      purse.finished.push({ vault_id: slot.vault_id, kind: "slot", at: now });
      continue;
    }
    if (slot.ready && !(slot.paying && now - slot.paying.at > 60_000)) continue;
    const info = await signer().vaultInfo(slot.vault_id, true);
    if (slot.paying) {
      if (paidOut(info)) finish(purse, slot, now);
      else delete slot.paying;
      continue;
    }
    if (info.balance_total_zatoshis >= HOUSE.ceiling + 10_000 && info.balance_spendable_zatoshis === info.balance_total_zatoshis) {
      slot.zatoshis = info.balance_total_zatoshis;
      slot.ready = true;
    } else if (info.balance_total_zatoshis === 0 && now - slot.made_at > 60 * 60_000) {
      finish(purse, slot, now); // its funding never arrived; watched a while longer in case it does
    }
  }
}

/** How long a finished vault is watched: a slot until its payment can no longer expire, a treasury for as long as a dispute could take. */
const WATCH_MS = { slot: 6 * 3600_000, treasury: 60 * 24 * 3600_000 };

/** Coins that arrived at a vault the purse had finished with go on to the current treasury. */
async function sweep(purse: Purse, now: number): Promise<void> {
  purse.finished = purse.finished.filter((f) => now - f.at < WATCH_MS[f.kind]);
  for (const f of purse.finished) {
    // Looked at often while fresh, then less and less: old vaults rarely receive anything.
    const every = Math.max(45_000, Math.min((now - f.at) / 8, 6 * 3600_000));
    if (now - (f.checked_at ?? 0) < every) continue;
    f.checked_at = now;
    try {
      const info = await signer().vaultInfo(f.vault_id, true);
      const total = info.balance_total_zatoshis;
      // Less than this can't carry a network fee.
      if (total < 30_000 || info.balance_spendable_zatoshis !== total || info.settlement?.status === "pending") continue;
      await signer().settleVault(f.vault_id, [{ to: await treasuryAddress(purse), zatoshis: total, pays_fee: true }]);
    } catch (e) {
      // One vault that can't be swept must not stop the others, or the refill.
      purse.last_error = `sweeping ${f.kind} ${f.vault_id}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

/** Slots the purse aims to hold: one per house bidder and a few for visitors. */
const target = () => HOUSE.bots + HOUSE.visitorSlots;

/** A refill went through: the treasury has moved on and the new slots exist. */
function adopt(purse: Purse, plan: RefillPlan, now: number): void {
  purse.finished.push({ vault_id: plan.source, kind: "treasury", at: now });
  purse.treasury = { vault_id: plan.next, made_at: now };
  purse.slots.push(...plan.slots);
  delete purse.refill;
  delete purse.treasury_seen;
}

/** Pays out the treasury as a plan says. Throws if the signer refuses. */
async function payRefill(purse: Purse, plan: RefillPlan, total: number, now: number): Promise<void> {
  await signer().settleVault(plan.source, [
    ...plan.slots.map((s) => ({ to: s.address, zatoshis: s.zatoshis, pays_fee: false })),
    // The rest carries the whole network fee, so every slot holds exactly its amount.
    { to: plan.next_address, zatoshis: total - plan.slots.reduce((n, s) => n + s.zatoshis, 0), pays_fee: true },
  ]);
  adopt(purse, plan, now);
}

/**
 * A refill was asked for and never confirmed. If the treasury did pay out,
 * take it as done. If it didn't, ask again with the same vaults, or give the
 * plan up when the treasury can no longer pay for it.
 */
async function resumeRefill(purse: Purse, now: number): Promise<void> {
  const plan = purse.refill!;
  const info = await signer().vaultInfo(plan.source, true);
  if (paidOut(info, plan.settled_before)) return adopt(purse, plan, now);
  const total = info.balance_total_zatoshis;
  const needed = plan.slots.reduce((n, s) => n + s.zatoshis, 0) + 80_000;
  if (total >= needed && info.balance_spendable_zatoshis === total && info.settlement?.status !== "pending") return payRefill(purse, plan, total, now);
  // Not enough any more, or it has waited too long: forget the plan. Its vaults were never paid, so nothing is lost.
  if (total < needed || now - plan.made_at > 30 * 60_000) delete purse.refill;
}

/**
 * Makes new slots out of the treasury when there are too few and the treasury
 * can pay for them. Everything in the treasury moves: the slots, and the rest
 * to a new treasury vault.
 */
async function refill(purse: Purse, now: number): Promise<void> {
  if (purse.refill) return resumeRefill(purse, now);
  const missing = target() - purse.slots.length;
  if (missing <= 0 || !purse.treasury) return;
  const info = await signer().vaultInfo(purse.treasury.vault_id, true);
  const total = info.balance_total_zatoshis;
  purse.treasury_seen = { total, spendable: info.balance_spendable_zatoshis, at: now };
  if (total === 0 || info.balance_spendable_zatoshis !== total || info.settlement?.status === "pending") return;
  // Leave enough for the network fee of this payout and the next few.
  const n = Math.min(missing, Math.floor((total - 80_000) / slotAmount()));
  if (n <= 0) return;

  const next = (await signer().createVault()).vault_id;
  const slots: Slot[] = [];
  for (let i = 0; i < n; i++) {
    const vault_id = (await signer().createVault()).vault_id;
    slots.push({ vault_id, address: await signer().newDepositAddress(vault_id), zatoshis: slotAmount(), made_at: now, ready: false });
  }
  const plan: RefillPlan = { source: purse.treasury.vault_id, settled_before: info.settlements.length, next, next_address: await signer().newDepositAddress(next), slots, made_at: now };
  purse.refill = plan;
  await savePurse(purse); // on disk before the payout is asked for
  await payRefill(purse, plan, total, now);
}

/**
 * One pass over the purse. `quiet` is false while a practice auction's refunds
 * are still on their way to the current treasury: it is left alone until they
 * have arrived.
 */
export async function purseTick(purse: Purse, quiet: boolean): Promise<void> {
  const now = Date.now();
  const problems: string[] = [];
  const attempt = async (what: string, f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      problems.push(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  delete purse.last_error;
  await attempt("opening the treasury", async () => void (await treasuryOf(purse)));
  if (!purse.treasury) {
    purse.last_error = problems[0];
    return;
  }
  await attempt("looking at the treasury", async () => {
    const info = await signer().vaultInfo(purse.treasury!.vault_id, false, 8000);
    purse.treasury_seen = { total: info.balance_total_zatoshis, spendable: info.balance_spendable_zatoshis, at: now };
  });
  await attempt("checking slots", () => checkSlots(purse, now));
  // A refill already asked for is followed up whatever else is going on.
  if (quiet || purse.refill) await attempt("refilling", () => refill(purse, now));
  await attempt("sweeping", () => sweep(purse, now));
  if (problems.length) purse.last_error = problems.join("; ");
}

/** For whoever runs the site: what the purse holds. */
export async function purseStatus() {
  const purse = await load();
  let treasury: { total: number; spendable: number } | null = null;
  let online = false;
  try {
    await signer().chainStatus();
    online = true;
    if (purse.treasury) {
      const info = await signer().vaultInfo(purse.treasury.vault_id, true);
      treasury = { total: info.balance_total_zatoshis, spendable: info.balance_spendable_zatoshis };
    }
  } catch {
    /* reported as offline */
  }
  return {
    house_signer_online: online,
    treasury,
    slots: { ready: readySlots(purse).length, waiting: purse.slots.length - readySlots(purse).length, target: target(), each: slotAmount() },
    practice_auctions: purse.counter,
    current: purse.current,
    last_error: purse.last_error ?? null,
    /** Enough to run one practice auction with every visitor slot in use, and pay its fees. */
    suggested_funding: target() * slotAmount() + 300_000,
  };
}
