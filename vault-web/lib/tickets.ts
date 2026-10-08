// A bidder's own record of their sealed bids, kept in this browser only.
//
// The amount and the nonce never leave the browser in a form anyone can read
// until bidding has closed. On auctions with time-locked bids they are sent
// locked, and open by themselves at the close; the ticket is then the bidder's
// own record, the backup if the lock can't be opened, and what unlocks a lot
// they win. On older auctions the ticket is the only way to reveal the bid.

import { bidToken, QUICKNET, roundTimeMs, sealedFor, type BeaconChain, type Receipt } from "vault-core";
import { holdsInvite, rememberInvite } from "./invites";

export interface Ticket {
  auction_id: string;
  bid_id: string;
  /** Zatoshis. */
  amount: number;
  /** 64 hex characters. With the amount, it opens the commitment. */
  nonce: string;
  deposit_address: string;
  placed_at: number;
  /**
   * 64 hex characters. The private half of this bid's delivery key: if the bid
   * wins, the lot (or the seller's note) is sealed to it. Never sent anywhere,
   * unless the bidder chooses to hand it over to dispute a digital lot.
   */
  delivery_key?: string;
  /**
   * Auctions with time-locked bids: the site's signed receipt for this bid.
   * It is the bidder's proof that the site accepted the bid and where it sits
   * on the board.
   */
  receipt?: Receipt;
  /**
   * The time-locked bid exactly as it was sent. The receipt signs its hash, so
   * together they show anyone what the site was given: once the lock's round
   * is signed, this opens to the amount and nonce above.
   */
  sealed?: string;
  /**
   * 64 hex characters. What this bid's access token is made from. It is its
   * own secret because, on auctions with a published proof, the winner's nonce
   * is published: a token made from the nonce would let anyone who also knew
   * the bid's id act as the winner. Older tickets have none and use the nonce.
   */
  token_secret?: string;
  /** The site's receipt-signing key as it was when the bid was placed. */
  site_key?: string;
  /** When bidding was due to close, as shown when the bid was placed (milliseconds). */
  closes_at?: number;
  /** Placed with a practice wallet: the site's house purse funds the deposit and receives the refund. */
  practice?: boolean;
  /**
   * Zatoshis the bidder chose to deposit, when that is more than the bid and
   * the bond: a round amount, so the site can't work the bid out from it.
   */
  send?: number;
  /**
   * 64 hex characters. A bid in a private auction: the invite key that opens
   * the auction, so a ticket restored in another browser can find its way
   * back in. Never sent anywhere.
   */
  invite?: string;
}

/** The token that shows the site this browser placed a bid. */
export function tokenOf(ticket: Ticket): Promise<string> {
  return bidToken(ticket.token_secret ?? ticket.nonce);
}

/**
 * May this browser open the bid by hand yet? Decided here, by this browser's
 * own clock and by what the ticket itself says, never by what the site says:
 * a site that announced "bidding is closed" early must not be handed a bid.
 *
 * A time-locked bid may be opened once the round it was locked to has been
 * signed (for the public network that time comes from constants in this
 * code). Any other bid, once the closing time noted in the ticket has passed.
 */
export function mayOpenByHand(ticket: Ticket, testChain?: BeaconChain | null): boolean {
  const now = Date.now();
  const lock = ticket.sealed ? sealedFor(ticket.sealed) : null;
  if (lock) {
    const chain = lock.chain_hash === QUICKNET.hash ? QUICKNET : testChain && testChain.hash === lock.chain_hash ? testChain : null;
    return !!chain && now >= roundTimeMs(chain, lock.round);
  }
  // Tickets from before closing times were noted have nothing to check against.
  return ticket.closes_at === undefined || now >= ticket.closes_at;
}

const PREFIX = "dv-tickets-";
const key = (auctionId: string) => `${PREFIX}${auctionId}`;

/** Fired on this window whenever the tickets or the connected wallet change. */
export const WALLET_EVENT = "dv-wallet";
export function announce() {
  try {
    window.dispatchEvent(new Event(WALLET_EVENT));
  } catch {
    /* not in a browser */
  }
}

/** A string of exactly this many hex characters. (A bare regex test would also pass an array holding one.) */
const hex = (v: unknown, chars: number): v is string => typeof v === "string" && v.length === chars && /^[0-9a-f]+$/.test(v);
const optional = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);

