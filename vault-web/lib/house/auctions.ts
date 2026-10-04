// Practice auctions: the site as seller, and its automated bidders.
//
// A practice auction is an ordinary auction record run by the ordinary engine.
// What this file adds is the parts a person would otherwise do:
//
//   - listing a small digital lot (the site makes the seller's key and keeps it);
//   - two house bidders, which seal, time-lock and fund a bid each the moment
//     the auction opens, the same way a browser does (their commitments are on
//     the board before any visitor bids, and they bid without seeing anyone);
//   - handing the lot key to the winner once the lot has sold;
//   - when a house bidder wins, confirming the lot so the sale completes.
//
// The house bidders' amounts are the only bids this server knows before a
// close. They are kept out of the auction record, in <data>/house/auctions/.
import "server-only";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  bidToken,
  deliveryContext,
  deliveryPublic,
  encryptLot,
  formatCoins,
  lotKeyHash,
  manageToken,
  newBlinding,
  newDeliveryKey,
  pedersenCommit,
  seal,
  sealBid,
  sellerKeys,
} from "vault-core";
import { placeBid } from "../bids";
import { DATA_DIR } from "../datadir";
import { deliveryStage, operatorResolve, sellerHandover, winnerConfirm } from "../delivery";
import { advance, moneyByBid, requiredDeposit } from "../engine";
import { sha256Hex } from "../http";
import { LIMITS } from "../limits";
import { createListing } from "../listing";
import { chainStatus, houseSigner, vaultInfo } from "../signer";
import { loadAuction, withAuction } from "../store";
import type { Auction } from "../types";
import { botMax, HOUSE, slotAmount, walletStart } from "./config";
import { payFromSlot, purseTick, readPurse, readySlots, savePurse, today, treasuryAddress, withPurse, type Purse } from "./purse";

const DIR = path.join(DATA_DIR, "house", "auctions");

/** What the house keeps to itself about one practice auction. */
interface HouseFile {
  n: number;
  /** The seller's manage key. In a real auction this never leaves the seller's browser. */
  manage_key: string;
  bots: { bid_id: string; amount: number; blinding: string; token_secret: string; delivery_key: string; funded?: boolean }[];
}

async function readHouse(id: string): Promise<HouseFile | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(DIR, `${id}.json`), "utf8")) as HouseFile;
  } catch {
    return null;
  }
}

async function writeHouse(id: string, file: HouseFile): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, `${id}.json`), JSON.stringify(file, null, 1), { mode: 0o600 });
}

const hex32 = () => randomBytes(32).toString("hex");

/** A practice auction still taking bids or being settled: its refunds have not come back to the purse yet. */
const busy = (a: Auction | null) => !!a && (a.state === "open" || a.state === "revealing" || a.state === "settling");

function lotText(n: number): string {
  return [
    `You won Dark Vault practice auction no. ${n}.`,
    "",
    "This note was encrypted before bidding opened, and its key was sealed so that only the winning bid's browser could open it.",
    "In a real auction the seller's browser does the encrypting, so the site stores the lot without being able to read it. Here the site is the seller, so it wrote this note itself.",
    "",
    "Press \"It is what was described\" to release the price to the seller and finish the sale.",
  ].join("\n");
}

/** Whether a visitor could start a practice auction now, and if not, why. */
export async function practiceStatus() {
  if (!HOUSE.enabled) return { enabled: false as const };
  const purse = await readPurse();
  const current = purse.current ? await loadAuction(purse.current) : null;
  const open = current && current.state === "open" ? { id: current.id, ends_at: current.ends_at, title: current.title } : null;
  const ready = readySlots(purse).length;
  const capped = purse.started.day === today() && purse.started.n >= HOUSE.auctionsPerDay;
  let wait: string | null = null;
  if (busy(current)) wait = open ? null : "The last practice auction is being settled. The next one can start in a minute or two.";
  else if (capped) wait = "Today's practice auctions have all been run. Come back tomorrow, or bid in a real auction with your own wallet.";
  else if (ready < HOUSE.bots + 1) {
    // Coins on their way count: slots waiting for confirmations, or a treasury that can make new ones.
    const coming = purse.slots.length >= HOUSE.bots + 1 || !!purse.refill || (purse.treasury_seen?.total ?? 0) >= (HOUSE.bots + 1 - ready) * slotAmount();
    wait = coming ? "The practice purse is getting coins ready. Try again in a few minutes." : "The practice purse is empty. Whoever runs this site needs to top it up.";
  }
  return {
    enabled: true as const,
    open,
    can_start: !busy(current) && !capped && ready >= HOUSE.bots + 1,
    wait,
    /** Deposits ready for visitors in the open practice auction. */
    slots_ready: ready,
    reserve: HOUSE.reserve,
    ceiling: HOUSE.ceiling,
    duration_seconds: HOUSE.durationSec,
    bots: HOUSE.bots,
    bot_max: botMax(),
    wallet_start: walletStart(),
    /** A practice wallet pays a deposit only while this many seconds of bidding are left. */
    pay_cutoff_seconds: HOUSE.payCutoffSec,
  };
}

