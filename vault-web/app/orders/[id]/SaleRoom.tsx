"use client";

// A batch sale (the Order Flow market), as its buyers and its seller see it.
//
// One seller offers several identical units. Buyers send sealed orders, one
// order for one unit:
//
//   1. Seal an order: this browser turns the amount into a commitment and
//      locks the amount in time. The site is sent the commitment, the locked
//      order and a refund address, never an amount it can read.
//   2. Deposit: the order plus the bond, to an address made for this one
//      order, or a larger round amount to keep the order from the site too.
//   3. Unlock: when the sale closes the time lock opens and the site reads
//      the orders.
//   4. Result: the highest orders win a unit each, and each pays exactly what
//      it offered. The public result is how many units sold and the lowest
//      order that won. The site publishes a proof of it, which this browser
//      checks (see ../../auction/[id]/Verify.tsx).
//   5. Handover: each winner's price is held in an escrow of its own until
//      their unit has been handed over (see ../../auction/[id]/Delivery.tsx).
//
// A sale is always public, always time-locked, and every unit is digital.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BATCH_MAX_ORDER,
  bidToken,
  deliveryPublic,
  formatCoins,
  hidingDeposit,
  isPublicBeacon,
  manageToken,
  MIN_BID,
  newBlinding,
  newDeliveryKey,
  newId,
  parseCoins,
  pedersenCommit,
  roundAfter,
  roundTimeMs,
  sealBid,
  sealedHash,
  sha256Hex,
  trustedChain,
  verifyReceipt,
  type Receipt,
} from "vault-core";
import Countdown from "@/app/components/Countdown";
import PhotoGallery from "@/app/components/PhotoGallery";
import Qr from "@/app/components/Qr";
import PayLink from "@/app/components/PayLink";
import { saleLabel, unitsWord } from "@/app/components/SaleTile";
import { SeatsFull, seatsLeft, SeatsStat } from "@/app/components/AuctionTile";
import { SellerDelivery, WinnerDelivery } from "@/app/auction/[id]/Delivery";
import VerifyResult from "@/app/auction/[id]/Verify";
import { sellerKeyFor } from "@/lib/sellerKey";
import { loadTickets, mayOpenByHand, parseTicketFile, saveTicket, ticketFile, tokenOf, WALLET_EVENT, type Ticket } from "@/lib/tickets";
import { loadWallet, OPEN_EVENT, paymentRequest } from "@/lib/wallet";
import type { BidView, PublicAuction, SellerView } from "@/lib/views";

const STANDING: Record<string, string> = {
  won: "You won a unit.",
  outbid: "Every unit went to a higher order. Your deposit comes back to you.",
  "below-reserve": "Your order was below the lowest price. Your deposit comes back to you.",
  "not-revealed": "Your order could not be opened, so it did not count. Your deposit comes back to you.",
  underfunded: "Your deposit did not cover your order and the bond, so the order did not count. Your deposit comes back to you.",
  "over-ceiling": "Your order was larger than a sale can take, so it did not count. Your deposit comes back to you.",
  "no-deposit": "No deposit arrived before the sale closed, so this order did not count.",
};

const BOARD: Record<string, string> = { counted: "counted", "no-deposit": "no deposit", underfunded: "short deposit", unopened: "not opened" };

/** How long this browser waits for the time lock to open its order before opening it from the ticket. */
const UNLOCK_PATIENCE_MS = 20_000;

const clockTime = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

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