/** Is this a well-formed ticket for this auction? A ticket can come from a file, so nothing about it is taken on trust. */
function valid(t: unknown, auctionId: string): t is Ticket {
  const x = t as Ticket;
  return (
    !!x &&
    typeof x === "object" &&
    typeof auctionId === "string" &&
    x.auction_id === auctionId &&
    hex(x.bid_id, 32) &&
    Number.isSafeInteger(x.amount) &&
    x.amount >= 0 &&
    hex(x.nonce, 64) &&
    typeof x.deposit_address === "string" &&
    x.deposit_address.length <= 600 &&
    Number.isSafeInteger(x.placed_at) &&
    optional(x.delivery_key, (v) => hex(v, 64)) &&
    optional(x.token_secret, (v) => hex(v, 64)) &&
    optional(x.site_key, (v) => hex(v, 64)) &&
    optional(x.closes_at, (v) => Number.isSafeInteger(v)) &&
    optional(x.practice, (v) => typeof v === "boolean") &&
    optional(x.send, (v) => Number.isSafeInteger(v) && (v as number) > 0) &&
    optional(x.invite, (v) => hex(v, 64)) &&
    optional(x.sealed, (v) => typeof v === "string" && v.length <= 2000) &&
    optional(x.receipt, (v) => typeof v === "object" && v !== null && typeof (v as { signature?: unknown }).signature === "string")
  );
}

export function loadTickets(auctionId: string): Ticket[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(auctionId)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((t) => valid(t, auctionId)) : [];
  } catch {
    return [];
  }
}

export function saveTicket(ticket: Ticket): Ticket[] {
  const all = loadTickets(ticket.auction_id).filter((t) => t.bid_id !== ticket.bid_id);
  all.push(ticket);
  // A ticket for a private auction brings its invite along (it matters when the ticket is restored
  // from a file). It never replaces an invite this browser already holds: a ticket can come from anyone.
  if (ticket.invite && !holdsInvite(ticket.auction_id)) rememberInvite(ticket.auction_id, ticket.invite);
  try {
    localStorage.setItem(key(ticket.auction_id), JSON.stringify(all));
  } catch {
    /* private mode: the ticket file is the only copy */
  }
  announce();
  return all;
}

/** Every ticket this browser holds, across all auctions, newest first. */
export function allTickets(): Ticket[] {
  const out: Ticket[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) out.push(...loadTickets(k.slice(PREFIX.length)));
    }
  } catch {
    /* no storage */
  }
  return out.sort((a, b) => b.placed_at - a.placed_at);
}

export const TICKET_HEADER = "DARK VAULT BID TICKET (Zcash testnet). Keep this private until bidding closes.";

export const DEAL_TICKET_HEADER = "DARK VAULT PAYMENT TICKET (Zcash testnet). Keep this private: it is the key to one payment in a private deal.";

/** A ticket as a file. `deal`: the ticket is for a payment in a private deal, not a bid. */
export function ticketFile(ticket: Ticket, title: string, deal = false): string {
  return [deal ? DEAL_TICKET_HEADER : TICKET_HEADER, `${deal ? "Deal" : "Auction"}: ${title}`, "", JSON.stringify(ticket, null, 1), ""].join("\n");
}

export const BACKUP_HEADER = "DARK VAULT TICKET BACKUP (Zcash testnet). Keep this private: it holds every bid this browser has sealed.";

export function backupFile(tickets: Ticket[]): string {
  return [BACKUP_HEADER, "", JSON.stringify(tickets, null, 1), ""].join("\n");
}

/** Reads tickets back from a backup file or a single ticket file. Read in the browser; nothing is uploaded. */
export function parseBackup(text: string): Ticket[] {
  // The JSON starts on a line of its own. (A header line may hold a title with a bracket in it.)
  const start = text.search(/^[[{]/m);
  if (start < 0) return [];
  try {
    const raw: unknown = JSON.parse(text.slice(start));
    const list = Array.isArray(raw) ? raw : [raw];
    return list.filter((t): t is Ticket => valid(t, (t as Ticket)?.auction_id) && /^[0-9a-f]{32}$/.test((t as Ticket).auction_id));
  } catch {
    return [];
  }
}

/** Reads a ticket back from a saved file. Returns null if it isn't one for this auction. */
export function parseTicketFile(text: string, auctionId: string): Ticket | null {
  const start = text.search(/^\{/m);
  if (start < 0) return null;
  try {
    const t: unknown = JSON.parse(text.slice(start));
    return valid(t, auctionId) ? t : null;
  } catch {
    return null;
  }
}