/**
 * Lists a practice auction and sends in the house bidders. Returns the
 * auction's id, the id of the one already open, or a sentence saying why not.
 */
export async function startPracticeAuction(): Promise<{ id: string } | { error: string }> {
  if (!HOUSE.enabled || !houseSigner) return { error: "this site has no practice auctions" };
  return withPurse(async (purse): Promise<{ id: string } | { error: string }> => {
    const current = purse.current ? await loadAuction(purse.current) : null;
    if (current?.state === "open" && Date.now() < current.ends_at) return { id: current.id };
    if (busy(current)) return { error: "The last practice auction is being settled. Try again in a minute or two." };
    if (purse.started.day !== today()) purse.started = { day: today(), n: 0 };
    if (purse.started.n >= HOUSE.auctionsPerDay) return { error: "Today's practice auctions have all been run. Come back tomorrow." };
    // Each house bidder needs a deposit, and a visitor should be able to bid too.
    if (readySlots(purse).length < HOUSE.bots + 1) return { error: "The practice purse has no coins ready right now. Try again in a few minutes." };
    try {
      await Promise.all([chainStatus(), houseSigner!.chainStatus()]);
    } catch {
      return { error: "A signer is offline, so a practice auction can't start right now." };
    }

    const n = purse.counter + 1;
    const manage_key = hex32();
    const keys = await sellerKeys(manage_key);
    const lot = await encryptLot(keys.lotKey, { kind: "text" }, new TextEncoder().encode(lotText(n)));
    // Shorter than a seller could choose: if a winner never confirms, the price comes back to the purse sooner.
    const window = Math.min(LIMITS.minDeliverySec, 15 * 60);
    const auction = await createListing({
      title: `Practice lot no. ${n}: a sealed note`,
      description:
        `A practice auction run by this site, so you can try a whole auction in a few minutes. ` +
        `The lot is a short encrypted note that only the winner can read. ${HOUSE.bots} house bidders (automated) bid against you; ` +
        `they never bid above ${formatCoins(botMax())} TAZ. The coins are real testnet coins and have no value.`,
      reserve: HOUSE.reserve,
      ceiling: HOUSE.ceiling,
      durationSec: HOUSE.durationSec,
      revealSec: LIMITS.minRevealSec,
      payout: await treasuryAddress(purse),
      keyHash: sha256Hex(await manageToken(manage_key)),
      // Practice auctions carry no bonds: the seller is the site, and a practice wallet has nothing of its own to stake.
      delivery: {
        kind: "digital",
        seller_pub: keys.publicKey,
        lot: { key_hash: await lotKeyHash(keys.lotKey), bytes: lot.length },
        deliver_seconds: window,
        dispute_seconds: window,
        seller_bond: 0,
        buyer_bond: 0,
      },
      lot,
      house: { n, bot_bids: [], bot_max: botMax() },
    });
    // From here on the auction exists. What the house needs to play its part
    // goes to disk at once, before anything else can fail: the seller's key,
    // and the purse's note that this auction is its own.
    const file: HouseFile = { n, manage_key, bots: [] };
    await writeHouse(auction.id, file);
    purse.counter = n;
    purse.started.n += 1;
    purse.current = auction.id;
    purse.active.push(auction.id);
    await savePurse(purse);

    // The house bidders: sealed, locked in time and funded like anyone's bid.
    const lock = auction.timelock!;
    const steps = Math.max(0, Math.floor((botMax() - HOUSE.reserve) / 1000));
    for (let i = 0; i < HOUSE.bots; i++) {
      try {
        const amount = Math.min(botMax(), HOUSE.reserve + 1000 * Math.floor((randomBytes(4).readUInt32BE(0) / 2 ** 32) * (steps + 1)));
        const blinding = newBlinding();
        const token_secret = hex32();
        const delivery_key = newDeliveryKey();
        const placed = await placeBid(auction.id, {
          commitment: pedersenCommit(auction.id, amount, blinding),
          tokenHash: sha256Hex(await bidToken(token_secret)),
          refund: await treasuryAddress(purse),
          deliveryPub: deliveryPublic(delivery_key),
          sealed: await sealBid(lock.chain, lock.round, amount, blinding),
        });
        if ("error" in placed) throw new Error(placed.error);
        // Written down, and marked as a house bid on the board, before any money moves.
        file.bots.push({ bid_id: placed.bid_id, amount, blinding, token_secret, delivery_key });
        await writeHouse(auction.id, file);
        await withAuction(auction.id, (a) => {
          if (a.house) a.house.bot_bids = file.bots.map((b) => b.bid_id);
        });
        await payFromSlot(purse, placed.deposit_address);
        file.bots[file.bots.length - 1]!.funded = true;
        await writeHouse(auction.id, file);
      } catch (e) {
        // The auction goes ahead with fewer house bidders, or with one whose bid won't count.
        purse.last_error = `house bidder ${i + 1}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return { id: auction.id };
  });
}

/** The house's part in one practice auction, as far as it can go right now. Returns true when there is nothing left to do. */
async function attend(id: string, now: number): Promise<boolean> {
  const auction = await advance(id);
  const file = await readHouse(id);
  if (!auction || !file) return true;
  const bots = new Map(file.bots.map((b) => [b.bid_id, b]));

  // The time lock could not be opened: the house bidders open their own bids, as a browser would.
  if (auction.state === "revealing" && now > (auction.closed?.at ?? now) + 20_000) {
    const info = await vaultInfo(auction.vault_id);
    const money = moneyByBid(auction, info);
    const due = auction.bids.filter((b) => bots.has(b.id) && !b.reveal && (money.get(b.id)?.counted ?? 0) >= (requiredDeposit(auction) ?? 0));
    if (due.length && now < (auction.reveal_ends_at ?? 0)) {
      await withAuction(id, (a) => {
        if (a.state !== "revealing") return;
        for (const b of a.bids) {
          const bot = bots.get(b.id);
          if (bot && !b.reveal && due.some((d) => d.id === b.id)) b.reveal = { amount: bot.amount, nonce: bot.blinding, at: now, by: "bidder" };
        }
      });
      await advance(id, true);
    }
    return false;
  }

  if (auction.state === "delivering" && auction.outcome?.sold && auction.delivery && !auction.delivery.resolution) {
    const stage = deliveryStage(auction);
    const winner = auction.bids.find((b) => b.id === auction.outcome!.winner_bid_id);
    // A complaint about a practice lot is not argued: the sale is undone and the price goes back to
    // the winner, with nobody at fault. Otherwise a dispute would hold the purse's coins for nothing.
    if (stage === "disputed") {
      await withAuction(id, (a) => void operatorResolve(a, now, "refund", true));
      await advance(id, true);
      return false;
    }
    // The seller's part: the lot key, sealed so only the winning bid's browser can open it.
    if (stage === "awaiting-handover" && winner?.delivery_pub) {
      const keys = await sellerKeys(file.manage_key);
      const envelope = await seal(winner.delivery_pub, keys.lotKey, deliveryContext(id, "lot-key"));
      await withAuction(id, (a) => void sellerHandover(a, now, envelope));
      await advance(id, true);
      return false;
    }
    // A house bidder won: it confirms, so the price is released and the auction finishes.
    else if (stage === "awaiting-confirmation" && winner && bots.has(winner.id)) {
      await withAuction(id, (a) => void winnerConfirm(a, now));
      await advance(id, true);
    }
    return false;
  }
  // Done when the auction is settled and its last payout has left (or there was none to make).
  return auction.state === "settled";
}

let running = false;

/** One pass: the practice auctions the house has a part in, then the purse. Called on the server's timer. */
export async function houseTick(): Promise<void> {
  if (!HOUSE.enabled || running) return;
  running = true;
  try {
    const now = Date.now();
    const purse = await readPurse();
    const done: string[] = [];
    for (const id of purse.active) {
      try {
        if (await attend(id, now)) done.push(id);
      } catch {
        /* the next pass tries again */
      }
    }
    await withPurse(async (p: Purse) => {
      // Read here, inside the purse's lock: an auction started a moment ago must be seen.
      const now = Date.now();
      const current = p.current ? await loadAuction(p.current) : null;
      if (done.length) p.active = p.active.filter((id) => !done.includes(id));
      // New slots are made when every practice auction has paid everything back
      // to the purse (and those payments have had time to arrive), so that one
      // payout of the treasury does it. If a winner is taking their time to
      // confirm and there are too few slots left to start the next auction,
      // they are made without waiting for that last payment.
      if (p.active.length > 0) delete p.idle_since;
      else p.idle_since ??= now;
      const wait = HOUSE.settleWaitSec * 1000;
      const settled = p.idle_since !== undefined && now - p.idle_since >= wait;
      // Too few slots to start another, and the last auction was decided long enough ago for its payouts to be in.
      const needed = !busy(current) && readySlots(p).length < HOUSE.bots + 1 && now - (current?.outcome?.decided_at ?? 0) >= wait;
      const quiet = settled || needed;
      await purseTick(p, quiet);
    });
  } finally {
    running = false;
  }
}