export default function SaleRoom({ initial, serverNow }: { initial: PublicAuction; serverNow: number }) {
  const [auction, setAuction] = useState(initial);
  const [offset, setOffset] = useState(0); // server clock minus this browser's clock
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [views, setViews] = useState<Record<string, BidView>>({});
  // Tickets the site has no order for. (A ticket can come from a file; the site's record is what counts.)
  const [unknown, setUnknown] = useState<Record<string, boolean>>({});
  const [seller, setSeller] = useState<SellerView | null>(null);
  const [revealNote, setRevealNote] = useState<Record<string, string>>({});
  const revealing = useRef(new Set<string>());
  // The manage key stays in this browser. The site is shown a token derived from it.
  const manageKey = useRef<string | null>(null);
  const manageTok = useRef<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  // The order form waits for this: the server can't know whether this browser is the seller's.
  const [mounted, setMounted] = useState(false);
  const id = auction.id;
  const batch = auction.batch!;

  useEffect(() => {
    setOffset(serverNow - Date.now());
    setTickets(loadTickets(id));
    // The seller's key arrives in the link's #fragment, which browsers never
    // send to a server. It is kept only once the site confirms it is this
    // sale's key, and is then taken out of the address bar (see lib/sellerKey).
    void sellerKeyFor(id).then((key) => {
      manageKey.current = key;
      setHasKey(key !== null);
      setMounted(true); // the poll below starts again now, with the seller's view
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const refresh = useCallback(async () => {
    const mine = loadTickets(id);
    const next: Record<string, BidView> = {};
    const gone: Record<string, boolean> = {};
    await Promise.all(
      mine.map(async (t) => {
        try {
          const res = await fetch(`/api/auctions/${id}/bids/${t.bid_id}`, { headers: { "x-bid-token": await tokenOf(t) } });
          if (res.ok) next[t.bid_id] = (await res.json()).bid;
          else {
            if (res.status === 404) gone[t.bid_id] = true;
            void res.body?.cancel(); // an answer nobody reads would otherwise stay open
          }
        } catch {
          /* next poll */
        }
      }),
    );
    // The record is asked for after the orders, so it is never older than they
    // are: an order that says "won" is then always shown with the result it won.
    try {
      const res = await fetch(`/api/auctions/${id}`);
      if (res.ok) {
        const body = await res.json();
        setAuction(body.auction);
        setOffset(body.now - Date.now());
      } else void res.body?.cancel();
    } catch {
      /* keep what we have; the next poll tries again */
    }
    setViews((old) => ({ ...old, ...next }));
    setUnknown(gone);
    if (manageKey.current) {
      try {
        manageTok.current ??= await manageToken(manageKey.current);
        const res = await fetch(`/api/auctions/${id}/seller`, { headers: { "x-manage-key": manageTok.current } });
        if (res.ok) setSeller((await res.json()).seller);
        else {
          if (res.status === 404) setHasKey(false); // not this record's key
          void res.body?.cancel();
        }
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
  }, [refresh, auction.state, auction.paid, mounted]);

  // The site opens the orders itself when the lock's round is signed. This is
  // the fallback, used only for an order the lock has not opened after a short wait.
  const buyerBond = auction.delivery?.buyer_bond ?? 0;
  useEffect(() => {
    if (auction.state !== "revealing") return;
    const closedAt = (auction.reveal_ends_at ?? 0) - auction.reveal_seconds * 1000;
    for (const t of tickets) {
      const v = views[t.bid_id];
      if (!v || v.revealed || revealing.current.has(t.bid_id)) continue;
      // This browser's own check: an order is never opened by hand before its own lock has passed, by this browser's clock.
      if (!mayOpenByHand(t, auction.timelock?.chain)) continue;
      // An order that can't count has no reason to tell the site its amount.
      if (v.deposit && v.deposit.counted < t.amount + buyerBond) continue;
      if (!v.unopenable && Date.now() + offset < closedAt + UNLOCK_PATIENCE_MS) continue;
      revealing.current.add(t.bid_id);
      void (async () => {
        try {
          const res = await fetch(`/api/auctions/${id}/bids/${t.bid_id}/reveal`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount: t.amount, nonce: t.nonce }),
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error ?? "the order could not be opened");
          setRevealNote((n) => ({ ...n, [t.bid_id]: "" }));
          void refresh();
        } catch (e) {
          setRevealNote((n) => ({ ...n, [t.bid_id]: e instanceof Error ? e.message : String(e) }));
          revealing.current.delete(t.bid_id); // try again on the next poll
        }
      })();
    }
  }, [auction.state, auction.reveal_ends_at, auction.reveal_seconds, auction.timelock?.chain, buyerBond, offset, tickets, views, id, refresh]);

  const share = typeof window === "undefined" ? "" : `${window.location.origin}/orders/${id}`;
  const label = saleLabel(auction);
  const lock = auction.timelock;
  // Checked here against the key built into this page, not taken from the server's word.
  const testBeacon = !!lock && !isPublicBeacon(lock.chain);
  const steps = ["Sealed Orders", "Unlock", "Settle", "Hand Over", "Paid"];
  const stepIndex = { funding: -1, open: 0, revealing: 1, settling: 2, delivering: 3, settled: steps.length - 1 }[auction.state];
  const sellerBond = auction.delivery?.seller_bond ?? 0;
  const cancelled = !!auction.outcome?.cancelled;
  const sold = batch.sold ?? 0;
  const winners = new Set(auction.outcome?.winner_positions ?? []);
  // This browser's own orders on the board.
  const mine = new Set<string>();
  for (const t of tickets) {
    try {
      mine.add(pedersenCommit(id, t.amount, t.nonce));
    } catch {
      /* not a ticket for a sale */
    }
  }
  const paid = auction.paid === "mined" || auction.paid === "nothing-to-pay";
  const decided = auction.state === "settling" || auction.state === "delivering" || auction.state === "settled";

  return (
    <>
      <div className="room-head">
        <div>
          <span className={`badge ${label.cls}`} id="sale-state">
            {auction.state === "open" && <i className="dot live" />}
            {(auction.state === "revealing" || auction.state === "settling" || auction.state === "delivering") && <i className="dot amber" />}
            {label.text}
          </span>
          <span className="badge units-tag" id="units-badge" style={{ marginLeft: 8 }}>
            {unitsWord(batch.units)}
          </span>
          <h1 style={{ marginTop: 14 }} id="sale-title">
            {auction.title}
          </h1>
          {auction.description && (
            <p className="muted" style={{ whiteSpace: "pre-wrap", maxWidth: 640 }} id="sale-description">
              {auction.description}
            </p>
          )}
          <PhotoGallery auctionId={auction.id} count={auction.photos ?? 0} sealed={false} title={auction.title} />
        </div>

        <div className="clock" id="clock">
          {auction.state === "funding" && (
            <>
              <span className="muted small">Status</span>
              <div className="big">Not Open Yet</div>
              <span className="muted small">
                Orders open when the seller&apos;s bond of {formatCoins(sellerBond)} TAZ has arrived. Check back in a few minutes.
              </span>
              <p className="clock-min">
                Lowest price per unit: <strong>{formatCoins(auction.reserve)} TAZ</strong>
              </p>
            </>
          )}
          {auction.state === "open" && (
            <>
              <span className="muted small">Orders close in</span>
              <div className="big">
                <Countdown to={auction.ends_at} offset={offset} onDone={() => void refresh()} />
              </div>
              <span className="muted small">Orders are locked in time until then. Nobody can open one early, this site included.</span>
              <p className="clock-min" id="clock-min">
                Lowest price per unit: <strong>{formatCoins(auction.reserve)} TAZ</strong>
                <br />
                You deposit: <strong>your order{buyerBond > 0 ? ` + ${formatCoins(buyerBond)} TAZ bond` : ""}</strong>
              </p>
            </>
          )}
          {auction.state === "revealing" && (
            <>
              <span className="muted small">The sale is closed</span>
              <div className="big" id="unlocking">
                Opening Orders…
              </div>
              <span className="muted small">
                {lock?.beacon ? "The time lock has opened." : "Waiting for the time lock to open."} {auction.revealed} of {auction.funded ?? auction.bids} funded
                orders opened. An order the lock can&apos;t open can be opened by its buyer for another{" "}
                <Countdown to={auction.reveal_ends_at ?? 0} offset={offset} onDone={() => void refresh()} />.
              </span>
            </>
          )}
          {decided && (
            <>
              <span className="muted small">{auction.outcome?.sold ? "Lowest winning order" : "Result"}</span>
              <div className="big" id="result-price">
                {cancelled ? "Never Opened" : auction.outcome?.sold ? <span className="price">{formatCoins(auction.outcome.price!)} TAZ</span> : "Nothing Sold"}
              </div>
              <span className="muted small" id="result-line">
                {cancelled
                  ? "The seller's bond did not arrive, so the sale never opened."
                  : auction.outcome?.sold
                    ? `${sold} of ${batch.units} units sold. Each buyer pays what they offered: this much or more. What each one offered is not public.`
                    : "No order met the lowest price."}{" "}
                {cancelled
                  ? ""
                  : auction.state === "settling"
                    ? "Waiting for deposits to confirm, then one transaction pays everyone."
                    : auction.state === "delivering"
                      ? auction.outcome?.sold
                        ? `Every other deposit has been returned. Each price is held until its unit is handed over: ${batch.done ?? 0} of ${sold} done.`
                        : "Every deposit has been returned."
                      : paid
                        ? auction.paid === "mined"
                          ? auction.outcome?.sold
                            ? "Every unit's handover is finished and paid out."
                            : "Every deposit has been returned."
                          : "No deposits were made, so there was nothing to pay."
                        : "The payout is on its way to a block."}
              </span>
            </>
          )}
          <div className="stats">
            <div>
              <b id="stat-units">{auction.outcome && !cancelled ? `${sold}/${batch.units}` : batch.units}</b>
              <span>{auction.outcome && !cancelled ? "units sold" : "units"}</span>
            </div>
            <div>
              <b id="stat-orders">{auction.bids}</b>
              <span>sealed orders</span>
            </div>
            <div>
              <b id="stat-funded">{auction.funded ?? "–"}</b>
              <span>funded</span>
            </div>
            <SeatsStat auction={auction} />
            <div>
              <b>{formatCoins(auction.reserve)}</b>
              <span>lowest price (TAZ)</span>
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

      {testBeacon && (
        <div className="card warn" id="test-beacon">
          <strong style={{ color: "var(--amber)" }}>TEST BEACON.</strong> This sale&apos;s orders are locked to a stand-in, not the public drand network. A
          stand-in can be made to open early, so it locks nothing. For testing only: do not order with real value here.
        </div>
      )}

      {(sellerBond > 0 || buyerBond > 0) && (
        <div className="card" id="stakes">
          <h3 style={{ marginTop: 0 }}>Both Sides Have Something To Lose</h3>
          <div className="stakes">
            <div>
              <span className="muted small">The seller&apos;s bond</span>
              <b className="mono" id="stake-seller">
                {formatCoins(sellerBond)} TAZ
              </b>
              <p className="small muted">
                Paid in before orders opened: {formatCoins(batch.seller_bond_per_unit)} TAZ for each of the {batch.units} units. For every unit they
                don&apos;t hand over in time, or lose a dispute over, the seller loses that unit&apos;s share to its buyer.
              </p>
            </div>
            <div>
              <span className="muted small">Every order&apos;s bond</span>
              <b className="mono" id="stake-buyer">
                {formatCoins(buyerBond)} TAZ
              </b>
              <p className="small muted">
                Part of every deposit. Everyone who doesn&apos;t win a unit gets it straight back. A buyer loses it to the seller only if they open
                a dispute and lose it.
              </p>
            </div>
          </div>
          <p className="small" style={{ margin: "12px 0 0" }}>
            A seller and a buyer who both do their part get their bonds back in full.
          </p>
        </div>
      )}

      {!auction.signer_online && (
        <div className="card bad">
          <strong>The signer is offline.</strong> Deposits can&apos;t be seen and nothing can be paid until it is back. Nothing is lost.
        </div>
      )}

      <div className="cols">
        <div>
          {seller && (
            <div className="card accent" id="seller-card">
              <h3>You Are The Seller</h3>
              <p className="small muted" id="seller-private">
                <strong style={{ color: "var(--amber)" }}>Private view.</strong> This browser holds your seller key. Never share your seller link: anyone
                who has it can act as the seller. Give buyers the public link instead. <Copy text={share} label="Copy The Public Link" />
              </p>
              {auction.state === "funding" && seller.bond && <BondFunding bond={seller.bond} units={batch.units} />}
              {seller.bond && auction.state !== "funding" && !decided && (
                <p className="small muted" id="bond-status" style={{ marginBottom: 8 }}>
                  Your bond of {formatCoins(seller.bond.required)} TAZ is held. After the close, the share of every unit that did not sell comes
                  straight back, and each sold unit&apos;s share comes back with its payment.
                </p>
              )}
              {!decided && auction.state !== "funding" && (
                <p className="small" style={{ margin: 0 }} id="seller-waiting-close">
                  When the sale closes, each winning order&apos;s price is held. Keep this link: open it after the close and your browser sends each
                  buyer the key to their unit. You are paid for each unit once its buyer has it.
                </p>
              )}
              {decided && !cancelled && (
                <SellerUnits auction={auction} seller={seller} manageKey={manageKey.current} token={manageTok.current} refresh={() => void refresh()} />
              )}
              {cancelled && (
                <p className="small" style={{ margin: 0 }}>
                  Your bond did not arrive in time, so this sale never opened. If it arrives late, it is sent back to your payout address.
                </p>
              )}
            </div>
          )}

          {tickets.map((t) => (
            <MyOrder key={t.bid_id} ticket={t} view={views[t.bid_id]} unknown={!!unknown[t.bid_id]} auction={auction} note={revealNote[t.bid_id]} refresh={() => void refresh()} />
          ))}

          {/* The seller's view offers no order form: a seller doesn't order their own units. */}
          {auction.state === "open" && mounted && !seller && !hasKey && <OrderForm auction={auction} onPlaced={(all) => (setTickets(all), void refresh())} hasOrders={tickets.length > 0} />}
          {auction.state === "open" && seller && (
            <p className="muted small" id="seller-no-order">
              Ordering is switched off in your seller view. Buyers use the public link.
            </p>
          )}

          {auction.state !== "open" && auction.state !== "funding" && tickets.length === 0 && !seller && (
            <div className="card">
              <p style={{ margin: 0 }}>The sale is closed. If you ordered from another browser, restore your order from its ticket file to see your result.</p>
            </div>
          )}

          <RestoreTicket auctionId={id} onRestored={(all) => (setTickets(all), void refresh())} />
        </div>

        <div>
          {mounted && !cancelled && <ShareCard link={share} open={auction.state === "open" || auction.state === "funding"} />}
          <VerifyResult auction={auction} tickets={tickets} />
          <div className="card">
            <h3>The Board</h3>
            <p className="muted small">
              Every sealed order, as the commitment the buyer&apos;s browser made. It hides the amount and can&apos;t be changed afterwards.
              {auction.board && " Next to each: whether it counted, and whether it won a unit."}
            </p>
            {auction.commitments.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                No orders yet.
              </p>
            ) : (
              <ol className="board" id="board">
                {auction.commitments.map((c, i) => {
                  const won = winners.has(i + 1);
                  const status = auction.board?.[i];
                  return (
                    <li key={c} className={mine.has(c) ? "mine" : undefined}>
                      <b>#{i + 1}</b>
                      <span>{c}</span>
                      {status && <em className={won ? "won" : status === "counted" ? undefined : "out"}>{won ? "won a unit" : BOARD[status]}</em>}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          {lock && (
            <div className="card" id="timelock-card">
              <h3>The Time Lock</h3>
              <p className="muted small" style={{ margin: 0 }}>
                Each order is encrypted, in the buyer&apos;s browser, to round <span className="mono">{lock.round}</span> of{" "}
                {testBeacon ? "a test beacon" : "the drand network (the League of Entropy, about twenty independent organisations)"}. That round is
                signed at <span className="mono">{clockTime(lock.opens_at)}</span>, just after the sale closes, and its signature is the only key.{" "}
                {lock.beacon ? "It has been signed, and the orders were opened with it." : "Until then it does not exist, so no order can be opened: not by this site, not by anyone."}
              </p>
            </div>
          )}
          <div className="card">
            <h3>How This Sale Works</h3>
            <p className="muted small" style={{ margin: 0 }} id="how-it-works">
              The seller offers {batch.units} identical units. Each order is for one unit, sealed in the buyer&apos;s browser and locked in time. A
              buyer deposits their order{buyerBond > 0 ? " plus the bond" : ""} in a shielded payment, so the chain shows nothing. This site does
              see deposits arrive, so a buyer who wants to keep the amount from the site too sends a larger, round amount and gets the rest back.
            </p>
            <p className="muted small" style={{ margin: "10px 0 0" }} id="how-it-clears">
              <strong style={{ color: "var(--text)" }}>Pay What You Offered.</strong> When the sale closes the lock opens. The {batch.units} highest
              orders at or above the lowest price win a unit each, and each pays exactly what it offered; of two equal orders, the one placed
              first. Nothing anyone else offers can change what you pay. The public result is how many units sold and the lowest order that won.
              The site publishes a proof that the right orders won, which your browser checks, and what the other orders offered is never shown.
            </p>
            <p className="muted small" style={{ margin: "10px 0 0" }} id="delivery-terms">
              <strong style={{ color: "var(--text)" }}>Digital Units.</strong> Each unit was encrypted in the seller&apos;s browser with a key of its own.
              No seller is paid at the close: each winning price is held in an escrow of its own, and after the sale the seller&apos;s browser sends
              each buyer the key to their unit, sealed so only they can open it. If a key doesn&apos;t arrive, or doesn&apos;t open the unit, that
              buyer is refunded. Time limits: {span(auction.delivery!.deliver_seconds)} to hand over, then {span(auction.delivery!.dispute_seconds)}{" "}
              for the buyer to open a dispute. One shielded transaction returns every other deposit, so the site keeps nothing; each payment
              carries an equal share of the network fee.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

/** The seller's side of every unit that sold: the key goes out by itself, and each unit shows where its handover stands. */
function SellerUnits({ auction, seller, manageKey, token, refresh }: { auction: PublicAuction; seller: SellerView; manageKey: string | null; token: string | null; refresh: () => void }) {
  const units = seller.units ?? [];
  const batch = auction.batch!;
  const unsold = batch.units - units.length;
  const received = units.reduce((n, u) => n + (u.proceeds?.paid ?? 0), 0) + (seller.bond_back?.paid ?? 0) + (units.length === 0 ? (seller.proceeds?.paid ?? 0) : 0);
  return (
    <div id="seller-units">
      {units.length === 0 ? (
        <p className="small" style={{ margin: 0 }} id="seller-nothing-sold">
          No unit sold, so nothing was paid to you.{" "}
          {seller.proceeds ? `Your bond came back: ${formatCoins(seller.proceeds.paid)} TAZ after the network fee.` : seller.bond ? "Your bond is on its way back to you." : ""}
        </p>
      ) : (
        <p className="small" id="seller-summary">
          <strong>
            {units.length} of {batch.units} units sold.
          </strong>{" "}
          Each buyer pays what they offered, so each unit has its own price. Each price is held in an escrow of its own until that unit is handed
          over.
          {unsold > 0 && (
            <>
              {" "}
              {seller.bond_back
                ? `Your bond for the ${unsold} unsold ${unsold === 1 ? "unit" : "units"} came back: ${formatCoins(seller.bond_back.paid)} TAZ (${seller.bond_back.status}).`
                : `Your bond for the ${unsold} unsold ${unsold === 1 ? "unit" : "units"} is on its way back.`}
            </>
          )}
        </p>
      )}
      {units.map((u) => (
        <div className="unit-row" key={u.unit} data-unit-row={u.unit}>
          <div className="row spread">
            <strong>Unit {u.unit}</strong>
            <span className="mono unit-price">{formatCoins(u.price)} TAZ</span>
          </div>
          {!u.delivery && (
            <p className="small muted" style={{ margin: "6px 0 0" }}>
              <span className="spinner" aria-hidden="true" /> Moving this unit&apos;s price into its escrow…
            </p>
          )}
          {u.delivery && manageKey && token && <SellerDelivery auction={auction} seller={seller} manageKey={manageKey} token={token} refresh={refresh} unit={{ number: u.unit, delivery: u.delivery }} />}
          {u.proceeds && (
            <p className="small unit-paid" style={{ margin: "6px 0 0" }}>
              Sent to you: <strong>{formatCoins(u.proceeds.paid)} TAZ</strong> <span className="muted">({u.proceeds.status})</span>{" "}
              <Copy text={u.proceeds.txid} label="Copy Transaction" />
            </p>
          )}
        </div>
      ))}
      {received > 0 && units.length > 0 && (
        <p className="small" id="seller-total" style={{ margin: "12px 0 0" }}>
          Sent to {seller.payout_address} so far, after network fees: <strong>{formatCoins(received)} TAZ</strong>.
        </p>
      )}
    </div>
  );
}

/** The link to hand to buyers, as text and as a QR code. Drawn here in the browser: the link is sent nowhere. */
function ShareCard({ link, open }: { link: string; open: boolean }) {
  const [qr, setQr] = useState(false);
  return (
    <div className="card" id="share-card">
      <h3>Share This Sale</h3>
      <p className="small muted">
        {open ? "Anyone with this link can place an order." : "Anyone with this link can see the result and check its proof."} It carries nothing of
        yours: your orders and tickets stay in this browser.
      </p>
      <div className="addr" id="share-link">
        {link}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <Copy text={link} label="Copy The Link" />
        <button type="button" className="link small" id="share-qr-toggle" onClick={() => setQr((q) => !q)}>
          {qr ? "Hide The QR Code" : "Show A QR Code"}
        </button>
      </div>
      {qr && (
        <div style={{ marginTop: 12 }} id="share-qr">
          <Qr value={link} size={190} />
          <p className="hint">Scan it with a phone camera to open this sale there.</p>
        </div>
      )}
    </div>
  );
}

/** Shown to the seller while the sale waits for their bond. */
function BondFunding({ bond, units }: { bond: NonNullable<SellerView["bond"]>; units: number }) {
  const uri = paymentRequest(bond.address, formatCoins(bond.required));
  const received = bond.received ?? 0;
  return (
    <div id="bond-funding" style={{ marginBottom: 12 }}>
      <p className="small" style={{ marginBottom: 10 }}>
        <strong>Fund your bond to open the sale.</strong> Send <strong>{formatCoins(bond.required)} TAZ</strong> from a shielded balance to the address
        below, with no memo. That is one bond for each of the {units} units. Orders open when it is in a block. The share of every unit that
        doesn&apos;t sell comes straight back; each sold unit&apos;s share comes back with its payment. You lose a unit&apos;s share to its buyer
        if you don&apos;t hand that unit over or lose a dispute about it.
      </p>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Qr value={uri} size={150} />
        <div className="grow">
          <div className="addr" id="bond-address">
            {bond.address}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <PayLink href={uri} />
            <Copy text={bond.address} label="Copy Address" />
          </div>
          <p className="hint" id="bond-received">
            {received >= bond.required
              ? "Received. Opening the sale…"
              : received > 0
                ? `${formatCoins(received)} TAZ has arrived; ${formatCoins(bond.required - received)} TAZ more is needed.`
                : "Nothing has arrived yet."}{" "}
            If the bond is not here by {new Date(bond.wait_until).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}, the
            sale is cancelled.
          </p>
        </div>
      </div>
    </div>
  );
}

function OrderForm({ auction, onPlaced, hasOrders }: { auction: PublicAuction; onPlaced: (all: Ticket[]) => void; hasOrders: boolean }) {
  const [amount, setAmount] = useState("");
  const [refund, setRefund] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  // Ticked: deposit a round amount above the order, so the site can't work the order out from the deposit.
  const [hide, setHide] = useState(false);
  const bond = auction.delivery?.buyer_bond ?? 0;

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
        ? "Enter an amount like 0.05."
        : zat < Math.max(MIN_BID, auction.reserve)
          ? `An order below the lowest price (${formatCoins(auction.reserve)} TAZ) can't win a unit.`
          : zat > BATCH_MAX_ORDER
            ? `One order can be at most ${formatCoins(BATCH_MAX_ORDER)} TAZ.`
            : null;
  const exact = zat !== null && !problem ? zat + bond : null;
  const hidden = zat !== null && !problem ? hidingDeposit(auction.reserve, zat) + bond : null;
  const ready = zat !== null && !problem && refund.trim().length > 20 && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || zat === null) return;
    setBusy(true);
    setError(null);
    try {
      // All of this happens here, in the browser. Only the commitment, the
      // time-locked order, the hash of a token and the refund address are sent.
      const lock = auction.timelock;
      if (!lock) throw new Error("this sale has no time lock yet. Reload the page and try again.");
      // Checked here, not taken on trust: the lock must open after the sale closes, and must not have opened already.
      const chain = trustedChain(lock.chain);
      if (lock.round < roundAfter(chain, auction.ends_at) || roundTimeMs(chain, lock.round) <= Date.now())
        throw new Error("this sale's time lock would open before it closes. Don't order here.");
      const nonce = newBlinding();
      const commitment = pedersenCommit(auction.id, zat, nonce);
      const sealed = await sealBid(chain, lock.round, zat, nonce);
      // The access token has a secret of its own: the lowest winner's nonce is published with the proof.
      const token_secret = newId() + newId();
      const token_hash = await sha256Hex(await bidToken(token_secret));
      // If this order wins, its unit's key is sealed to this key. The private half stays in the ticket.
      const delivery_key = newDeliveryKey();
      const res = await fetch(`/api/auctions/${auction.id}/bids`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commitment, token_hash, refund_address: refund.trim(), sealed, delivery_pub: deliveryPublic(delivery_key) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "the order was refused");
      // The site's signed receipt: kept only if it really is this site's signature over this very order.
      const r = body.receipt as Receipt | undefined;
      const receipt = r && auction.site_key && verifyReceipt(auction.site_key, r) && r.auction_id === auction.id && r.commitment === commitment && r.sealed_hash === sealedHash(sealed) ? r : undefined;
      const all = saveTicket({
        auction_id: auction.id,
        bid_id: body.bid_id,
        amount: zat,
        nonce,
        deposit_address: body.deposit_address,
        placed_at: Date.now(),
        delivery_key,
        ...(receipt ? { receipt, site_key: auction.site_key ?? undefined } : {}),
        sealed,
        token_secret,
        closes_at: auction.ends_at,
        ...(hide && hidden !== null ? { send: hidden } : {}),
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

  // Every seat is taken: nobody can place an order any more.
  const seats = seatsLeft(auction);
  if (seats && seats.left === 0) return <SeatsFull auction={auction} what="orders" />;

  // After a first order, keep the form out of the way until it is asked for.
  if (hasOrders && !open) {
    return (
      <p>
        <button type="button" id="another-order" onClick={() => setOpen(true)}>
          Place Another Order
        </button>
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="card" id="order-form">
      <h3>{hasOrders ? "Place Another Order" : "Place A Sealed Order"}</h3>
      <p className="muted small">
        One sealed number, for one unit. If it is among the {auction.batch!.units} highest, you win a unit and pay exactly that. Nobody can open
        it until the sale has closed, and nothing anyone else offers can change what you pay. Want two units? Place two orders.
      </p>
      <label htmlFor="amount">Your Order, For One Unit (TAZ)</label>
      <input id="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={formatCoins(auction.reserve)} />
      <p className={problem ? "hint error" : "hint"}>
        {problem ??
          `At least ${formatCoins(auction.reserve)} TAZ, the lowest price. ${
            bond > 0 ? `You deposit your order plus a bond of ${formatCoins(bond)} TAZ. The bond comes back unless you open a dispute and lose it.` : "You deposit your order."
          }`}
      </p>

      <div className="hide-bid" id="hide-bid">
        <label>
          <input type="checkbox" id="hide-switch" checked={hide} onChange={(e) => setHide(e.target.checked)} /> Hide My Order From This Site.
        </label>
        <p className="hint" id="deposit-plan">
          {exact === null || hidden === null ? (
            "This site sees deposits arrive, so it can work an order out from its deposit. Tick this to send a larger, round amount instead. What you don't owe comes back."
          ) : hide ? (
            <>
              You will deposit <strong>{formatCoins(hidden)} TAZ</strong>, a round amount above your order. The site then knows only that your order
              is no more than {formatCoins(hidden - bond)} TAZ. What you don&apos;t owe comes back when the sale settles.
            </>
          ) : (
            <>
              You will deposit <strong>{formatCoins(exact)} TAZ</strong>
              {bond > 0 ? ", your order plus the bond" : ", your order"}. The chain shows nothing, but this site sees deposits arrive and can work your
              order out from yours. Tick the box to send {formatCoins(hidden)} TAZ instead and keep it from the site too.
            </>
          )}
        </p>
      </div>

      <label htmlFor="refund">Your Shielded Refund Address</label>
      <input id="refund" className="mono" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="utest1…" spellCheck={false} autoComplete="off" />
      <p className="hint">
        {saved && refund === saved ? (
          <>From your connected wallet. Your deposit, or what is left of it, comes back here. Paste a fresh address instead if you prefer.</>
        ) : (
          <>
            A fresh unified address from your testnet wallet. Your deposit, or what is left of it, comes back here.{" "}
            <button type="button" className="link small" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}>
              Connect A Wallet
            </button>{" "}
            to have it filled in.
          </>
        )}
      </p>

      {error && <p className="error">{error}</p>}
      <div className="row" style={{ marginTop: 18 }}>
        <button className="primary lg" id="seal-order" disabled={!ready}>
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" /> Sealing And Locking…
            </>
          ) : (
            "Seal My Order"
          )}
        </button>
      </div>
    </form>
  );
}

function MyOrder({ ticket, view, unknown, auction, note, refresh }: { ticket: Ticket; view?: BidView; /** The site has no order for this ticket. */ unknown: boolean; auction: PublicAuction; note?: string; refresh: () => void }) {
  const deposit = view?.deposit;
  // Where to pay is what the site says it made for this order, never what the
  // ticket says: a ticket can come from a file, and a file can come from anyone.
  const payTo = view?.deposit_address ?? null;
  const funded = (deposit?.total ?? 0) > 0;
  const bond = auction.delivery?.buyer_bond ?? 0;
  const needed = ticket.amount + bond;
  const enough = (deposit?.total ?? 0) >= needed;
  // What to send: the round amount the buyer chose, to hide the order from the site; otherwise what is needed.
  const hiding = !!ticket.send && ticket.send > needed;
  const send = hiding ? ticket.send! : needed;
  const uri = payTo ? paymentRequest(payTo, formatCoins(send)) : "";
  const receipt = ticket.receipt ?? null;

  if (unknown)
    return (
      <div className="card bad" data-bid={ticket.bid_id}>
        <h3>This Ticket Is Not Known Here</h3>
        <p className="small bid-unknown" style={{ margin: 0 }}>
          This browser holds a ticket for an order of {formatCoins(ticket.amount)} TAZ in this sale, but the site has no order that matches it.{" "}
          <strong>Don&apos;t send anything to an address from it.</strong> If it came from a file someone sent you, it is not yours.
        </p>
      </div>
    );

  return (
    <div className={`card ${view?.standing === "won" ? "accent" : ""}`} data-bid={ticket.bid_id}>
      <div className="row spread">
        <h3 style={{ margin: 0 }}>Your Sealed Order</h3>
        <strong className="mono">{formatCoins(ticket.amount)} TAZ</strong>
      </div>

      {auction.state === "open" && !funded && !payTo && (
        <p className="small" style={{ marginTop: 12 }}>
          <span className="spinner" aria-hidden="true" /> Checking this order with the site…
        </p>
      )}
      {auction.state === "open" && !funded && payTo && (
        <>
          <p className="small" style={{ marginTop: 12 }} id="fund-it">
            <strong>Now fund it.</strong> Send <strong>{formatCoins(send)} TAZ</strong> from a shielded balance to the address below, with no memo. It
            was made for this order alone.{" "}
            {hiding ? (
              <>
                That is a round amount above your order, as you chose, so this site can&apos;t work your order out from it. Your order needs{" "}
                {formatCoins(needed)} TAZ{bond > 0 && <> (the order plus the {formatCoins(bond)} TAZ bond)</>}; the rest comes back when the sale settles.
              </>
            ) : (
              <>
                That is your order{bond > 0 && <> plus the {formatCoins(bond)} TAZ bond</>}. A smaller deposit would not count. A larger one is fine:
                what you don&apos;t owe comes back.
              </>
            )}
          </p>
          {auction.seats && auction.state === "open" && (
            <p className="hint seat-hold" id="seat-hold">
              Fund it within {auction.seats.hold_minutes} minutes to keep your seat. After that the seat goes back to the room, but a deposit
              that arrives before the sale closes still counts.
            </p>
          )}
          <div className="row" style={{ alignItems: "flex-start" }}>
            <Qr value={uri} size={150} />
            <div className="grow">
              <div className="addr deposit-address">{payTo}</div>
              <div className="row" style={{ marginTop: 10 }}>
                <PayLink href={uri} />
                <Copy text={payTo} label="Copy Address" />
                <Copy text={uri} label="Copy Payment Request" />
              </div>
              <p className="hint">
                The button opens your Zcash wallet app with this address and {formatCoins(send)} TAZ filled in. No wallet app on this device? Scan
                the code with your phone.
              </p>
            </div>
          </div>
        </>
      )}

      {(auction.state === "open" || auction.state === "revealing" || auction.state === "settling") && send > ticket.amount && (
        <div className="deposit-math" id="deposit-math">
          {hiding ? (
            <>
              <strong>The deposit is not the price.</strong> You deposit {formatCoins(send)} TAZ, more than your order, so this site can&apos;t tell what
              you offered.
            </>
          ) : (
            <>
              <strong>What happens to your {formatCoins(send)} TAZ.</strong> It is your order of {formatCoins(ticket.amount)} TAZ and the {formatCoins(bond)} TAZ bond.
            </>
          )}
          <ul>
            <li>
              If you win a unit, you pay your order, <strong>{formatCoins(ticket.amount)} TAZ</strong>, and{" "}
              <strong>{formatCoins(send - ticket.amount)} TAZ</strong> comes back
              {bond > 0 && send - ticket.amount > bond
                ? ` (${formatCoins(send - ticket.amount - bond)} at the close, the ${formatCoins(bond)} bond after the handover)`
                : bond > 0
                  ? " after the handover (it is the bond)"
                  : ""}
              .
            </li>
            <li>
              If you don&apos;t, all <strong>{formatCoins(send)} TAZ</strong> comes back.
            </li>
          </ul>
          <span className="muted">A small network fee (about 0.00008 TAZ) comes off what is returned.</span>
        </div>
      )}

      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>Deposit</dt>
        <dd className="deposit-status">
          {!deposit ? "checking…" : !funded ? "not seen yet" : `${formatCoins(deposit.total)} TAZ · ${Math.min(deposit.confirmations, deposit.needed)} of ${deposit.needed} confirmations`}
        </dd>
        {funded && deposit && deposit.counted < deposit.total && (
          <>
            <dt>Arrived after the close</dt>
            <dd>{formatCoins(deposit.total - deposit.counted)} TAZ (returned)</dd>
          </>
        )}
        <dt>Order</dt>
        <dd className="reveal-status">
          {view?.revealed
            ? view.opened_by === "beacon"
              ? "opened by the time lock"
              : "opened from your ticket"
            : auction.state === "open"
              ? "sealed and locked in time"
              : auction.state === "revealing"
                ? "opening…"
                : "not opened"}
        </dd>
        <dt>Receipt</dt>
        <dd className="receipt-status">{receipt ? `#${receipt.position} on the board · signed` : "the site gave no valid receipt"}</dd>
        <dt>Refund address</dt>
        <dd>{view?.refund_address ?? "…"}</dd>
      </dl>

      {funded && !enough && auction.state === "open" && (
        <p className="error small" style={{ marginBottom: 0 }}>
          Your deposit is smaller than your order{bond > 0 ? " plus the bond" : ""} ({formatCoins(needed)} TAZ). Send the difference to the same address
          before the sale closes, or this order won&apos;t count.
        </p>
      )}
      {note && <p className="error small">Couldn&apos;t open your order yet: {note}</p>}

      {view?.standing && (
        <div style={{ marginTop: 14 }} className="standing">
          <p style={{ marginBottom: 8 }}>
            <strong className={view.standing === "won" ? "ok" : undefined}>{STANDING[view.standing]}</strong>
            {view.standing === "won" && view.unit && (
              <>
                {" "}
                You pay {formatCoins(view.unit.price)} TAZ, what you offered.
                {(deposit?.total ?? 0) > view.unit.price && <> The rest of your {formatCoins(deposit!.total)} TAZ deposit comes back to you.</>}
              </>
            )}
          </p>
          {view.standing === "won" && view.unit && view.unit.price !== ticket.amount && (
            // The browser's own record of the order is the ticket. The site's word is checked against it, not taken.
            <p className="error small" id="price-mismatch">
              The site says this order pays {formatCoins(view.unit.price)} TAZ, but your ticket says you offered {formatCoins(ticket.amount)} TAZ. That should
              not happen. Keep your ticket and your wallet&apos;s record of the deposit.
            </p>
          )}
          {view.standing === "won" && !view.delivery && (
            <p className="muted small" style={{ margin: 0 }} id="unit-waiting">
              Your price is moving into the escrow made for your unit. The handover starts when it is there.
            </p>
          )}
          {view.delivery && <WinnerDelivery auction={auction} ticket={ticket} view={view} refresh={refresh} />}
          {view.payments.length === 0 && auction.state === "settling" && funded && view.standing !== "won" && (
            <p className="muted small" style={{ margin: 0 }}>
              Your money moves when every deposit has enough confirmations.
            </p>
          )}
          {view.payments.map((p) => (
            <dl className="kv" key={p.txid + p.kind}>
              <dt>{p.kind === "winner-change" ? "Returned above your order" : p.late ? "Late deposit returned" : "Returned to you"}</dt>
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
        Your order opens by itself when the sale closes, even with this browser shut. The ticket is your own record of it: it carries the
        site&apos;s signed receipt, opens the order if the time lock can&apos;t, and unlocks a unit you win.{" "}
        <button type="button" className="link small" id="save-ticket" onClick={() => download(`dark-vault-order-${ticket.bid_id.slice(0, 8)}.txt`, ticketFile(ticket, auction.title))}>
          Save The Ticket File
        </button>
      </p>
    </div>
  );
}

function RestoreTicket({ auctionId, onRestored }: { auctionId: string; onRestored: (all: Ticket[]) => void }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <p className="muted small">
      Ordered from another browser?{" "}
      <label style={{ display: "inline", fontWeight: 500, margin: 0, color: "var(--lime)", cursor: "pointer" }}>
        Restore A Ticket File
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
            if (!ticket) return setMessage("That file isn't a ticket for this sale.");
            setMessage("Ticket restored.");
            onRestored(saveTicket(ticket));
          }}
        />
      </label>
      {message && <> {message}</>}
    </p>
  );
}
