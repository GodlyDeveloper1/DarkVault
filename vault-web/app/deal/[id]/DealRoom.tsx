"use client";

// A private deal (the Settlement market), as its two parties see it.
//
// Two people agreed a price somewhere else. Here they settle it:
//
//   1. The seller writes the terms and the price. The terms are encrypted in
//      the seller's browser; the site stores them unread. The seller funds a
//      bond and sends the buyer one private link.
//   2. The buyer opens the link, reads the terms (opened in their browser with
//      the key in the link) and accepts: the site makes a payment address for
//      them, and they send the price plus their bond, shielded.
//   3. The payment goes into escrow. The handover is the auction's (see
//      ../../auction/[id]/Delivery.tsx): a key, an address or a request passes
//      between the two browsers in sealed envelopes the site can't open.
//   4. The buyer confirms, or their time to complain runs out, and the price
//      is released to the seller. Both bonds go home.
//
// There is no bidding, no board and nothing to prove: the price was fixed
// before either of them came here.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { bidToken, commit, decryptListing, deliveryPublic, formatCoins, manageToken, newDeliveryKey, newId, newNonce, sha256Hex, type ListingText } from "vault-core";
import Countdown from "@/app/components/Countdown";
import PhotoGallery from "@/app/components/PhotoGallery";
import Qr from "@/app/components/Qr";
import { SellerDelivery, WinnerDelivery } from "@/app/auction/[id]/Delivery";
import { headersOf, inviteFor, inviteHeaders } from "@/lib/invites";
import { sellerKeyFor } from "@/lib/sellerKey";
import { loadTickets, parseTicketFile, saveTicket, ticketFile, tokenOf, type Ticket } from "@/lib/tickets";
import { addressProblem, loadWallet, OPEN_EVENT, paymentRequest } from "@/lib/wallet";
import type { BidView, PublicAuction, SellerView } from "@/lib/views";

const clock = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

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

/** Where a deal stands, in a few words. Also used by the dashboard. */
export function dealLabel(a: PublicAuction): { text: string; cls: string } {
  const stage = a.delivery?.stage;
  if (a.state === "funding") return { text: "Not Open Yet", cls: "" };
  if (a.outcome?.cancelled) return { text: "Never Opened", cls: "" };
  if (a.state === "open") return { text: "Open For Payment", cls: "open" };
  if (a.state === "settling") return { text: a.outcome?.sold ? "Paid · Moving To Escrow" : "Offer Ran Out", cls: "settling" };
  if (a.state === "delivering") return a.outcome?.sold ? { text: stage === "disputed" ? "In Dispute" : "In Escrow", cls: "settling" } : { text: "Offer Ran Out", cls: "" };
  if (!a.outcome?.sold) return { text: "Offer Ran Out", cls: "" };
  return stage === "refunded" ? { text: "Deal Undone", cls: "" } : { text: "Settled", cls: "sold" };
}

const STANDING: Record<string, string> = {
  won: "The deal is yours.",
  outbid: "Another payment took this deal first. Yours comes back to you.",
  underfunded: "Your payment did not cover the price and the bond, so it did not take the deal. It comes back to you.",
  "no-deposit": "No payment arrived while the offer stood.",
};

