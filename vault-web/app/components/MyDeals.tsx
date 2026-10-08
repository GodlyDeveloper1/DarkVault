"use client";

// The deals this browser is part of, as seller (it holds the seller key) or as
// buyer (it holds a payment ticket). Read from local storage; each deal is
// then fetched with its own link's token, exactly as its page does.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatCoins } from "vault-core";
import { dealLabel } from "@/app/deal/[id]/DealRoom";
import { fetchAuction } from "@/lib/bidStatus";
import { allTickets, WALLET_EVENT } from "@/lib/tickets";
import type { PublicAuction } from "@/lib/views";

interface Mine {
  id: string;
  role: "Seller" | "Buyer";
  deal: PublicAuction;
}

function sellerIds(): string[] {
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("dv-manage-") && /^[0-9a-f]{32}$/.test(k.slice(10))) ids.push(k.slice(10));
    }
  } catch {
    /* no storage */
  }
  return ids;
}

/** Every deal this browser holds a key or a ticket for. */
export async function loadMyDeals(): Promise<Mine[]> {
  const selling = new Set(sellerIds());
  const buying = new Set(allTickets().map((t) => t.auction_id));
  const ids = [...new Set([...selling, ...buying])];
  const found = await Promise.all(ids.map(async (id) => ({ id, a: await fetchAuction(id) })));
  return found
    .filter((x): x is { id: string; a: PublicAuction } => !!x.a?.deal)
    .map(({ id, a }) => ({ id, role: selling.has(id) ? ("Seller" as const) : ("Buyer" as const), deal: a }))
    .sort((x, y) => y.deal.created_at - x.deal.created_at);
}

export default function MyDeals({ empty = true }: { empty?: boolean }) {
  const [deals, setDeals] = useState<Mine[] | null>(null);
  const load = useCallback(() => void loadMyDeals().then(setDeals), []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    window.addEventListener(WALLET_EVENT, load);
    return () => {
      clearInterval(t);
      window.removeEventListener(WALLET_EVENT, load);
    };
  }, [load]);

  if (deals !== null && deals.length === 0 && !empty) return null;

  return (
    <section className="card" id="my-deals">
      <h2>Your Deals</h2>
      {deals === null ? (
        <p className="muted small" style={{ margin: 0 }}>
          Looking in this browser…
        </p>
      ) : deals.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>
          No deals in this browser yet. <Link href="/settlement/new">Create one</Link>, or open the link a seller sent you.
        </p>
      ) : (
        <ul className="wallet-bids">
          {deals.map(({ id, role, deal }) => {
            const s = dealLabel(deal);
            return (
              <li key={id}>
                <Link href={`/deal/${id}`}>
                  <span className="wb-title">
                    {deal.title} <i className="deal-role">{role}</i>
                  </span>
                  <span className="mono wb-amount">{formatCoins(deal.deal!.price)} TAZ</span>
                  <span className={`wb-status ${s.cls === "open" || s.cls === "sold" ? "lime" : s.cls === "settling" ? "amber" : ""}`}>{s.text}.</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
