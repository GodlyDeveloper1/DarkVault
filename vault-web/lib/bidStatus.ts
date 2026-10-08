// What has become of each bid this browser holds: used by the wallet panel and the dashboard.
//
// The browser asks the site about each bid with that bid's own token, the same
// request the auction page makes. Nothing here tells the site that two bids
// belong to one person beyond what those requests already do.
import { decryptListing, formatCoins } from "vault-core";
import { inviteFor, inviteHeaders } from "./invites";
import { tokenOf, type Ticket } from "./tickets";
import type { BidView, PublicAuction } from "./views";

export interface Row {
  ticket: Ticket;
  auction?: PublicAuction;
  view?: BidView;
}

/** One auction as the public sees it, with a private auction's title opened by this browser's invite. */
export async function fetchAuction(id: string): Promise<PublicAuction | null> {
  try {
    const res = await fetch(`/api/auctions/${id}`, { headers: await inviteHeaders(id) });
    if (!res.ok) {
      void res.body?.cancel(); // an answer nobody reads would otherwise stay open
      return null;
    }
    const auction = (await res.json()).auction as PublicAuction;
    const invite = auction.private ? await inviteFor(id) : null;
    if (auction.private && invite) {
      try {
        auction.title = (await decryptListing(invite, auction.private.listing)).title;
      } catch {
        /* it keeps the name "Private auction" */
      }
    }
    return auction;
  } catch {
    return null;
  }
}

/** Asks the site about every ticket's auction and bid. Keyed by bid id. */
export async function loadRows(tickets: Ticket[]): Promise<Record<string, Row>> {
  const auctions = new Map<string, PublicAuction>();
  await Promise.all(
    [...new Set(tickets.map((t) => t.auction_id))].map(async (id) => {
      const a = await fetchAuction(id);
      if (a) auctions.set(id, a);
    }),
  );
  const next: Record<string, Row> = {};
  await Promise.all(
    tickets.map(async (ticket) => {
      const row: Row = { ticket, auction: auctions.get(ticket.auction_id) };
      try {
        const res = await fetch(`/api/auctions/${ticket.auction_id}/bids/${ticket.bid_id}`, { headers: { "x-bid-token": await tokenOf(ticket) } });
        if (res.ok) row.view = (await res.json()).bid;
        else void res.body?.cancel();
      } catch {
        /* next round */
      }
      next[ticket.bid_id] = row;
    }),
  );
  return next;
}

/** Where a record's own page is: a batch sale's room, a private deal's, or an auction's. */
export const roomPath = (auction: PublicAuction | null | undefined, id: string) => `/${auction?.batch ? "orders" : auction?.deal ? "deal" : "auction"}/${id}`;

export const isFunded = (row: Row) => (row.view?.deposit?.total ?? 0) > 0;
export const isDecided = (row: Row) => !!row.auction && row.auction.state !== "open" && row.auction.state !== "revealing" && row.auction.state !== "funding";

/** The same, for a payment in a private deal (the Settlement market): there was no bid. */
function dealStatusOf(row: Row): { text: string; cls: string } {
  const { auction, view } = row;
  const a = auction!;
  const stage = view?.delivery?.stage;
  if (a.state === "open") return isFunded(row) ? { text: "Payment seen. Waiting for confirmations.", cls: "amber" } : { text: "Waiting for your payment.", cls: "amber" };
  if (view?.standing === "won") {
    if (stage === "refunded") return { text: "Not handed over. Payment returned.", cls: "" };
    if (stage === "released") return { text: "Deal settled.", cls: "lime" };
    if (stage === "disputed") return { text: "In escrow. Dispute open.", cls: "amber" };
    if (stage === "awaiting-address") return { text: view.delivery?.kind === "promise" ? "In escrow. Tell the seller what you want." : "In escrow. Send your shipping details.", cls: "amber" };
    if (stage === "awaiting-confirmation") return { text: "In escrow. Confirm the handover.", cls: "amber" };
    return { text: "In escrow. Waiting for the seller.", cls: "amber" };
  }
  if (isFunded(row)) return { text: "This payment did not take the deal. It comes back.", cls: "" };
  return { text: a.outcome?.sold ? "The deal was taken." : "The offer ran out.", cls: "" };
}

export function statusOf(row: Row): { text: string; cls: string } {
  const { auction, view, ticket } = row;
  if (!auction) return { text: "Checking…", cls: "" };
  if (auction.deal) return dealStatusOf(row);
  const funded = isFunded(row);
  if (auction.state === "open") {
    if (!funded) return { text: "Waiting for your deposit.", cls: "amber" };
    const d = view!.deposit!;
    // A deposit covers the bid plus the bond. Older auctions with a cap ask every bidder for the same amount.
    const need = auction.deposit_required ?? ticket.amount + (auction.delivery?.buyer_bond ?? 0);
    return d.total >= need
      ? { text: `Funded and sealed. ${Math.min(d.confirmations, d.needed)} of ${d.needed} confirmations.`, cls: "lime" }
      : { text: auction.deposit_required ? "Deposit is smaller than this auction asks for." : (auction.delivery?.buyer_bond ? "Deposit is smaller than the bid plus the bond." : "Deposit is smaller than the bid."), cls: "red" };
  }
  if (auction.state === "revealing") {
    if (view?.revealed) return { text: auction.scheme === 2 ? "Opened, waiting for the result." : "Revealed, waiting for the result.", cls: "amber" };
    return { text: auction.scheme === 2 ? "Bidding closed. The time lock is opening the bids." : "Open the auction to reveal this bid.", cls: "amber" };
  }
  const refund = view?.payments.find((p) => p.kind !== "seller");
  if (view?.standing === "won") {
    const stage = view.delivery?.stage;
    if (stage === "refunded") return { text: "Won, but not delivered. Payment returned.", cls: "" };
    if (stage === "awaiting-address") return { text: view.delivery?.kind === "promise" ? "Won. Tell the seller what you want." : "Won. Send your shipping details.", cls: "amber" };
    if (stage === "awaiting-handover") return { text: "Won. Waiting for the seller to hand over.", cls: "amber" };
    if (stage === "awaiting-confirmation") return { text: auction.batch ? "Won. Check your unit and confirm." : "Won. Confirm you have the lot.", cls: "amber" };
    if (stage === "disputed") return { text: "Won. Dispute open.", cls: "amber" };
    // In a batch sale each winner pays their own order; the public price there is the lowest winner's.
    return { text: `Won. You pay ${formatCoins(auction.batch ? (view.unit?.price ?? ticket.amount) : (auction.outcome?.price ?? ticket.amount))} TAZ.`, cls: "lime" };
  }
  if (view?.standing === "no-deposit") return { text: "Did not count: no deposit.", cls: "" };
  if (refund) return { text: refund.status === "mined" ? `Refunded ${formatCoins(refund.paid)} TAZ.` : "Refund on its way.", cls: refund.status === "mined" ? "" : "amber" };
  return { text: funded ? "Refund is being prepared." : "Closed.", cls: funded ? "amber" : "" };
}
