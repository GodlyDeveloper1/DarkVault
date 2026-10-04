// The house: practice auctions and practice wallets.
//
// A visitor who has no testnet coins, or who arrives when nothing is on sale,
// should still be able to see a whole auction. So the site can run practice
// auctions itself: it lists a small digital lot, two automated bidders bid on
// it, and a visitor can bid against them with a practice wallet the site
// funds. Everything on chain is real: the deposits are shielded payments from
// a second wallet (the "house purse", its own signer with its own seed), the
// bids are sealed and time-locked like any other, and the result is proven.
//
// What is different, and said on the page: the seller and those bidders are
// the site, and a practice wallet is custodial (the site holds its coins).
//
// All of it is off unless HOUSE_SIGNER_URL points at that second signer.
import "server-only";
import { MIN_BID } from "vault-core";
import { houseSigner } from "../signer";

const num = (name: string, fallback: number, min = 1) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? Math.floor(v) : fallback;
};

const reserve = Math.max(MIN_BID, num("VAULT_PRACTICE_RESERVE", MIN_BID));
const ceiling = Math.max(reserve, Math.min(reserve * 100, num("VAULT_PRACTICE_CEILING", reserve * 2)));

export const HOUSE = {
  enabled: houseSigner !== null,
  reserve,
  /** The highest bid allowed, which is also what every practice bid deposits (practice auctions carry no bonds). */
  ceiling,
  /** How long a practice auction takes bids. Long enough for a deposit to reach a block (about 75 seconds on testnet). */
  durationSec: num("VAULT_PRACTICE_DURATION_SEC", 8 * 60, 5),
  /** Automated bidders in each practice auction. */
  bots: 2,
  /** They bid at random between the reserve and this share of the way to the ceiling, so a visitor who bids higher wins. */
  botShare: 0.6,
  /** Ready-made deposits kept for visitors, on top of the two the house bidders use. */
  visitorSlots: num("VAULT_PRACTICE_SLOTS", 4),
  /**
   * A slot holds one deposit plus this much, which pays the network fee of
   * sending it (10,000 to 15,000 zatoshis). What is left over arrives with
   * the deposit and comes back in the refund.
   */
  slotMargin: 25_000,
  /**
   * After the last practice auction has finished, wait this long before
   * making new slots, so its last payout has reached the treasury first.
   */
  settleWaitSec: num("VAULT_PRACTICE_SETTLE_WAIT_SEC", 5 * 60, 0),
  /** A new practice wallet can fund this many bids at once. */
  walletBids: 3,
  /** A practice wallet stops working after this many funded bids: each costs the purse network fees. */
  walletLifetimeBids: 20,
  /**
   * A practice wallet pays a deposit only while at least this long is left:
   * a deposit has to be in a block before the close (a block takes about 75
   * seconds on testnet), or the bid doesn't count.
   */
  payCutoffSec: num("VAULT_PRACTICE_PAY_CUTOFF_SEC", 100, 0),
  /** At most this many practice auctions a day: each costs the purse network fees. */
  auctionsPerDay: num("VAULT_PRACTICE_AUCTIONS_PER_DAY", 30),
  /** At most this many practice wallets a day, across all visitors. */
  walletsPerDay: num("VAULT_PRACTICE_WALLETS_PER_DAY", 200),
};

/** What one slot holds. */
export const slotAmount = () => HOUSE.ceiling + HOUSE.slotMargin;
/** The most a house bidder bids: never below the reserve, never above the ceiling. */
export const botMax = () => Math.min(HOUSE.ceiling, Math.max(HOUSE.reserve, Math.floor((HOUSE.reserve + (HOUSE.ceiling - HOUSE.reserve) * HOUSE.botShare) / 1000) * 1000));
/** What a new practice wallet holds: enough to fund `walletBids` deposits at once. */
export const walletStart = () => HOUSE.walletBids * slotAmount();