export default function DealRoom({ initial, serverNow }: { initial: PublicAuction; serverNow: number }) {
  const [deal, setDeal] = useState(initial);
  const [offset, setOffset] = useState(0); // server clock minus this browser's clock
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [views, setViews] = useState<Record<string, BidView>>({});
  // Tickets the site has no payment for. (A ticket can come from a file; the site's record is what counts.)
  const [unknown, setUnknown] = useState<Record<string, boolean>>({});
  const [seller, setSeller] = useState<SellerView | null>(null);
  // The seller's key stays in this browser. The site is shown a token made from it.
  const manageKey = useRef<string | null>(null);
  const manageTok = useRef<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const [terms, setTerms] = useState<ListingText | "locked" | null>(null);
  const id = deal.id;

  useEffect(() => {
    setOffset(serverNow - Date.now());
    setTickets(loadTickets(id));
    // The seller's key arrives after the #, which browsers never send to a
    // server. It is kept only once the site confirms it (see lib/sellerKey).
    void sellerKeyFor(id).then((key) => {
      manageKey.current = key;
      setHasKey(key !== null);
      setMounted(true); // the poll below starts again now, with the seller's view
    });
    void inviteFor(id).then(setInvite);
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
    // The record is asked for after the bids, so it is never older than they are:
    // a bid that says "won" is then always shown with the result it won.
    try {
      const res = await fetch(`/api/auctions/${id}`, { headers: await inviteHeaders(id) });
      if (res.ok) {
        const body = await res.json();
        setDeal(body.auction);
        setOffset(body.now - Date.now());
      }
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

  const paidOut = deal.paid === "mined" || deal.paid === "nothing-to-pay";
  useEffect(() => {
    void refresh();
    const every = deal.state === "settled" && paidOut ? 30_000 : 3000;
    const t = setInterval(() => void refresh(), every);
    return () => clearInterval(t);
  }, [refresh, deal.state, paidOut, mounted]);

  // The terms are opened here, with the key from the link. The site never could.
  const sealedTerms = deal.private?.listing ?? null;
  useEffect(() => {
    if (!sealedTerms || !invite) return;
    let stop = false;
    decryptListing(invite, sealedTerms)
      .then((text) => !stop && setTerms(text))
      .catch(() => !stop && setTerms("locked"));
    return () => {
      stop = true;
    };
  }, [sealedTerms, invite]);
  const title = terms && terms !== "locked" ? terms.title : "Private Deal";
  const description = terms && terms !== "locked" ? terms.description : "";
  useEffect(() => {
    if (terms && terms !== "locked") document.title = `${terms.title} · Dark Vault`;
  }, [terms]);

  const price = deal.deal?.price ?? deal.reserve;
  const d = deal.delivery;
  const sellerBond = d?.seller_bond ?? 0;
  const buyerBond = d?.buyer_bond ?? 0;
  const toPay = price + buyerBond;
  const stage = d?.stage;
  const sold = deal.outcome?.sold === true;
  const cancelled = !!deal.outcome?.cancelled;
  const label = dealLabel(deal);
  const steps = ["Agree", "Pay Into Escrow", "Hand Over", "Released"];
  const stepIndex = deal.state === "funding" ? 0 : deal.state === "open" ? 1 : deal.state === "settling" ? 1 : deal.state === "delivering" ? 2 : 3;
  const finished = deal.state === "settled";
  const link = typeof window === "undefined" || !invite ? "" : `${window.location.origin}/deal/${id}#invite=${invite}`;
  const isSeller = !!seller || hasKey;
  // The acceptance that took the deal, if it is this browser's; otherwise the newest one.
  const mineWon = tickets.find((t) => views[t.bid_id]?.standing === "won");
  const shown = mineWon ? [mineWon] : tickets.slice(-1);
  const what = d?.kind === "digital" ? "A file, code or text, unlocked in the buyer's browser." : d?.kind === "promise" ? "Something the seller will do." : "Something the seller will post.";

  return (
    <>
      <div className="room-head">
        <div>
          <span className={`badge ${label.cls}`} id="deal-state">
            {deal.state === "open" && <i className="dot live" />}
            {(deal.state === "settling" || deal.state === "delivering") && <i className="dot amber" />}
            {label.text}
          </span>
          <span className="badge private-tag" style={{ marginLeft: 8 }}>
            Private Deal
          </span>
          <h1 style={{ marginTop: 14 }} id="deal-title">
            {title}
          </h1>
          {description && (
            <p className="muted" style={{ whiteSpace: "pre-wrap", maxWidth: 640 }} id="deal-terms">
              {description}
            </p>
          )}
          <PhotoGallery auctionId={deal.id} count={deal.photos ?? 0} sealed title={title} />
          {terms === "locked" && (
            <p className="error small" id="terms-locked">
              This browser&apos;s link could not open the terms. Open the link you were given again.
            </p>
          )}
        </div>

        <div className="clock" id="deal-clock">
          <span className="muted small">{finished && sold && stage !== "refunded" ? "Settled For" : "The Price"}</span>
          <div className="big">
            <span className="price" id="deal-price">
              {formatCoins(price)} TAZ
            </span>
          </div>
          <span className="muted small" id="deal-clock-line">
            {deal.state === "funding" && <>Not open yet. The deal opens for payment when the seller&apos;s bond of {formatCoins(sellerBond)} TAZ has arrived.</>}
            {deal.state === "open" && (
              <>
                This offer stands for <Countdown to={deal.ends_at} offset={offset} onDone={() => void refresh()} />. The first payment in full takes it.
              </>
            )}
            {deal.state === "settling" && (sold ? "Paid. One shielded transaction is moving the price into escrow." : "Nobody paid while the offer stood. Any payment that did arrive is going back.")}
            {deal.state === "delivering" &&
              (sold
                ? stage === "disputed"
                  ? "The price is held while a dispute is decided."
                  : stage === "released"
                    ? "Handed over. The seller's payment is being sent."
                    : stage === "refunded"
                      ? "Not handed over. The price is going back to the buyer."
                      : "The price is held in escrow until the handover."
                : "Nobody paid while the offer stood. The seller's bond is going back.")}
            {finished &&
              (cancelled
                ? "The seller's bond did not arrive, so the deal never opened."
                : !sold
                  ? "Nobody paid while the offer stood. Nothing was settled."
                  : stage === "refunded"
                    ? "The handover did not happen, so the price went back to the buyer."
                    : paidOut
                      ? "Handed over, and the seller has been paid."
                      : "Handed over. The seller's payment is on its way to a block.")}
          </span>
          {deal.state === "open" && (
            <p className="clock-min" id="deal-to-pay">
              The buyer pays: <strong>{formatCoins(toPay)} TAZ</strong>
              {buyerBond > 0 && (
                <>
                  <br />
                  The price + a {formatCoins(buyerBond)} TAZ bond that comes back
                </>
              )}
            </p>
          )}
          <div className="stats">
            <div>
              <b>{formatCoins(price)}</b>
              <span>price (TAZ)</span>
            </div>
            <div>
              <b>{formatCoins(sellerBond)}</b>
              <span>seller&apos;s bond</span>
            </div>
            <div>
              <b>{formatCoins(buyerBond)}</b>
              <span>buyer&apos;s bond</span>
            </div>
          </div>
        </div>
      </div>

      <ol className="steps" id="deal-steps">
        {steps.map((s, i) => (
          <li key={s} className={i < stepIndex || (finished && sold) ? "done" : i === stepIndex && !finished ? "on" : undefined}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      <div className="card" id="deal-banner">
        <strong style={{ color: "var(--lime)" }}>PRIVATE DEAL.</strong> It is listed nowhere. The terms above were encrypted in the seller&apos;s browser and
        opened here in yours, with the key in your link: this site stores them but can&apos;t read them. The site does run the escrow, so it knows
        the price, the bonds and the time limits, and it sees the payment arrive. On the chain, every payment is shielded.
        {deal.deal?.public_price ? " The seller chose to show the price, and nothing else, on the public ledger: it is added with that day's other deals once this one has completed." : " Nothing about this deal appears on the public ledger."}
      </div>

      {!deal.signer_online && (
        <div className="card bad">
          <strong>The signer is offline.</strong> Payments can&apos;t be seen and nothing can be paid until it is back. Nothing is lost.
        </div>
      )}

      <div className="cols">
        <div>
          {isSeller && seller && (
            <div className="card accent" id="seller-card">
              <h3>You Are The Seller</h3>
              <p className="small muted">
                <strong style={{ color: "var(--amber)" }}>Private view.</strong> This browser holds your seller key. Never share your seller link: anyone who
                has it can act as you. Send the buyer the deal link instead.
              </p>
              {deal.state === "funding" && seller.bond && <BondFunding bond={seller.bond} />}
              {deal.state === "open" && (
                <p className="small" id="seller-waiting-payment">
                  <strong>Your bond is in. Now send the buyer the deal link.</strong> The offer stands until {clock(deal.ends_at)}. When their payment
                  is in a block, the price moves into escrow and this page tells you what to do next.
                </p>
              )}
              {seller.bond && deal.state !== "funding" && !seller.proceeds && !finished && (
                <p className="small muted" id="bond-status">
                  Your bond of {formatCoins(seller.bond.required)} TAZ is held. It comes back with your payment, or when the offer runs out. You lose it
                  to the buyer if you don&apos;t deliver or lose a dispute.
                </p>
              )}
              {deal.state === "settling" && sold && (
                <p className="small" id="seller-paid-in">
                  <span className="spinner" aria-hidden="true" /> The buyer has paid. The price is moving into escrow.
                </p>
              )}
              {seller.proceeds ? (
                <dl className="kv" id="seller-result">
                  <dt>{sold && stage !== "refunded" ? "Sent To You, After Network Fees" : "Your Bond, Returned After The Network Fee"}</dt>
                  <dd>{formatCoins(seller.proceeds.paid)} TAZ</dd>
                  <dt>To</dt>
                  <dd>{seller.payout_address}</dd>
                  <dt>Transaction ({seller.proceeds.status})</dt>
                  <dd>
                    {seller.proceeds.txid.slice(0, 16)}… <Copy text={seller.proceeds.txid} />
                  </dd>
                </dl>
              ) : (
                finished && (
                  <p className="small" id="seller-result" style={{ margin: 0 }}>
                    {cancelled
                      ? "Your bond did not arrive in time, so this deal never opened. If it arrives late, it is sent back to your payout address."
                      : sold
                        ? "Nothing was paid to you."
                        : "Nobody paid, so nothing was settled."}
                  </p>
                )
              )}
              {seller.delivery && manageKey.current && manageTok.current && (
                <SellerDelivery auction={deal} seller={seller} manageKey={manageKey.current} token={manageTok.current} refresh={() => void refresh()} />
              )}
            </div>
          )}

          {!isSeller &&
            shown.map((t) => (
              <MyPayment key={t.bid_id} ticket={t} view={views[t.bid_id]} unknown={!!unknown[t.bid_id]} deal={deal} title={title} toPay={toPay} refresh={() => void refresh()} />
            ))}

          {!isSeller && mounted && deal.state === "open" && tickets.every((t) => unknown[t.bid_id]) && (
            <AcceptForm deal={deal} toPay={toPay} onAccepted={(all) => (setTickets(all), void refresh())} />
          )}
          {!isSeller && mounted && deal.state === "funding" && (
            <div className="card" id="buyer-wait">
              <p style={{ margin: 0 }}>The seller has not funded their bond yet, so the deal is not open for payment. This page updates by itself.</p>
            </div>
          )}
          {!isSeller && mounted && deal.state !== "open" && deal.state !== "funding" && tickets.length === 0 && (
            <div className="card" id="deal-closed">
              <p style={{ margin: 0 }}>
                {sold ? "This deal has been taken." : "This offer has ended."} If you paid from another browser, restore your ticket file to see where
                your payment stands.
              </p>
            </div>
          )}
          {!isSeller && mounted && <RestoreTicket dealId={id} onRestored={(all) => (setTickets(all), void refresh())} />}
        </div>

        <div>
          {isSeller && mounted && !cancelled && (deal.state === "funding" || deal.state === "open") && (
            <div className="card" id="deal-share">
              <h3>Send This To Your Buyer</h3>
              <p className="small muted">
                <strong style={{ color: "var(--amber)" }}>This link is the deal.</strong> Whoever has it can read the terms and pay. Send it only to the
                person you agreed with. It carries no key of yours.
              </p>
              {link ? (
                <>
                  <div className="addr" id="share-link">
                    {link}
                  </div>
                  <div className="row" style={{ marginTop: 10, alignItems: "flex-start" }}>
                    <Qr value={link} size={130} />
                    <div className="grow">
                      <Copy text={link} label="Copy The Deal Link" />
                      <p className="hint">The code holds the same link. The part after the # is the key to the terms; it never reaches this site.</p>
                    </div>
                  </div>
                </>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>
                  Working out the link…
                </p>
              )}
            </div>
          )}

          {sellerBond + buyerBond > 0 && (
            <div className="card" id="deal-stakes">
              <h3>Both Sides Have Something To Lose</h3>
              <div className="stakes">
                <div>
                  <span className="muted small">The Seller&apos;s Bond</span>
                  <b className="mono">{formatCoins(sellerBond)} TAZ</b>
                  <p className="small muted">
                    Paid in before the deal opened. The seller loses it to the buyer if they don&apos;t {d?.kind === "promise" ? "keep the promise" : "hand over"}{" "}
                    in time, or lose a dispute.
                  </p>
                </div>
                <div>
                  <span className="muted small">The Buyer&apos;s Bond</span>
                  <b className="mono">{formatCoins(buyerBond)} TAZ</b>
                  <p className="small muted">
                    Paid with the price. The buyer loses it to the seller if they open a dispute and lose it
                    {d?.kind === "digital" ? "" : d?.kind === "promise" ? ", or never say what they want" : ", or never say where to send it"}.
                  </p>
                </div>
              </div>
              <p className="small" style={{ margin: "12px 0 0" }}>
                A seller and a buyer who both do their part get their bonds back in full.
              </p>
            </div>
          )}

          <div className="card" id="deal-how">
            <h3>How This Deal Settles</h3>
            <p className="muted small" style={{ margin: 0 }}>
              The buyer pays the price{buyerBond > 0 ? " and a bond" : ""} in one shielded payment, to an address made for them alone. Once it is in a
              block, one shielded transaction moves the price into this deal&apos;s escrow. The seller is not paid yet. {what}{" "}
              {d?.kind === "digital"
                ? "It was encrypted in the seller's browser; after the payment the seller's browser sends the key, sealed so only the buyer can open it. If the key doesn't arrive, or doesn't open it, the buyer is refunded."
                : d?.kind === "promise"
                  ? "The buyer tells the seller what they want, sealed so only the seller can read it. If the seller doesn't do it in time, the buyer is refunded."
                  : "The buyer sends shipping details sealed so only the seller can read them. If the seller doesn't ship in time, the buyer is refunded."}{" "}
              When the buyer confirms, or their time to complain runs out, the price is released to the seller. A dispute is decided by the
              operator, who is then given the key to the terms by the buyer&apos;s browser.
            </p>
            {d && (
              <p className="muted small" style={{ margin: "10px 0 0" }} id="deal-limits">
                <strong style={{ color: "var(--text)" }}>Time limits.</strong> {span(d.deliver_seconds)} to hand over, then {span(d.dispute_seconds)} for the buyer to
                open a dispute. The site keeps nothing: each payment carries an equal share of the network fee (about 0.00005 TAZ).
              </p>
            )}
          </div>

          <p className="muted small">
            Every deal that chose to show its price is on the <Link href="/ledger">public ledger</Link>.
          </p>
        </div>
      </div>
    </>
  );
}

/** Shown to the seller while the deal waits for their bond. */
function BondFunding({ bond }: { bond: NonNullable<SellerView["bond"]> }) {
  const uri = paymentRequest(bond.address, formatCoins(bond.required));
  const received = bond.received ?? 0;
  return (
    <div id="bond-funding" style={{ marginBottom: 12 }}>
      <p className="small" style={{ marginBottom: 10 }}>
        <strong>Fund your bond to open the deal.</strong> Send <strong>{formatCoins(bond.required)} TAZ</strong> from a shielded balance to the address
        below, with no memo. The deal opens for payment when it is in a block. You get it back with your payment, or when the offer runs out; you lose
        it to the buyer if you don&apos;t deliver or lose a dispute.
      </p>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Qr value={uri} size={150} />
        <div className="grow">
          <div className="addr" id="bond-address">
            {bond.address}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <a className="btn primary sm pay-link" href={uri}>
              Pay From Wallet
            </a>
            <Copy text={bond.address} label="Copy Address" />
          </div>
          <p className="hint" id="bond-received">
            {received >= bond.required
              ? "Received. Opening the deal…"
              : received > 0
                ? `${formatCoins(received)} TAZ has arrived; ${formatCoins(bond.required - received)} TAZ more is needed.`
                : "Nothing has arrived yet."}{" "}
            If the bond is not here by {clock(bond.wait_until)}, the deal is cancelled.
          </p>
        </div>
      </div>
    </div>
  );
}

/** The buyer accepts: the site makes a payment address for this browser alone. Nothing is paid yet. */
function AcceptForm({ deal, toPay, onAccepted }: { deal: PublicAuction; toPay: number; onAccepted: (all: Ticket[]) => void }) {
  const [refund, setRefund] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const price = deal.deal?.price ?? deal.reserve;
  const bond = deal.delivery?.buyer_bond ?? 0;

  useEffect(() => {
    const saved = loadWallet()?.refund_address;
    if (saved) setRefund(saved);
  }, []);
  const problem = addressProblem(refund);
  const ready = refund.trim().length > 20 && !problem && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      // Made here, in the browser: a secret for this acceptance, and the key the item will be sealed to.
      const nonce = newNonce();
      const token_secret = newId() + newId();
      const delivery_key = newDeliveryKey();
      const invite = await inviteFor(deal.id);
      const res = await fetch(`/api/auctions/${deal.id}/bids`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(invite ? await headersOf(invite) : {}) },
        body: JSON.stringify({
          commitment: await commit(deal.id, price, nonce),
          token_hash: await sha256Hex(await bidToken(token_secret)),
          refund_address: refund.trim(),
          delivery_pub: deliveryPublic(delivery_key),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "the deal could not be accepted");
      onAccepted(
        saveTicket({
          auction_id: deal.id,
          bid_id: body.bid_id,
          amount: price,
          nonce,
          deposit_address: body.deposit_address,
          placed_at: Date.now(),
          delivery_key,
          token_secret,
          closes_at: deal.ends_at,
          ...(invite ? { invite } : {}),
        }),
      );
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(m.charAt(0).toUpperCase() + m.slice(1));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card accent" id="accept-form" onSubmit={submit}>
      <h3>Accept And Pay</h3>
      <p className="small muted">
        Read the terms above. If they are what you agreed, accept: you get a payment address made for you alone. Nothing is paid until you send
        it, and the money goes into escrow, not to the seller.
      </p>
      <div className="deposit-math" id="accept-math">
        <strong>You will send {formatCoins(toPay)} TAZ.</strong>
        <ul>
          <li>
            <strong>{formatCoins(price)} TAZ</strong> is the price. It is held until the handover, then released to the seller.
          </li>
          {bond > 0 && (
            <li>
              <strong>{formatCoins(bond)} TAZ</strong> is your bond. It comes back when the deal completes. You lose it only if you open a dispute and
              lose it.
            </li>
          )}
          <li>If the seller doesn&apos;t hand over in time, all of it comes back{bond > 0 ? ", with the seller's bond on top" : ""}.</li>
        </ul>
      </div>
      <label htmlFor="accept-refund">Your Shielded Refund Address</label>
      <input id="accept-refund" className="mono" value={refund} onChange={(e) => setRefund(e.target.value)} placeholder="utest1…" spellCheck={false} autoComplete="off" />
      <p className={problem ? "hint error" : "hint"}>
        {problem ?? (
          <>
            A fresh unified address from your testnet wallet. Your bond, or a refund, comes back here.{" "}
            <button type="button" className="link small" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}>
              Connect a wallet
            </button>{" "}
            to have it filled in.
          </>
        )}
      </p>
      {error && <p className="error small">{error}</p>}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="primary lg" id="accept-button" disabled={!ready}>
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" /> Making Your Address…
            </>
          ) : (
            "Accept This Deal"
          )}
        </button>
      </div>
    </form>
  );
}

/** The buyer's side once they have accepted: where to pay, where the payment stands, then the handover. */
function MyPayment({
  ticket,
  view,
  unknown,
  deal,
  title,
  toPay,
  refresh,
}: {
  ticket: Ticket;
  view?: BidView;
  /** The site has no payment for this ticket. */
  unknown: boolean;
  deal: PublicAuction;
  title: string;
  toPay: number;
  refresh: () => void;
}) {
  const deposit = view?.deposit;
  // Where to pay is what the site says it made for this payment, never what the
  // ticket says: a ticket can come from a file, and a file can come from anyone.
  const payTo = view?.deposit_address ?? null;
  const funded = (deposit?.total ?? 0) > 0;
  const enough = (deposit?.total ?? 0) >= toPay;
  const bond = deal.delivery?.buyer_bond ?? 0;
  const uri = payTo ? paymentRequest(payTo, formatCoins(toPay)) : "";
  const standing = view?.standing ?? null;

  if (unknown)
    return (
      <div className="card bad" id="pay-card" data-payment={ticket.bid_id}>
        <h3>This Ticket Is Not Known Here</h3>
        <p className="small" style={{ margin: 0 }} id="pay-unknown">
          This browser holds a payment ticket for this deal, but the site has no payment that matches it. <strong>Don&apos;t send anything to an
          address from it.</strong> If it came from a file someone sent you, it is not yours. To pay for this deal, press Accept This Deal below
          {deal.state === "open" ? "." : ", if the offer is still open."}
        </p>
      </div>
    );

  return (
    <div className={`card ${standing === "won" ? "accent" : ""}`} id="pay-card" data-payment={ticket.bid_id}>
      <div className="row spread">
        <h3 style={{ margin: 0 }}>Your Payment</h3>
        <strong className="mono">{formatCoins(toPay)} TAZ</strong>
      </div>

      {deal.state === "open" && !enough && !payTo && (
        <p className="small" style={{ marginTop: 12 }}>
          <span className="spinner" aria-hidden="true" /> Checking this payment with the site…
        </p>
      )}
      {deal.state === "open" && !enough && payTo && (
        <>
          <p className="small" style={{ marginTop: 12 }} id="pay-it">
            <strong>{funded ? "Part of it has arrived." : "Now pay."}</strong> Send{" "}
            <strong>{formatCoins(funded ? toPay - deposit!.total : toPay)} TAZ</strong> from a shielded balance to the address below, with no memo. It
            was made for you alone. That is the price{bond > 0 && <> plus your {formatCoins(bond)} TAZ bond</>}. Less would not take the deal; more is
            fine, and comes back.
          </p>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <Qr value={uri} size={150} />
            <div className="grow">
              <div className="addr deposit-address">{payTo}</div>
              <div className="row" style={{ marginTop: 10 }}>
                <a className="btn primary sm pay-link" href={uri}>
                  Pay From Wallet
                </a>
                <Copy text={payTo} label="Copy Address" />
                <Copy text={uri} label="Copy Payment Request" />
              </div>
              <p className="hint">
                The button opens your Zcash wallet app with this address and {formatCoins(toPay)} TAZ filled in. No wallet app on this device? Scan the
                code with your phone.
              </p>
            </div>
          </div>
        </>
      )}

      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>Payment</dt>
        <dd id="pay-status">
          {!deposit
            ? "checking…"
            : !funded
              ? "not seen yet"
              : `${formatCoins(deposit.total)} TAZ · ${Math.min(deposit.confirmations, deposit.needed)} of ${deposit.needed} confirmations`}
        </dd>
        <dt>Refund Address</dt>
        <dd>{view?.refund_address ?? "…"}</dd>
      </dl>

      {deal.state === "open" && enough && (
        <p className="small" id="pay-arrived" style={{ marginBottom: 0 }}>
          <span className="spinner" aria-hidden="true" /> Your payment has arrived. It takes the deal once it has {deposit?.needed ?? 2} confirmations.
        </p>
      )}

      {standing && (
        <div style={{ marginTop: 14 }} className="standing" id="buyer-result">
          <p style={{ marginBottom: 8 }}>
            <strong className={standing === "won" ? "ok" : undefined}>{STANDING[standing] ?? "This payment did not take the deal. It comes back to you."}</strong>
            {standing === "won" && deal.state === "settling" && <> Your payment is moving into escrow.</>}
          </p>
          {view?.delivery && <WinnerDelivery auction={deal} ticket={ticket} view={view} refresh={refresh} />}
          {view?.payments.map((p) => (
            <dl className="kv" key={p.txid + p.kind}>
              <dt>{p.kind === "winner-change" ? "Returned Above The Price And Bond" : p.late ? "Late Payment Returned" : "Returned To You"}</dt>
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
        This browser holds the only key to this payment{deal.delivery?.kind === "digital" ? " and to the item it buys" : ""}. Keep a copy.{" "}
        <button type="button" className="link small" id="save-ticket" onClick={() => download(`dark-vault-deal-${ticket.bid_id.slice(0, 8)}.txt`, ticketFile(ticket, title, true))}>
          Save The Ticket File
        </button>
      </p>
    </div>
  );
}

function RestoreTicket({ dealId, onRestored }: { dealId: string; onRestored: (all: Ticket[]) => void }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <p className="muted small">
      Paid from another browser?{" "}
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
            const ticket = parseTicketFile(await file.text(), dealId);
            if (!ticket) return setMessage("That file isn't a ticket for this deal.");
            setMessage("Ticket restored.");
            onRestored(saveTicket(ticket));
          }}
        />
      </label>
      {message && <> {message}</>}
    </p>
  );
}
