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

export default function AuctionTile({ a }: { a: PublicAuction }) {
  const s = stateLabel(a);
  return (
    <Link href={`/auction/${a.id}`} className="tile">
      <span className={`badge ${s.cls}`}>
        {a.state === "open" && <i className="dot live" />}
        {s.text}
      </span>
      {a.practice && <span className="badge practice-tag">Practice</span>}
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
