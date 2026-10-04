// The invites to private auctions that this browser holds.
//
// An invite key arrives in a link's #fragment, which browsers never send to a
// server, and is kept here in local storage so the auction opens again later.
// The site is only ever shown the access token derived from it.
import { inviteAccess, inviteFromManage, isInviteKey } from "vault-core";

const key = (auctionId: string) => `dv-invite-${auctionId}`;
// For a browser with no storage (private mode): this page's invites, for this visit.
const held = new Map<string, string>();
const tokens = new Map<string, string>();

export function rememberInvite(auctionId: string, invite: string): void {
  if (!isInviteKey(invite)) return;
  held.set(auctionId, invite);
  try {
    localStorage.setItem(key(auctionId), invite);
  } catch {
    /* no storage: it lasts for this visit */
  }
}

/**
 * This browser's invite to an auction, or null. It may be the one it was
 * given, the one a seller's manage key gives (a seller has no invite link of
 * their own), or the one a ticket for a bid in that auction carries.
 */
export async function inviteFor(auctionId: string): Promise<string | null> {
  const had = held.get(auctionId);
  if (had) return had;
  try {
    const stored = localStorage.getItem(key(auctionId));
    if (isInviteKey(stored)) {
      held.set(auctionId, stored);
      return stored;
    }
    const manage = localStorage.getItem(`dv-manage-${auctionId}`);
    if (isInviteKey(manage)) {
      const invite = await inviteFromManage(manage);
      held.set(auctionId, invite);
      return invite;
    }
    const tickets: unknown = JSON.parse(localStorage.getItem(`dv-tickets-${auctionId}`) ?? "[]");
    const carried = Array.isArray(tickets) ? tickets.map((t) => (t as { invite?: unknown } | null)?.invite).find(isInviteKey) : undefined;
    if (carried) {
      held.set(auctionId, carried);
      return carried;
    }
  } catch {
    /* no storage */
  }
  return null;
}

/** The header an invite gives: the access token made from it. The invite itself is never sent. */
export async function headersOf(invite: string): Promise<Record<string, string>> {
  let token = tokens.get(invite);
  if (!token) {
    token = await inviteAccess(invite);
    tokens.set(invite, token);
  }
  return { "x-invite": token };
}

/** The header that lets this browser into a private auction. Empty when it holds no invite (a public auction needs none). */
export async function inviteHeaders(auctionId: string): Promise<Record<string, string>> {
  const invite = await inviteFor(auctionId);
  return invite ? headersOf(invite) : {};
}

/** The link to hand to bidders. For a private auction it carries the invite key after the #. */
export function shareLink(origin: string, auctionId: string, invite: string | null): string {
  return `${origin}/auction/${auctionId}${invite ? `#invite=${invite}` : ""}`;
}
