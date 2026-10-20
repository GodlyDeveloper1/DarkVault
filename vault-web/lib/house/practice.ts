// Practice wallets.
//
// A practice wallet lets a visitor with no testnet coins bid in a practice
// auction. It is a balance the site keeps, backed by real coins in the house
// purse: when the visitor funds a bid, the purse makes a real shielded
// deposit to that bid's address, and the bid's refund goes back to the purse.
//
// It is custodial, and the page says so: the site holds the coins, the wallet
// only works in practice auctions, and nothing can be withdrawn. It also lets
// the site tell which practice bids belong to one visitor. A real auction is
// bid on with the visitor's own wallet, where none of that is true.
//
// The balance is not stored. It is worked out from what the chain did: what
// the purse sent to the wallet's bids, and what the settlements paid back.
import "server-only";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../datadir";
import { matches, sha256Hex } from "../http";
import { loadAuction, replaceFile } from "../store";
import { HOUSE, walletStart } from "./config";
import { today, withPurse } from "./purse";

const DIR = path.join(DATA_DIR, "house", "wallets");
const ID = /^[0-9a-f]{24}$/;

export interface PracticeWallet {
  id: string;
  /** Hash of the wallet's secret. The secret stays in the visitor's browser. */
  token_hash: string;
  created_at: number;
  /** The bids this wallet has been attached to, and whether the purse has funded them. */
  bids: { auction_id: string; bid_id: string; at: number }[];
}

const fileFor = (id: string) => path.join(DIR, `${id}.json`);

async function read(id: string): Promise<PracticeWallet | null> {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf8")) as PracticeWallet;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function write(wallet: PracticeWallet): Promise<void> {
  await fs.mkdir(DIR, { recursive: true });
  await replaceFile(fileFor(wallet.id), JSON.stringify(wallet, null, 1));
}

/**
 * Makes a wallet. Returns the token the browser keeps ("id.secret"), or null
 * when today's allowance of new wallets is used up.
 */
export async function createWallet(): Promise<{ token: string } | null> {
  const allowed = await withPurse((purse) => {
    const day = today();
    if (purse.wallets.day !== day) purse.wallets = { day, made: 0 };
    if (purse.wallets.made >= HOUSE.walletsPerDay) return false;
    purse.wallets.made += 1;
    return true;
  });
  if (!allowed) return null;
  const id = randomBytes(12).toString("hex");
  const secret = randomBytes(24).toString("hex");
  await write({ id, token_hash: sha256Hex(secret), created_at: Date.now(), bids: [] });
  return { token: `${id}.${secret}` };
}

/** The wallet a token opens, or null. The same answer whether the wallet or the secret is wrong. */
export async function walletFor(token: string | null): Promise<PracticeWallet | null> {
  const m = /^([0-9a-f]{24})\.([0-9a-f]{48})$/.exec(token ?? "");
  if (!m) return null;
  const wallet = await read(m[1]!);
  return wallet && matches(m[2]!, wallet.token_hash) ? wallet : null;
}

/** Notes that a bid belongs to a wallet (when the bid is placed). Call inside `withPurse`, so two bids can't be noted at once. */
export async function attachBid(walletId: string, auction_id: string, bid_id: string): Promise<void> {
  const wallet = await read(walletId);
  if (!wallet) return;
  wallet.bids.push({ auction_id, bid_id, at: Date.now() });
  await write(wallet);
}

export interface WalletBid {
  auction_id: string;
  bid_id: string;
  title: string;
  /** What the purse sent to this bid's deposit address. 0 if it was never funded. */
  sent: number;
  /** What has come back: refunds, change, a returned payment. */
  returned: number;
  /** Still out: the deposit is in an auction that has not paid it back yet. */
  locked: boolean;
}

/** A wallet as its holder sees it: the balance, and where the rest of it is. */
export async function walletView(wallet: PracticeWallet) {
  const bids: WalletBid[] = [];
  for (const b of wallet.bids.slice(-60)) {
    const auction = await loadAuction(b.auction_id);
    const bid = auction?.bids.find((x) => x.id === b.bid_id);
    if (!auction || !bid || bid.practice !== wallet.id) continue;
    const sent = bid.practice_paid?.sent ?? 0;
    let returned = 0;
    for (const s of auction.settlements) for (const p of s.payments) if (p.bid_id === bid.id) returned += p.paid;
    // A sale undone, or a bond returned: the second payout's share for the winner.
    if (auction.outcome?.winner_bid_id === bid.id) returned += auction.delivery?.payout?.to_winner?.paid ?? 0;
    // The first payout returns everything a bid is owed except a winner's price; until then the deposit is out.
    const locked = sent > 0 && !(auction.deposits_settled && bid.id in auction.deposits_settled);
    bids.push({ auction_id: auction.id, bid_id: bid.id, title: auction.title, sent, returned, locked });
  }
  const start = walletStart();
  const funded = bids.filter((b) => b.sent > 0).length;
  return {
    id: wallet.id,
    start,
    /** What can be spent now. Never below zero: the purse covers the network fee of a deposit. */
    balance: Math.max(0, start - bids.reduce((s, b) => s + b.sent, 0) + bids.reduce((s, b) => s + b.returned, 0)),
    locked: bids.filter((b) => b.locked).reduce((s, b) => s + b.sent, 0),
    funded_bids: funded,
    bids_left: Math.max(0, HOUSE.walletLifetimeBids - funded),
    bids,
  };
}

export type WalletView = Awaited<ReturnType<typeof walletView>>;
