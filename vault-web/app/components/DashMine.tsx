"use client";

// The part of the dashboard that belongs to this browser: its bids, its
// listings and the first steps. All of it comes from local storage and from
// the same requests the auction pages and the wallet panel already make.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatCoins } from "vault-core";
import { fetchAuction, isDecided, isFunded, loadRows, roomPath, statusOf, type Row } from "@/lib/bidStatus";
import { practiceToken } from "@/lib/practiceClient";
import { allTickets, WALLET_EVENT, type Ticket } from "@/lib/tickets";
import type { PublicAuction } from "@/lib/views";
import { loadWallet, OPEN_EVENT } from "@/lib/wallet";
import { stateLabel } from "./AuctionTile";
import MyDeals from "./MyDeals";
import { saleLabel } from "./SaleTile";

/** The auctions this browser holds a seller's key for. */
function listingIds(): string[] {
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

function Art({ name }: { name: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`/art/s/${name}.webp`} alt="" width={192} height={192} draggable={false} />;
}

export default function DashMine({ open, total }: { open: number; total: number }) {
  const [ready, setReady] = useState(false);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [listings, setListings] = useState<{ id: string; auction: PublicAuction | null }[]>([]);
  const [hasWallet, setHasWallet] = useState(false);
  const [chain, setChain] = useState<{ online: boolean; scanned_height?: number } | null>(null);
  // Until each ticket's record has been fetched, a bid can't be told from a payment in a private deal.
  const [loaded, setLoaded] = useState(false);

  const sync = useCallback(() => {
    setTickets(allTickets());
    setHasWallet(!!loadWallet() || !!practiceToken());
    setReady(true);
  }, []);

  useEffect(() => {
    sync();
    window.addEventListener(WALLET_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(WALLET_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [sync]);

  // Keep each bid's status, each listing and the chain line fresh while the page is open.
  useEffect(() => {
    if (!ready) return;
    let stop = false;
    async function load() {
      const [nextRows, nextListings, status] = await Promise.all([
        tickets.length ? loadRows(tickets) : Promise.resolve({}),
        Promise.all(listingIds().map(async (id) => ({ id, auction: await fetchAuction(id) }))),
        fetch("/api/status")
          .then((r) => r.json())
          .catch(() => ({ online: false })),
      ]);
      if (stop) return;
      setRows(nextRows);
      setListings(nextListings.sort((a, b) => (b.auction?.created_at ?? 0) - (a.auction?.created_at ?? 0)));
      setChain(status);
      setLoaded(true);
    }
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [ready, tickets]);

  const all = Object.values(rows);
  // Private deals (the Settlement market) have a list of their own below.
  const bidTickets = loaded ? tickets.filter((t) => !rows[t.bid_id]?.auction?.deal) : [];
  const lots = listings.filter((l) => !l.auction?.deal);
  const steps = [
    {
      done: hasWallet,
      title: "Get A Wallet.",
      text: "Connect your own, or take a practice wallet with testnet coins in it.",
      act: (
        <button type="button" className="link" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}>
          Open The Wallet
        </button>
      ),
    },
    {
      done: bidTickets.length > 0,
      title: "Seal A Bid.",
      text: "Open an auction and type one number. Your browser seals it and locks it in time.",
      act: (
        <Link href="/auctions" className="link">
          See The Auctions
        </Link>
      ),
    },
    {
      done: all.some(isFunded),
      title: "Send The Deposit.",
      text: "Your bid plus the bond, in one shielded payment to an address made for that bid alone.",
      act: null,
    },
    {
      done: all.some(isDecided),
      title: "See The Result.",
      text: "The bids open by themselves at the close. Your browser checks the proof that the highest bid won.",
      act: null,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <>
      <section className="dash-stats" aria-label="At a glance">
        <div className="stat-slab">
          <Art name="trophy" />
          <b>{open}</b>
          <span>
            Open {open === 1 ? "Auction" : "Auctions"}
            <i>{total} in all</i>
          </span>
        </div>
        <div className="stat-slab">
          <Art name="envelope" />
          <b>{loaded ? bidTickets.length : "…"}</b>
          <span>
            Your Sealed {bidTickets.length === 1 ? "Bid" : "Bids"}
            <i>held in this browser</i>
          </span>
        </div>
        <div className="stat-slab">
          <Art name="key" />
          <b>{loaded ? lots.length : "…"}</b>
          <span>
            Your {lots.length === 1 ? "Listing" : "Listings"}
            <i>with a seller key here</i>
          </span>
        </div>
        <div className="stat-slab">
          <Art name="shield" />
          <b className="mono">{chain ? (chain.online ? chain.scanned_height?.toLocaleString("en-US") : "Offline") : "…"}</b>
          <span>
            Zcash Testnet Block
            <i>{chain && !chain.online ? "the signer is not answering" : "every payment is shielded"}</i>
          </span>
        </div>
      </section>

      <div className="dash-cols">
        <section className="card" id="first-steps">
          <div className="row spread">
            <h2 style={{ margin: 0 }}>First Steps</h2>
            <span className="badge">
              {doneCount} Of {steps.length} Done
            </span>
          </div>
          <ol className="todo">
            {steps.map((s) => (
              <li key={s.title} className={s.done ? "done" : ""}>
                <i aria-hidden="true">{s.done && <Art name="tick" />}</i>
                <div>
                  <b>{s.title}</b>
                  <span>{s.text}</span>
                  {!s.done && s.act}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <div>
          <section className="card" id="my-bids">
            <h2>Your Bids And Orders</h2>
            {!loaded ? (
              <p className="muted small">Looking in this browser…</p>
            ) : bidTickets.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                No bids or orders from this browser yet. <Link href="/auctions">Find an auction</Link> or <Link href="/orders">a sale</Link>.
              </p>
            ) : (
              <ul className="wallet-bids">
                {bidTickets.map((t) => {
                  const row = rows[t.bid_id] ?? { ticket: t };
                  const s = statusOf(row);
                  return (
                    <li key={t.bid_id}>
                      <Link href={roomPath(row.auction, t.auction_id)}>
                        <span className="wb-title">
                          {row.auction?.title ?? "Auction"}
                          {row.auction?.batch && <i className="badge units-tag">Order</i>}
                        </span>
                        <span className="mono wb-amount">{formatCoins(t.amount)} TAZ</span>
                        <span className={`wb-status ${s.cls}`}>{s.text}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card" id="my-listings">
            <h2>Your Listings</h2>
            {!loaded ? (
              <p className="muted small">Looking in this browser…</p>
            ) : lots.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                Nothing listed from this browser yet. <Link href="/sell">List a lot</Link> or <Link href="/orders/new">start a sale</Link>.
              </p>
            ) : (
              <ul className="wallet-bids">
                {lots.map(({ id, auction }) => (
                  <li key={id}>
                    <Link href={roomPath(auction, id)}>
                      <span className="wb-title">
                        {auction?.title ?? "An auction this site no longer has"}
                        {auction?.batch && <i className="badge units-tag">{auction.batch.units} Units</i>}
                      </span>
                      {auction && <span className="mono wb-amount">{auction.batch ? "From" : "Reserve"} {formatCoins(auction.reserve)} TAZ</span>}
                      {auction && <span className="wb-status">{(auction.batch ? saleLabel(auction) : stateLabel(auction)).text}.</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <MyDeals />
        </div>
      </div>
    </>
  );
}
