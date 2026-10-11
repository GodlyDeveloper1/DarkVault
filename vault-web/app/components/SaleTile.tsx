import Link from "next/link";
import { formatCoins } from "vault-core";
import type { PublicAuction } from "@/lib/views";
import { SeatsTag, TileCover } from "./AuctionTile";

export const unitsWord = (n: number) => `${n} ${n === 1 ? "Unit" : "Units"}`;

/** Where a batch sale (Order Flow) stands, in a few words. Used by the market page, the sale's own page and the dashboard. */
export function saleLabel(a: PublicAuction): { text: string; cls: string } {
  const sold = a.batch?.sold ?? 0;
  if (a.state === "funding") return { text: "Not Open Yet", cls: "" };
  if (a.outcome?.cancelled) return { text: "Never Opened", cls: "" };
  if (a.state === "open") return { text: "Open", cls: "open" };
  if (a.state === "revealing") return { text: "Opening Orders", cls: "revealing" };
  if (!a.outcome?.sold) return a.state === "settled" ? { text: "Nothing Sold", cls: "" } : { text: "Settling", cls: "settling" };
  if (a.state === "settling") return { text: `${unitsWord(sold)} Sold · Settling`, cls: "settling" };
  if (a.state === "delivering") return { text: `${unitsWord(sold)} Sold · Handing Over`, cls: "settling" };
  return { text: `${unitsWord(sold)} Sold`, cls: "sold" };
}

/** One batch sale, as a tile on the Order Flow page. */
export default function SaleTile({ a }: { a: PublicAuction }) {
  const s = saleLabel(a);
  const sold = !!a.outcome?.sold;
  return (
    <Link href={`/orders/${a.id}`} className="tile sale-tile" data-sale={a.id}>
      <TileCover a={a} />
      <span className={`badge ${s.cls}`}>
        {a.state === "open" && <i className="dot live" />}
        {s.text}
      </span>
      <span className="badge units-tag">{unitsWord(a.batch?.units ?? 0)}</span>
      <SeatsTag a={a} />
      <h3>{a.title}</h3>
      <p className="muted small" style={{ margin: 0 }}>
        {a.description.length > 110 ? `${a.description.slice(0, 110)}…` : a.description || "No description."}
      </p>
      <div className="meta">
        <div>
          <span>{sold ? "lowest winning order" : "lowest price"}</span>
          <b>{formatCoins(sold ? a.outcome!.price! : a.reserve)} TAZ</b>
        </div>
        <div style={{ textAlign: "right" }}>
          <span>sealed orders</span>
          <b>{a.bids}</b>
        </div>
      </div>
    </Link>
  );
}
