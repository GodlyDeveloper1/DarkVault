"use client";

// The auction room. Everything a bidder does happens here:
//
//   1. Seal a bid: the amount is hashed into a commitment in this browser. The
//      server is sent the commitment and a refund address, never the amount.
//   2. Deposit: the server answers with an address made for this one bid.
//   3. Reveal: once bidding has closed, this browser opens the commitment.
//   4. Result: who won is decided by the revealed amounts; one transaction pays
//      the seller and returns every other deposit.
//   5. Delivery (see Delivery.tsx): when the lot has a delivery, the price is
//      held until the lot has been handed over.
//
// The amount and its nonce are kept in this browser (and in the ticket file the
// bidder can save). They are what "sealed" means, so they are not sent anywhere
// until the auction says it is time to reveal.
import { useCallback, useEffect, useRef, useState } from "react";
import { bidToken, commit, deliveryPublic, formatCoins, manageToken, MIN_BID, newDeliveryKey, newNonce, parseCoins, sha256Hex } from "vault-core";
import Countdown from "@/app/components/Countdown";
import Qr from "@/app/components/Qr";
import { stateLabel } from "@/app/components/AuctionTile";
import { loadTickets, parseTicketFile, saveTicket, ticketFile, WALLET_EVENT, type Ticket } from "@/lib/tickets";
import { loadWallet, OPEN_EVENT, paymentRequest } from "@/lib/wallet";
import type { BidView, PublicAuction, SellerView } from "@/lib/views";
import { SellerDelivery, WinnerDelivery } from "./Delivery";

const STANDING: Record<string, string> = {
  won: "You won.",
  outbid: "Another bid was higher. Your deposit comes back to you.",
  "below-reserve": "Your bid was below the reserve. Your deposit comes back to you.",
  "not-revealed": "Your bid was not revealed in time, so it did not count. Your deposit comes back to you.",
  underfunded: "Your deposit did not cover your bid (and the bond, if this auction has one), so the bid did not count. Your deposit comes back to you.",
  "no-deposit": "No deposit arrived before bidding closed, so this bid did not count.",
};

/** A rounder amount above the bid, so the deposit doesn't give the bid away. */
function roomyDeposit(amount: number): number {
  const step = 10 ** Math.floor(Math.log10(Math.max(amount, 1)));
  return (Math.floor(amount / step) + 1) * step;
}

