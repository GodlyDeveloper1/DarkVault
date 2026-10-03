// A bidder's own record of their sealed bids, kept in this browser only.
//
// The amount and the nonce never leave the browser until bidding has closed.
// Lose them and the bid can't be opened: it won't count, though the deposit is
// still returned. That is why the page offers a ticket file to save.

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

function valid(t: unknown, auctionId: string): t is Ticket {
  const x = t as Ticket;
  return (
    !!x &&
    x.auction_id === auctionId &&
    /^[0-9a-f]{32}$/.test(x.bid_id) &&
    Number.isSafeInteger(x.amount) &&
    x.amount >= 0 &&
    /^[0-9a-f]{64}$/.test(x.nonce) &&
    typeof x.deposit_address === "string" &&
    (x.delivery_key === undefined || /^[0-9a-f]{64}$/.test(x.delivery_key))
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

export function ticketFile(ticket: Ticket, title: string): string {
  return [TICKET_HEADER, `Auction: ${title}`, "", JSON.stringify(ticket, null, 1), ""].join("\n");
}

export const BACKUP_HEADER = "DARK VAULT TICKET BACKUP (Zcash testnet). Keep this private: it holds every bid this browser has sealed.";

export function backupFile(tickets: Ticket[]): string {
  return [BACKUP_HEADER, "", JSON.stringify(tickets, null, 1), ""].join("\n");
}

/** Reads tickets back from a backup file or a single ticket file. Read in the browser; nothing is uploaded. */
export function parseBackup(text: string): Ticket[] {
  const start = text.search(/[[{]/);
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
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const t: unknown = JSON.parse(text.slice(start));
    return valid(t, auctionId) ? t : null;
  } catch {
    return null;
  }
}
