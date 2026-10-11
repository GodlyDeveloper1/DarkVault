import Link from "next/link";
import { formatCoins } from "vault-core";
import type { PublicAuction } from "@/lib/views";

export function stateLabel(a: PublicAuction): { text: string; cls: string } {
  if (a.state === "funding") return { text: "Not open yet", cls: "" };
  if (a.outcome?.cancelled) return { text: "Never opened", cls: "" };
  if (a.state === "open") return { text: "Open", cls: "open" };
  if (a.state === "revealing") return { text: a.scheme === 2 ? "Opening bids" : "Revealing", cls: "revealing" };
  if (a.state === "settling") return { text: a.outcome?.sold ? "Sold · settling" : "Settling", cls: "settling" };
  if (a.state === "delivering") return { text: a.delivery?.stage === "disputed" ? "Sold · in dispute" : "Sold · delivering", cls: "settling" };
  if (a.delivery?.stage === "refunded") return { text: "Sale undone", cls: "" };
  return a.outcome?.sold ? { text: "Sold", cls: "sold" } : { text: "Not sold", cls: "" };
}

/**
 * Seats left while bids (or orders) are taken. A new bid takes a seat and
 * keeps it once funded; one not funded in time gives it back. Null once it
 * has closed, and for a deal.
 */
export function seatsLeft(a: PublicAuction): { left: number; total: number; text: string; few: boolean } | null {
  if (a.seats == null || a.state !== "open") return null;
  const { left, total } = a.seats;
  return { left, total, text: left > 0 ? `${left} Of ${total} Seats Left` : "Full", few: left <= 5 };
}

export function SeatsTag({ a }: { a: PublicAuction }) {
  const seats = seatsLeft(a);
  if (!seats) return null;
  return <span className={seats.few ? "badge seats-tag few" : "badge seats-tag"}>{seats.text}</span>;
}

/** A public listing's first photo, at the top of its tile. (A private one's photos are encrypted, and private listings have no tiles.) */
export function TileCover({ a }: { a: PublicAuction }) {
  if (!a.photos || a.private) return null;
  return (
    <span className="tile-cover">
      {/* eslint-disable-next-line @next/next/no-img-element -- served by this site's photo route */}
      <img src={`/api/auctions/${a.id}/photos/0`} alt="" loading="lazy" />
    </span>
  );
}

export default function AuctionTile({ a }: { a: PublicAuction }) {
  const s = stateLabel(a);
  return (
    <Link href={`/auction/${a.id}`} className="tile">
      <TileCover a={a} />
      <span className={`badge ${s.cls}`}>
        {a.state === "open" && <i className="dot live" />}
        {s.text}
      </span>
      {a.practice && <span className="badge practice-tag">Practice</span>}
      <SeatsTag a={a} />
      <h3>{a.title}</h3>
      <p className="muted small" style={{ margin: 0 }}>
        {a.description.length > 110 ? `${a.description.slice(0, 110)}…` : a.description || "No description."}
      </p>
      <div className="meta">
        <div>
          <span>{a.outcome?.sold ? "sold for" : "reserve"}</span>
          <b>{formatCoins(a.outcome?.sold ? a.outcome.price! : a.reserve)} TAZ</b>
        </div>
        <div style={{ textAlign: "right" }}>
          <span>sealed bids</span>
          <b>{a.bids}</b>
        </div>
      </div>
    </Link>
  );
}

/** How many seats are left while bids are taken. Five or fewer stand out. */
export function SeatsStat({ auction }: { auction: PublicAuction }) {
  const seats = seatsLeft(auction);
  if (!seats) return null;
  return (
    <div className={seats.few ? "seats few" : "seats"}>
      <b id="stat-seats">{seats.left > 0 ? seats.left : "Full"}</b>
      <span>{seats.left > 0 ? `of ${seats.total} seats left` : `all ${seats.total} seats taken`}</span>
    </div>
  );
}

/** In place of the bid form when every seat is taken. */
export function SeatsFull({ auction, what }: { auction: PublicAuction; what: "bids" | "orders" }) {
  const s = auction.seats;
  if (!s) return null;
  const one = what === "bids" ? "bid" : "order";
  return (
    <div className="card seats-full" id="seats-full">
      <h3>{s.closed ? `This ${what === "bids" ? "Auction" : "Sale"} Takes No More ${what === "bids" ? "Bids" : "Orders"}.` : `All ${s.total} Seats Are Taken.`}</h3>
      <p className="muted small" style={{ margin: 0 }}>
        {s.closed
          ? `It has taken as many ${what} as it can in all.`
          : s.may_free
            ? `A seat comes free when a new ${one} isn't funded within ${s.hold_minutes} minutes. Look again shortly.`
            : `Every seat is held by a funded ${one}.`}
      </p>
    </div>
  );
}