/** 3600 → "1 hour", 259200 → "3 days". */
function span(seconds: number): string {
  const [n, unit] = seconds >= 86400 ? [seconds / 86400, "day"] : seconds >= 3600 ? [seconds / 3600, "hour"] : seconds >= 60 ? [seconds / 60, "minute"] : [seconds, "second"];
  const r = Math.round(n * 10) / 10;
  return `${r} ${unit}${r === 1 ? "" : "s"}`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="link small"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export default function AuctionRoom({ initial, serverNow }: { initial: PublicAuction; serverNow: number }) {
  const [auction, setAuction] = useState(initial);
  const [offset, setOffset] = useState(0); // server clock minus this browser's clock
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [views, setViews] = useState<Record<string, BidView>>({});
  const [seller, setSeller] = useState<SellerView | null>(null);
  const [revealNote, setRevealNote] = useState<Record<string, string>>({});
  const revealing = useRef(new Set<string>());
  // The manage key stays in this browser. The site is shown a token derived from it.
  const manageKey = useRef<string | null>(null);
  const manageTok = useRef<string | null>(null);
  // True as soon as this browser is known to hold a seller key, before the seller view has loaded.
  const [hasKey, setHasKey] = useState(false);
  // The bid form waits for this: the server can't know whether this browser is the seller's.
  const [mounted, setMounted] = useState(false);
  const id = auction.id;

  useEffect(() => {
    setOffset(serverNow - Date.now());
    setTickets(loadTickets(id));
    // The seller's key arrives in the link's #fragment, which browsers never send to a server.
    const hash = window.location.hash.replace(/^#/, "");
    let key = hash.startsWith("manage=") ? hash.slice(7) : null;
    try {
      if (key) {
        localStorage.setItem(`dv-manage-${id}`, key);
        // Now that this browser remembers the key, take it out of the address
        // bar: a seller who copies the page address to share it must not hand
        // out their seller key with it.
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } else key = localStorage.getItem(`dv-manage-${id}`);
    } catch {
      /* no storage: the key stays in the address bar and works for this visit */
    }
    manageKey.current = key && /^[0-9a-f]{64}$/.test(key) ? key : null;
    setHasKey(manageKey.current !== null);
    setMounted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/auctions/${id}`);
      if (res.ok) {
        const body = await res.json();
        setAuction(body.auction);
        setOffset(body.now - Date.now());
      }
    } catch {
      /* keep what we have; the next poll tries again */
    }
    const mine = loadTickets(id);
    const next: Record<string, BidView> = {};
    await Promise.all(
      mine.map(async (t) => {
        try {
          const res = await fetch(`/api/auctions/${id}/bids/${t.bid_id}`, { headers: { "x-bid-token": await bidToken(t.nonce) } });
          if (res.ok) next[t.bid_id] = (await res.json()).bid;
        } catch {
          /* next poll */
        }
      }),
    );
    setViews((old) => ({ ...old, ...next }));
    if (manageKey.current) {
      try {
        manageTok.current ??= await manageToken(manageKey.current);
        const res = await fetch(`/api/auctions/${id}/seller`, { headers: { "x-manage-key": manageTok.current } });
        if (res.ok) setSeller((await res.json()).seller);
        else if (res.status === 404) setHasKey(false); // not this auction's key
      } catch {
        /* next poll */
      }
    }
  }, [id]);

  // Poll: quickly while something is about to change, slowly once it is over.
  useEffect(() => {
    void refresh();
    const paid = auction.paid === "mined" || auction.paid === "nothing-to-pay";
    const every = auction.state === "settled" && paid ? 30_000 : auction.state === "open" ? 5000 : 3000;
    const t = setInterval(() => void refresh(), every);
    return () => clearInterval(t);
  }, [refresh, auction.state, auction.paid]);

  // Reveal: once bidding has closed, open each of this browser's bids.
  useEffect(() => {
    if (auction.state !== "revealing") return;
    for (const t of tickets) {
      if (views[t.bid_id]?.revealed || revealing.current.has(t.bid_id)) continue;
      revealing.current.add(t.bid_id);
      void (async () => {
        try {
          const res = await fetch(`/api/auctions/${id}/bids/${t.bid_id}/reveal`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount: t.amount, nonce: t.nonce }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error ?? "the reveal was refused");
          setRevealNote((n) => ({ ...n, [t.bid_id]: "" }));
          void refresh();
        } catch (e) {
          setRevealNote((n) => ({ ...n, [t.bid_id]: e instanceof Error ? e.message : String(e) }));
          revealing.current.delete(t.bid_id); // try again on the next poll
        }
      })();
    }
  }, [auction.state, tickets, views, id, refresh]);

  const label = stateLabel(auction);
  const hasDelivery = !!auction.delivery;
  const steps = hasDelivery ? ["Sealed bids", "Reveal", "Settle", "Deliver", "Paid"] : ["Sealed bids", "Reveal", "Settle", "Paid"];
  const stepIndex = { funding: -1, open: 0, revealing: 1, settling: 2, delivering: 3, settled: steps.length - 1 }[auction.state];
  const sellerBond = auction.delivery?.seller_bond ?? 0;
  const buyerBond = auction.delivery?.buyer_bond ?? 0;
  const cancelled = !!auction.outcome?.cancelled;
  const paid = auction.paid === "mined" || auction.paid === "nothing-to-pay";
  const stage = auction.delivery?.stage;

  return (
    <>
      <div className="room-head">
        <div>
          <span className={`badge ${label.cls}`}>
            {auction.state === "open" && <i className="dot live" />}
            {(auction.state === "revealing" || auction.state === "settling" || auction.state === "delivering") && <i className="dot amber" />}
            {label.text}
          </span>
          <h1 style={{ marginTop: 14 }}>{auction.title}</h1>
          {auction.description && (
            <p className="muted" style={{ whiteSpace: "pre-wrap", maxWidth: 640 }}>
              {auction.description}
            </p>
          )}
        </div>

        <div className="clock" id="clock">
          {auction.state === "funding" && (
            <>
              <span className="muted small">Status</span>
              <div className="big">Not open yet</div>
              <span className="muted small">
                Bidding opens when the seller&apos;s bond of {formatCoins(sellerBond)} TAZ has arrived. Check back in a few minutes.
              </span>
            </>
          )}
          {auction.state === "open" && (
            <>
              <span className="muted small">Bidding closes in</span>
              <div className="big">
                <Countdown to={auction.ends_at} offset={offset} onDone={() => void refresh()} />
              </div>
              <span className="muted small">Bids stay sealed until then.</span>
            </>
          )}
          {auction.state === "revealing" && (
            <>
              <span className="muted small">Bidding is closed. Bidders reveal within</span>
              <div className="big">
                <Countdown to={auction.reveal_ends_at ?? 0} offset={offset} onDone={() => void refresh()} />
              </div>
              <span className="muted small">
                {auction.revealed} of {auction.funded ?? auction.bids} funded bids revealed.
              </span>
            </>
          )}
          {(auction.state === "settling" || auction.state === "delivering" || auction.state === "settled") && (
            <>
              <span className="muted small">{auction.outcome?.sold ? (stage === "refunded" ? "Result" : "Sold for") : "Result"}</span>
              <div className="big">
                {cancelled ? (
                  "Never opened"
                ) : auction.outcome?.sold ? (
                  stage === "refunded" ? (
                    "Sale undone"
                  ) : (
                    <span className="price">{formatCoins(auction.outcome.price!)} TAZ</span>
                  )
                ) : (
                  "Not sold"
                )}
              </div>
              <span className="muted small">
                {auction.outcome?.sold
                  ? stage === "refunded"
                    ? `The highest bid was ${formatCoins(auction.outcome.price!)} TAZ.`
                    : "The highest bid won and pays what it bid."
                  : cancelled
                    ? "The seller's bond did not arrive, so bidding never opened."
                    : auction.outcome?.counted === 0
                      ? "No bid met the reserve."
                      : ""}{" "}
                {auction.state === "settling"
                  ? "Waiting for deposits to confirm, then one transaction pays everyone."
                  : auction.state === "delivering"
                    ? stage === "disputed"
                      ? "Every other deposit has been returned. The price is held while a dispute is decided."
                      : stage === "released"
                        ? "Every other deposit has been returned and the lot has been handed over. The seller's payment is being sent."
                        : stage === "refunded"
                          ? "Every other deposit has been returned. The lot was not delivered, so the price is going back to the winner."
                          : auction.delivery?.kind === "promise"
                              ? "Every other deposit has been returned. The price is held until the promise is kept."
                              : "Every other deposit has been returned. The price is held until the lot is handed over."
                    : stage === "refunded"
                      ? "The lot was not delivered, so the price went back to the winner."
                      : paid
                    ? auction.paid === "mined"
                      ? stage === "released"
                        ? "The lot was handed over and the seller has been paid."
                        : "Paid out in one shielded transaction."
                      : "No deposits were made, so there was nothing to pay."
                      : "The payout is on its way to a block."}
              </span>
            </>
          )}
          <div className="stats">
            <div>
              <b id="stat-bids">{auction.bids}</b>
              <span>sealed bids</span>
            </div>
            <div>
              <b id="stat-funded">{auction.funded ?? "–"}</b>
              <span>funded</span>
            </div>
            <div>
              <b>{formatCoins(auction.reserve)}</b>
              <span>reserve (TAZ)</span>
            </div>
          </div>
        </div>
      </div>

      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s} className={i < stepIndex || (i === steps.length - 1 && paid) ? "done" : i === stepIndex ? "on" : undefined}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {!auction.signer_online && (
        <div className="card bad">
          <strong>The signer is offline.</strong> Deposits can&apos;t be seen and nothing can be paid until it is back. Nothing is lost.
        </div>
      )}

      <div className="cols">
        <div>
          {seller && (
            <div className="card accent" id="seller-card">
              <h3>You are the seller</h3>
              <p className="small muted" id="seller-private">
                <strong style={{ color: "var(--amber)" }}>Private view.</strong> This browser holds your seller key. Never share your seller link:
                anyone who has it can act as the seller. Give bidders the public link instead.{" "}
                <Copy text={typeof window === "undefined" ? "" : `${window.location.origin}/auction/${id}`} label="Copy the public link" />
              </p>
              {auction.state === "funding" && seller.bond && <BondFunding bond={seller.bond} />}
              {seller.bond && auction.state !== "funding" && !seller.proceeds && (
                <p className="small muted" id="bond-status" style={{ marginBottom: 8 }}>
                  Your bond of {formatCoins(seller.bond.required)} TAZ is held. It comes back with your payment, or when the lot doesn&apos;t sell.
                  You lose it to the winner if you don&apos;t deliver or lose a dispute.
                </p>
              )}
              {seller.proceeds ? (
                <dl className="kv">
                  {auction.outcome?.price != null && (
                    <>
                      <dt>Sale price</dt>
                      <dd>{formatCoins(auction.outcome.price)} TAZ</dd>
                    </>
                  )}
                  <dt>{auction.outcome?.sold ? "Sent to you, after network fees" : "Your bond, returned after the network fee"}</dt>
                  <dd>{formatCoins(seller.proceeds.paid)} TAZ</dd>
                  <dt>To</dt>
                  <dd>{seller.payout_address}</dd>
                  <dt>Transaction ({seller.proceeds.status})</dt>
                  <dd>
                    {seller.proceeds.txid.slice(0, 16)}… <Copy text={seller.proceeds.txid} />
                  </dd>
                </dl>
              ) : (
                <p className="small" style={{ margin: 0 }}>
                  {auction.state === "funding"
                    ? ""
                    : auction.state === "settled"
                    ? cancelled
                      ? "Your bond did not arrive in time, so this listing never opened. If it arrives late, it is sent back to your payout address."
                      : auction.outcome?.sold
                        ? "Nothing was paid to you."
                        : "The lot did not sell, so nothing was paid to you."
                    : hasDelivery
                      ? stage === "released"
                        ? `The lot is handed over. Your payment is being sent to ${seller.payout_address}; it shows here once it is on its way.`
                        : `After the sale and the handover, the price is sent to ${seller.payout_address}.`
                      : `When the auction settles, the price is sent to ${seller.payout_address}.`}
                </p>
              )}
              {manageKey.current && manageTok.current && (
                <SellerDelivery auction={auction} seller={seller} manageKey={manageKey.current} token={manageTok.current} refresh={() => void refresh()} />
              )}
            </div>
          )}

          {tickets.map((t) => (
            <MyBid key={t.bid_id} ticket={t} view={views[t.bid_id]} auction={auction} note={revealNote[t.bid_id]} refresh={() => void refresh()} />
          ))}

          {/* The seller's view offers no bid form: a seller doesn't bid on their own lot. */}
          {auction.state === "open" && mounted && !seller && !hasKey && <BidForm auction={auction} onPlaced={(all) => (setTickets(all), void refresh())} hasBids={tickets.length > 0} />}
          {auction.state === "open" && seller && (
            <p className="muted small" id="seller-no-bid">
              Bidding is switched off in your seller view. Bidders use the public link.
            </p>
          )}

          {auction.state !== "open" && tickets.length === 0 && !seller && (
            <div className="card">
              <p style={{ margin: 0 }}>
                Bidding is closed. If you bid from another browser, restore your bid from its ticket file to reveal it and see your result.
              </p>
            </div>
          )}

          <RestoreTicket auctionId={id} onRestored={(all) => (setTickets(all), void refresh())} />
        </div>

        <div>
          <div className="card">
            <h3>The board</h3>
            <p className="muted small">
              Every sealed bid, as the commitment the bidder&apos;s browser made. It hides the amount and can&apos;t be changed afterwards.
            </p>
            {auction.commitments.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                No bids yet.
              </p>
            ) : (
              <ol className="board" id="board">
                {auction.commitments.map((c, i) => (
                  <li key={c}>
                    <b>#{i + 1}</b>
                    <span>{c}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="card">
            <h3>How this auction works</h3>
            <p className="muted small" style={{ margin: 0 }}>
              Bids are sealed and funded by a shielded deposit. When bidding closes, bidders reveal. The highest bid at or above the
              reserve wins and pays exactly what it bid. One shielded transaction then returns every other deposit and{" "}
              {auction.delivery ? "sets the price aside for the seller" : "pays the seller"}, so the site keeps nothing. Each payment carries an
              equal share of the network fee (about 0.00005 TAZ).
            </p>
            {auction.delivery && (
              <p className="muted small" style={{ margin: "10px 0 0" }} id="delivery-terms">
                <strong style={{ color: "var(--text)" }}>{auction.delivery.kind === "digital" ? "Digital lot." : auction.delivery.kind === "promise" ? "A promise." : "Physical lot."}</strong> The
                seller is not paid at the close: the price is held until {auction.delivery.kind === "promise" ? "the promise is kept" : "the lot is handed over"}.{" "}
                {auction.delivery.kind === "digital"
                  ? "The lot was encrypted in the seller's browser. After the sale the seller's browser sends the key, sealed so only the winner can open it. If the key doesn't arrive, or doesn't open the lot, the winner is refunded."
                  : auction.delivery.kind === "promise"
                    ? "The winner tells the seller what they want, sealed so only the seller can read it. If the seller doesn't do it in time, the winner is refunded; a dispute is decided by the operator."
                    : "The winner sends shipping details sealed so only the seller can read them. If the seller doesn't ship in time, the winner is refunded; a dispute is decided by the operator."}{" "}
                Time limits: {span(auction.delivery.deliver_seconds)} to hand over, then {span(auction.delivery.dispute_seconds)} to complain.
              </p>
            )}
            {sellerBond > 0 && (
              <p className="muted small" style={{ margin: "10px 0 0" }} id="bond-terms">
                <strong style={{ color: "var(--text)" }}>Bonds.</strong> The seller has put down {formatCoins(sellerBond)} TAZ. Every bid carries a bond
                of {formatCoins(buyerBond)} TAZ on top of the bid. Honest parties get theirs back. A seller who doesn&apos;t deliver, or loses a
                dispute, loses their bond to the winner. A winner who opens a dispute and loses it, or never says where to send a posted lot,
                loses theirs to the seller.
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** Shown to the seller while the listing waits for their bond. */
function BondFunding({ bond }: { bond: NonNullable<SellerView["bond"]> }) {
  const uri = paymentRequest(bond.address, formatCoins(bond.required));
  const received = bond.received ?? 0;
  return (
    <div id="bond-funding" style={{ marginBottom: 12 }}>
      <p className="small" style={{ marginBottom: 10 }}>
        <strong>Fund your bond to open the auction.</strong> Send <strong>{formatCoins(bond.required)} TAZ</strong> from a shielded balance to the
        address below, with no memo. Bidding opens when it is in a block. You get it back with your payment, or when the lot doesn&apos;t sell;
        you lose it to the winner if you don&apos;t deliver or lose a dispute.
      </p>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Qr value={uri} size={150} />
        <div className="grow">
          <div className="addr" id="bond-address">{bond.address}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <a className="btn primary sm pay-link" href={uri}>
              Pay from wallet
            </a>
            <Copy text={bond.address} label="Copy address" />
          </div>
          <p className="hint" id="bond-received">
            {received >= bond.required
              ? "Received. Opening the auction…"
              : received > 0
                ? `${formatCoins(received)} TAZ has arrived; ${formatCoins(bond.required - received)} TAZ more is needed.`
                : "Nothing has arrived yet."}{" "}
            If the bond is not here by {new Date(bond.wait_until).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })},
            the listing is cancelled.
          </p>
        </div>
      </div>
    </div>
  );
}

function BidForm({ auction, onPlaced, hasBids }: { auction: PublicAuction; onPlaced: (all: Ticket[]) => void; hasBids: boolean }) {
  const [amount, setAmount] = useState("");
  const [refund, setRefund] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // A connected wallet's saved address is filled in; it can still be replaced.
  useEffect(() => {
    const fill = () => {
      const address = loadWallet()?.refund_address ?? null;
      setSaved(address);
      if (address) setRefund((r) => (r === "" ? address : r));
    };
    fill();
    window.addEventListener(WALLET_EVENT, fill);
    return () => window.removeEventListener(WALLET_EVENT, fill);
  }, []);

  const zat = parseCoins(amount);
  const problem =
    amount.trim() === ""
      ? null
      : zat === null
        ? "Enter an amount like 0.05"
        : zat < Math.max(MIN_BID, auction.reserve)
          ? `A bid below the reserve (${formatCoins(auction.reserve)} TAZ) can't win`
          : null;
  const ready = zat !== null && !problem && refund.trim().length > 20 && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || zat === null) return;
    setBusy(true);
    setError(null);
    try {
      // All of this happens here, in the browser. Only the commitment, the
      // hash of a token and the refund address are sent.
      const nonce = newNonce();
      const commitment = await commit(auction.id, zat, nonce);
      const token_hash = await sha256Hex(await bidToken(nonce));
      // If this bid wins, the lot is sealed to this key. The private half stays in the ticket.
      const delivery_key = auction.delivery ? newDeliveryKey() : undefined;
      const res = await fetch(`/api/auctions/${auction.id}/bids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commitment, token_hash, refund_address: refund.trim(), ...(delivery_key ? { delivery_pub: deliveryPublic(delivery_key) } : {}) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "the bid was refused");
      const all = saveTicket({
        auction_id: auction.id,
        bid_id: body.bid_id,
        amount: zat,
        nonce,
        deposit_address: body.deposit_address,
        placed_at: Date.now(),
        ...(delivery_key ? { delivery_key } : {}),
      });
      setAmount("");
      setRefund(saved ?? "");
      setOpen(false);
      onPlaced(all);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // After a first bid, keep the form out of the way until it is asked for.
  if (hasBids && !open) {
    return (
      <p>
        <button type="button" id="another-bid" onClick={() => setOpen(true)}>
          Place another bid
        </button>
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="card" id="bid-form">
      <h3>{hasBids ? "Place another bid" : "Place a sealed bid"}</h3>
      <p className="muted small">
        One sealed number. If it is the highest, you win and pay exactly that. Nobody sees it until bidding has closed, and nothing
        anyone else bids can change what you pay.
      </p>
      <label htmlFor="amount">Your bid (TAZ)</label>
      <input id="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={formatCoins(auction.reserve)} />
      <p className={problem ? "hint error" : "hint"}>
        {problem ??
          (auction.delivery && auction.delivery.buyer_bond > 0
            ? `Stays in this browser until bidding closes. You will deposit your bid plus a bond of ${formatCoins(auction.delivery.buyer_bond)} TAZ, which comes back unless you open a dispute and lose it.`
            : "Stays in this browser until bidding closes.")}
      </p>

      <label htmlFor="refund">Your shielded refund address</label>
      <input id="refund" className="mono" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="utest1…" spellCheck={false} autoComplete="off" />
      <p className="hint">
        {saved && refund === saved ? (
          <>From your connected wallet. Your deposit, or what is left of it, comes back here. Paste a fresh address instead if you prefer.</>
        ) : (
          <>
            A fresh unified address from your testnet wallet. Your deposit, or what is left of it, comes back here.{" "}
            <button type="button" className="link small" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}>
              Connect a wallet
            </button>{" "}
            to have it filled in.
          </>
        )}
      </p>

      {error && <p className="error">{error}</p>}
      <div className="row" style={{ marginTop: 18 }}>
        <button className="primary lg" disabled={!ready}>
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" /> Sealing…
            </>
          ) : (
            "Seal my bid"
          )}
        </button>
      </div>
    </form>
  );
}

function MyBid({ ticket, view, auction, note, refresh }: { ticket: Ticket; view?: BidView; auction: PublicAuction; note?: string; refresh: () => void }) {
  const deposit = view?.deposit;
  const funded = (deposit?.total ?? 0) > 0;
  const bond = auction.delivery?.buyer_bond ?? 0;
  const needed = ticket.amount + bond;
  const enough = (deposit?.counted ?? 0) >= needed;
  const roomy = roomyDeposit(needed);
  const uri = paymentRequest(ticket.deposit_address, formatCoins(roomy));

  return (
    <div className={`card ${view?.standing === "won" ? "accent" : ""}`} data-bid={ticket.bid_id}>
      <div className="row spread">
        <h3 style={{ margin: 0 }}>Your sealed bid</h3>
        <strong className="mono">{formatCoins(ticket.amount)} TAZ</strong>
      </div>

      {auction.state === "open" && !funded && (
        <>
          <p className="small" style={{ marginTop: 12 }}>
            <strong>Now fund it.</strong> Send <strong>at least {formatCoins(needed)} TAZ</strong>
            {bond > 0 && <> (your bid plus the {formatCoins(bond)} TAZ bond)</>} from a shielded balance to the
            address below, with no memo. It was made for this bid alone.
          </p>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <Qr value={uri} size={150} />
            <div className="grow">
              <div className="addr deposit-address">{ticket.deposit_address}</div>
              <div className="row" style={{ marginTop: 10 }}>
                <a className="btn primary sm pay-link" href={uri}>
                  Pay from wallet
                </a>
                <Copy text={ticket.deposit_address} label="Copy address" />
                <Copy text={uri} label="Copy payment request" />
              </div>
              <p className="hint">
                The button opens your Zcash wallet app with this address and {formatCoins(roomy)} TAZ filled in. No wallet app on this device?
                Scan the code with your phone.
              </p>
              <p className="hint">
                Sending more hides your bid from this site, which can see deposits: for example {formatCoins(roomy)} TAZ. Whatever you send
                above your bid comes back to your refund address.
              </p>
            </div>
          </div>
        </>
      )}

      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>Deposit</dt>
        <dd className="deposit-status">
          {!deposit
            ? "checking…"
            : !funded
              ? "not seen yet"
              : `${formatCoins(deposit.total)} TAZ · ${Math.min(deposit.confirmations, deposit.needed)} of ${deposit.needed} confirmations`}
        </dd>
        {funded && deposit && deposit.counted < deposit.total && (
          <>
            <dt>Arrived after the close</dt>
            <dd>{formatCoins(deposit.total - deposit.counted)} TAZ (returned)</dd>
          </>
        )}
        <dt>Bid</dt>
        <dd className="reveal-status">
          {view?.revealed ? "revealed" : auction.state === "open" ? "sealed" : auction.state === "revealing" ? "revealing…" : "not revealed"}
        </dd>
        <dt>Refund address</dt>
        <dd>{view?.refund_address ?? "…"}</dd>
      </dl>

      {funded && !enough && auction.state === "open" && (
        <p className="error small" style={{ marginBottom: 0 }}>
          Your deposit is smaller than your bid{bond > 0 ? " plus the bond" : ""} ({formatCoins(needed)} TAZ). Send the difference to the same address
          before bidding closes, or this bid won&apos;t count.
        </p>
      )}
      {note && <p className="error small">Couldn&apos;t reveal yet: {note}</p>}

      {view?.standing && (
        <div style={{ marginTop: 14 }} className="standing">
          <p style={{ marginBottom: 8 }}>
            <strong className={view.standing === "won" ? "ok" : undefined}>{STANDING[view.standing]}</strong>
            {view.standing === "won" && auction.outcome?.price != null && <> You pay {formatCoins(auction.outcome.price)} TAZ, your bid.</>}
          </p>
          {view.delivery && <WinnerDelivery auction={auction} ticket={ticket} view={view} refresh={refresh} />}
          {view.payments.length === 0 && auction.state === "settling" && funded && (
            <p className="muted small" style={{ margin: 0 }}>
              Your money moves when every deposit has enough confirmations.
            </p>
          )}
          {view.payments.map((p) => (
            <dl className="kv" key={p.txid + p.kind}>
              <dt>{p.kind === "winner-change" ? "Returned above your bid" : p.late ? "Late deposit returned" : "Returned to you"}</dt>
              <dd>
                {formatCoins(p.paid)} TAZ <span className="muted">(after {formatCoins(p.owed - p.paid)} fee share)</span>
              </dd>
              <dt>Transaction ({p.status})</dt>
              <dd>
                {p.txid.slice(0, 16)}… <Copy text={p.txid} />
              </dd>
            </dl>
          ))}
        </div>
      )}

      <p className="hint" style={{ marginTop: 14 }}>
        This browser holds the only copy of your bid. Without it the bid can&apos;t be revealed and won&apos;t count (your deposit still comes back)
        {auction.delivery?.kind === "digital" ? ", and a lot you win can't be unlocked" : ""}.{" "}
        <button type="button" className="link small" onClick={() => download(`dark-vault-bid-${ticket.bid_id.slice(0, 8)}.txt`, ticketFile(ticket, auction.title))}>
          Save the ticket file
        </button>
      </p>
    </div>
  );
}

function RestoreTicket({ auctionId, onRestored }: { auctionId: string; onRestored: (all: Ticket[]) => void }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <p className="muted small">
      Bid from another browser?{" "}
      <label style={{ display: "inline", fontWeight: 500, margin: 0, color: "var(--lime)", cursor: "pointer" }}>
        Restore a ticket file
        <input
          type="file"
          accept=".txt,text/plain"
          style={{ display: "none" }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            // Read here in the browser; the file is not uploaded.
            const ticket = parseTicketFile(await file.text(), auctionId);
            if (!ticket) return setMessage("That file isn't a ticket for this auction.");
            setMessage("Ticket restored.");
            onRestored(saveTicket(ticket));
          }}
        />
      </label>
      {message && <> {message}</>}
    </p>
  );
}
