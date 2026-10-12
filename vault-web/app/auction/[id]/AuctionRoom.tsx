"use client";

// The auction room. Everything a bidder does happens here:
//
//   1. Seal a bid: this browser turns the amount into a commitment, and locks
//      the amount in time (encrypted to a moment after bidding ends). The
//      server is sent the commitment, the locked bid and a refund address,
//      never an amount it can read.
//   2. Deposit: the server answers with an address made for this one bid.
//      A bidder deposits their bid plus the bond, or a larger round amount to
//      keep the bid from the site too. (Auctions listed with a ceiling have
//      same-size deposits instead: everyone deposits the same amount.)
//   3. Unlock: once bidding has closed the time lock opens and the server
//      reads the bids. If the lock can't be opened, this browser opens its own
//      bid from its ticket instead.
//   4. Result: the highest bid wins; one transaction pays the seller and
//      returns every other deposit. The result comes with a proof, which this
//      browser checks (see Verify.tsx).
//   5. Delivery (see Delivery.tsx): when the lot has a delivery, the price is
//      held until the lot has been handed over.
//
// Auctions listed before time-locked bids existed work as they did: a SHA-256
// commitment, a deposit that covers the bid, and a reveal from this browser.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  hidingDeposit,
  bidToken,
  commit,
  decryptListing,
  deliveryPublic,
  formatCoins,
  isPublicBeacon,
  manageToken,
  newId,
  MIN_BID,
  newBlinding,
  newDeliveryKey,
  newNonce,
  parseCoins,
  pedersenCommit,
  roundAfter,
  roundTimeMs,
  sealBid,
  sealedHash,
  sha256Hex,
  trustedChain,
  verifyReceipt,
  type ListingText,
  type Receipt,
} from "vault-core";
import Countdown from "@/app/components/Countdown";
import PhotoGallery from "@/app/components/PhotoGallery";
import Qr from "@/app/components/Qr";
import PayLink from "@/app/components/PayLink";
import { SeatsFull, seatsLeft, SeatsStat, stateLabel } from "@/app/components/AuctionTile";
import { loadTickets, mayOpenByHand, parseTicketFile, saveTicket, ticketFile, tokenOf, WALLET_EVENT, type Ticket } from "@/lib/tickets";
import { inviteFor, inviteHeaders, shareLink } from "@/lib/invites";
import { sellerKeyFor } from "@/lib/sellerKey";
import { makePracticeWallet, practiceToken, practiceWallet } from "@/lib/practiceClient";
import { loadWallet, OPEN_EVENT, paymentRequest } from "@/lib/wallet";
import type { WalletView } from "@/lib/house/practice";
import type { BidView, PublicAuction, SellerView } from "@/lib/views";
import { SellerDelivery, WinnerDelivery } from "./Delivery";
import VerifyResult from "./Verify";

const STANDING: Record<string, string> = {
  won: "You won.",
  outbid: "Another bid was higher. Your deposit comes back to you.",
  "below-reserve": "Your bid was below the reserve. Your deposit comes back to you.",
  "not-revealed": "Your bid was not revealed in time, so it did not count. Your deposit comes back to you.",
  underfunded: "Your deposit did not cover your bid (and the bond, if this auction has one), so the bid did not count. Your deposit comes back to you.",
  "no-deposit": "No deposit arrived before bidding closed, so this bid did not count.",
};

/** The same, for auctions with time-locked bids. */
const STANDING_OPEN: Record<string, string> = {
  ...STANDING,
  "not-revealed": "Your bid could not be opened, so it did not count. Your deposit comes back to you.",
  underfunded: "Your deposit did not cover your bid and the bond, so the bid did not count. Your deposit comes back to you.",
};

/** And for those of them with same-size deposits. */
const STANDING_2: Record<string, string> = {
  ...STANDING,
  "not-revealed": "Your bid could not be opened, so it did not count. Your deposit comes back to you.",
  underfunded: "Your deposit was smaller than the amount every bid must deposit, so the bid did not count. Your deposit comes back to you.",
  "over-ceiling": "Your bid was above the highest bid this auction allows, so it did not count. Your deposit comes back to you.",
};

const BOARD: Record<string, string> = { counted: "counted", "no-deposit": "no deposit", underfunded: "short deposit", unopened: "not opened" };

/** How long this browser waits for the time lock to open its bid before opening it from the ticket. */
const UNLOCK_PATIENCE_MS = 20_000;

const clockTime = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

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
  // Tickets the site has no bid for. (A ticket can come from a file; the site's record is what counts.)
  const [unknown, setUnknown] = useState<Record<string, boolean>>({});
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
  // A private auction: the invite this browser holds, and the listing it opened with it.
  const [invite, setInvite] = useState<string | null>(null);
  const [listing, setListing] = useState<ListingText | "locked" | null>(null);
  const id = auction.id;

  useEffect(() => {
    setOffset(serverNow - Date.now());
    setTickets(loadTickets(id));
    // The seller's key arrives in the link's #fragment, which browsers never
    // send to a server. It is kept only once the site confirms it is this
    // auction's key, and is then taken out of the address bar (see lib/sellerKey).
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
        setAuction(body.auction);
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

  // Poll: quickly while something is about to change, slowly once it is over.
  useEffect(() => {
    void refresh();
    const paid = auction.paid === "mined" || auction.paid === "nothing-to-pay";
    const every = auction.state === "settled" && paid ? 30_000 : auction.state === "open" ? 5000 : 3000;
    const t = setInterval(() => void refresh(), every);
    return () => clearInterval(t);
  }, [refresh, auction.state, auction.paid, mounted]);

  // Reveal: once bidding has closed, open each of this browser's bids.
  // With time-locked bids the server opens them itself; this is then the
  // fallback, used only for a bid the lock has not opened after a short wait.
  useEffect(() => {
    if (auction.state !== "revealing") return;
    const closedAt = (auction.reveal_ends_at ?? 0) - auction.reveal_seconds * 1000;
    for (const t of tickets) {
      const v = views[t.bid_id];
      if (v?.revealed || revealing.current.has(t.bid_id)) continue;
      // Everything else here is the site's word. This is the browser's own
      // check: a bid is never opened by hand before its own lock, or the
      // closing time it was placed under, has passed by this browser's clock.
      if (!mayOpenByHand(t, auction.timelock?.chain)) continue;
      if (auction.scheme === 2) {
        if (!v) continue; // not known yet whether the lock has opened it
        // A bid that can't count has no reason to tell the site its amount.
        if (v.deposit && v.deposit.counted < (auction.deposit_required ?? t.amount + (auction.delivery?.buyer_bond ?? 0))) continue;
        if (!v.unopenable && Date.now() + offset < closedAt + UNLOCK_PATIENCE_MS) continue;
      }
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
  }, [auction.state, auction.scheme, auction.deposit_required, auction.reveal_ends_at, auction.reveal_seconds, offset, tickets, views, id, refresh]);

  // A private auction's title and description are opened here, with the key from the invite link. The site never could.
  const sealedListing = auction.private?.listing ?? null;
  useEffect(() => {
    if (!sealedListing) return setListing(null);
    if (!invite) return;
    let stop = false;
    decryptListing(invite, sealedListing)
      .then((text) => !stop && setListing(text))
      .catch(() => !stop && setListing("locked"));
    return () => {
      stop = true;
    };
  }, [sealedListing, invite]);
  const isPrivate = !!auction.private;
  const title = isPrivate ? (listing && listing !== "locked" ? listing.title : "Private auction") : auction.title;
  const description = isPrivate ? (listing && listing !== "locked" ? listing.description : "") : auction.description;
  useEffect(() => {
    if (isPrivate && listing && listing !== "locked") document.title = `${listing.title} · Dark Vault`;
  }, [isPrivate, listing]);
  const share = typeof window === "undefined" ? "" : shareLink(window.location.origin, id, isPrivate ? invite : null);

  const label = stateLabel(auction);
  const hasDelivery = !!auction.delivery;
  const s2 = auction.scheme === 2;
  const lock = auction.timelock;
  // Checked here against the key built into this page, not taken from the server's word.
  const testBeacon = !!lock && !isPublicBeacon(lock.chain);
  const unlock = s2 ? "Unlock" : "Reveal";
  const steps = hasDelivery ? ["Sealed bids", unlock, "Settle", "Deliver", "Paid"] : ["Sealed bids", unlock, "Settle", "Paid"];
  const stepIndex = { funding: -1, open: 0, revealing: 1, settling: 2, delivering: 3, settled: steps.length - 1 }[auction.state];
  const sellerBond = auction.delivery?.seller_bond ?? 0;
  const buyerBond = auction.delivery?.buyer_bond ?? 0;
  const cancelled = !!auction.outcome?.cancelled;
  // This browser's own bids on the board.
  const mine = new Set<string>();
  if (s2)
    for (const t of tickets) {
      try {
        mine.add(pedersenCommit(id, t.amount, t.nonce));
      } catch {
        /* not a ticket for this kind of auction */
      }
    }
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
          {isPrivate && (
            <span className="badge private-tag" id="private-badge" style={{ marginLeft: 8 }}>
              Private
            </span>
          )}
          <h1 style={{ marginTop: 14 }} id="auction-title">
            {title}
          </h1>
          {description && (
            <p className="muted" style={{ whiteSpace: "pre-wrap", maxWidth: 640 }} id="auction-description">
              {description}
            </p>
          )}
          <PhotoGallery auctionId={auction.id} count={auction.photos ?? 0} sealed={isPrivate} title={title} />
          {listing === "locked" && (
            <p className="error small" id="listing-locked">
              This browser&apos;s invite could not open the listing. Open the invite link the seller gave you again.
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
              <p className="clock-min">
                Lowest bid that can win: <strong>{formatCoins(auction.reserve)} TAZ</strong>
              </p>
            </>
          )}
          {auction.state === "open" && (
            <>
              <span className="muted small">Bidding closes in</span>
              <div className="big">
                <Countdown to={auction.ends_at} offset={offset} onDone={() => void refresh()} />
              </div>
              <span className="muted small">
                {s2 ? "Bids are locked in time until then. Nobody can open one early, this site included." : "Bids stay sealed until then."}
              </span>
              <p className="clock-min" id="clock-min">
                Lowest bid that can win: <strong>{formatCoins(auction.reserve)} TAZ</strong>
                {s2 && auction.deposit_required != null && (
                  <>
                    <br />
                    Every bidder deposits: <strong>{formatCoins(auction.deposit_required)} TAZ</strong>
                  </>
                )}
                {s2 && auction.deposit_required == null && (
                  <>
                    <br />
                    You deposit:{" "}
                    <strong>
                      your bid{(auction.delivery?.buyer_bond ?? 0) > 0 ? ` + ${formatCoins(auction.delivery!.buyer_bond)} TAZ bond` : ""}
                    </strong>
                  </>
                )}
              </p>
            </>
          )}
          {auction.state === "revealing" && s2 && (
            <>
              <span className="muted small">Bidding is closed</span>
              <div className="big" id="unlocking">
                Opening bids…
              </div>
              <span className="muted small">
                {lock?.beacon ? "The time lock has opened." : "Waiting for the time lock to open."} {auction.revealed} of {auction.funded ?? auction.bids} funded
                bids opened. A bid the lock can&apos;t open can be opened by its bidder for another{" "}
                <Countdown to={auction.reveal_ends_at ?? 0} offset={offset} onDone={() => void refresh()} />.
              </span>
            </>
          )}
          {auction.state === "revealing" && !s2 && (
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
                    : s2 || auction.outcome?.counted === 0
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
            <SeatsStat auction={auction} />
            <div>
              <b>{formatCoins(auction.reserve)}</b>
              <span>reserve (TAZ)</span>
            </div>
            {auction.ceiling != null && (
              <div>
                <b id="stat-ceiling">{formatCoins(auction.ceiling)}</b>
                <span>highest bid (TAZ)</span>
              </div>
            )}
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
          <strong style={{ color: "var(--amber)" }}>TEST BEACON.</strong> This auction&apos;s bids are locked to a stand-in, not the public drand network.
          A stand-in can be made to open early, so it locks nothing. For testing only: do not bid real value here.
        </div>
      )}

      {auction.practice && (
        <div className="card warn" id="practice-banner">
          <strong style={{ color: "var(--amber)" }}>PRACTICE AUCTION.</strong> The seller and {auction.practice.bots} of the bidders (marked
          &ldquo;house&rdquo; on the board) are run by this site, automatically, so that you have someone to bid against. Their bids are
          sealed and locked in time like yours, they can&apos;t see what you bid, and they never bid above {formatCoins(auction.practice.bot_max)} TAZ. Everything else is the real
          thing: shielded deposits on the Zcash testnet, a time-locked bid, a proof of the result. The coins have no value.
        </div>
      )}

      {isPrivate && (
        <div className="card" id="private-banner">
          <strong style={{ color: "var(--lime)" }}>PRIVATE AUCTION.</strong> It is not listed anywhere. The title and description were encrypted in the
          seller&apos;s browser and opened here in yours, with the key in your invite link: this site stores them but can&apos;t read them. Only
          people who hold the invite can see this page or bid. The site still runs the auction, so it knows the reserve, the times and how
          many bids there are. If a winner opens a dispute, their browser gives the operator the key to the description so it can be judged.
        </div>
      )}

      {auction.delivery && (sellerBond > 0 || buyerBond > 0 || auction.practice) && (
        <div className="card" id="stakes">
          <h3 style={{ marginTop: 0 }}>{sellerBond > 0 || buyerBond > 0 ? "Both sides have something to lose" : "Bonds: none in a practice auction"}</h3>
          {sellerBond > 0 || buyerBond > 0 ? (
            <>
              <div className="stakes">
                <div>
                  <span className="muted small">The seller&apos;s bond</span>
                  <b className="mono" id="stake-seller">{formatCoins(sellerBond)} TAZ</b>
                  <p className="small muted">
                    Paid in before bidding opened. The seller loses it to the winner if they don&apos;t{" "}
                    {auction.delivery.kind === "promise" ? "keep the promise" : "hand the lot over"} in time, or lose a dispute.
                  </p>
                </div>
                <div>
                  <span className="muted small">Every bidder&apos;s bond</span>
                  <b className="mono" id="stake-buyer">{formatCoins(buyerBond)} TAZ</b>
                  <p className="small muted">
                    Part of every deposit. Everyone who doesn&apos;t win gets it straight back. The winner loses it to the seller if they open a
                    dispute and lose it{auction.delivery.kind === "digital" ? "" : auction.delivery.kind === "promise" ? ", or never say what they want" : ", or never say where to send the lot"}.
                  </p>
                </div>
              </div>
              <p className="small" style={{ margin: "12px 0 0" }}>
                A seller and a winner who both do their part get their bonds back in full.
              </p>
            </>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              Here the seller is this site, so nobody puts down a bond.{" "}
              {auction.delivery.usual_bond_percent > 0 ? (
                <>
                  In a real auction both sides do: the seller pays in {auction.delivery.usual_bond_percent}% of the reserve before bidding
                  opens, and every bid carries the same amount on top. A seller who doesn&apos;t deliver, or loses a dispute, loses their bond to
                  the winner. A winner who opens a dispute and loses it loses theirs to the seller. Honest parties get theirs back.
                </>
              ) : (
                <>In a real auction the price is still held until the lot is handed over, and a dispute is decided by the operator.</>
              )}
            </p>
          )}
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
              <h3>You are the seller</h3>
              <p className="small muted" id="seller-private">
                <strong style={{ color: "var(--amber)" }}>Private view.</strong> This browser holds your seller key. Never share your seller link:
                anyone who has it can act as the seller. Give bidders the {isPrivate ? "invite link" : "public link"} instead.{" "}
                <Copy text={share} label={isPrivate ? "Copy the invite link" : "Copy the public link"} />
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
            <MyBid key={t.bid_id} ticket={t} view={views[t.bid_id]} unknown={!!unknown[t.bid_id]} auction={auction} title={title} note={revealNote[t.bid_id]} refresh={() => void refresh()} />
          ))}

          {/* The seller's view offers no bid form: a seller doesn't bid on their own lot. */}
          {auction.state === "open" && mounted && !seller && !hasKey && <BidForm auction={auction} onPlaced={(all) => (setTickets(all), void refresh())} hasBids={tickets.length > 0} />}
          {auction.state === "open" && seller && (
            <p className="muted small" id="seller-no-bid">
              Bidding is switched off in your seller view. Bidders use the {isPrivate ? "invite link" : "public link"}.
            </p>
          )}

          {auction.state !== "open" && tickets.length === 0 && !seller && (
            <div className="card">
              <p style={{ margin: 0 }}>
                Bidding is closed. If you bid from another browser, restore your bid from its ticket file to {s2 ? "" : "reveal it and "}see
                your result.
              </p>
            </div>
          )}

          <RestoreTicket auctionId={id} onRestored={(all) => (setTickets(all), void refresh())} />
        </div>

        <div>
          {mounted && !cancelled && <ShareCard link={share} isPrivate={isPrivate} ready={!isPrivate || !!invite} open={auction.state === "open" || auction.state === "funding"} />}
          {s2 && <VerifyResult auction={auction} tickets={tickets} />}
          <div className="card">
            <h3>The board</h3>
            <p className="muted small">
              Every sealed bid, as the commitment the bidder&apos;s browser made. It hides the amount and can&apos;t be changed afterwards.
              {auction.board && " Next to each: whether it counted in the result."}
            </p>
            {auction.commitments.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                No bids yet.
              </p>
            ) : (
              <ol className="board" id="board">
                {auction.commitments.map((c, i) => {
                  const won = auction.outcome?.winner_position === i + 1;
                  const status = auction.board?.[i];
                  return (
                    <li key={c} className={mine.has(c) ? "mine" : undefined}>
                      <b>#{i + 1}</b>
                      <span>{c}</span>
                      {auction.practice?.house_positions.includes(i + 1) && <em className="house">house</em>}
                      {status && <em className={won ? "won" : status === "counted" ? undefined : "out"}>{won ? "won" : BOARD[status]}</em>}
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
          {s2 && lock && (
            <div className="card" id="timelock-card">
              <h3>The time lock</h3>
              <p className="muted small" style={{ margin: 0 }}>
                Each bid is encrypted, in the bidder&apos;s browser, to round <span className="mono">{lock.round}</span> of{" "}
                {testBeacon ? "a test beacon" : "the drand network (the League of Entropy, about twenty independent organisations)"}. That round
                is signed at <span className="mono">{clockTime(lock.opens_at)}</span>, just after bidding ends, and its signature is the only
                key. {lock.beacon ? "It has been signed, and the bids were opened with it." : "Until then it does not exist, so no bid can be opened: not by this site, not by anyone."}
              </p>
            </div>
          )}
          <div className="card">
            <h3>How this auction works</h3>
            {s2 ? (
              <p className="muted small" style={{ margin: 0 }} id="how-it-works">
                Each bid is sealed in the bidder&apos;s browser and locked in time.{" "}
                {auction.deposit_required != null ? (
                  <>
                    Every bidder deposits the same amount, {formatCoins(auction.deposit_required)} TAZ, in a shielded payment, so a deposit says
                    nothing about the bid behind it.
                  </>
                ) : (
                  <>
                    A bidder deposits their bid{(auction.delivery?.buyer_bond ?? 0) > 0 ? " plus the bond" : ""} in a shielded payment, so the chain
                    shows nothing. This site does see deposits arrive, so a bidder who wants to keep the amount from the site too sends a larger,
                    round amount and gets the rest back.
                  </>
                )}{" "}
                When bidding closes the lock opens. The highest bid at or above the reserve wins and pays exactly what it bid; of two equal bids,
                the one placed first. The site then publishes a proof that the highest bid won, which your browser checks, and the losing
                bids are never shown. One shielded transaction returns every other deposit and{" "}
                {auction.delivery ? "sets the price aside for the seller" : "pays the seller"}, so the site keeps nothing. Each payment carries
                an equal share of the network fee (about 0.00005 TAZ).
              </p>
            ) : (
              <p className="muted small" style={{ margin: 0 }}>
                Bids are sealed and funded by a shielded deposit. When bidding closes, bidders reveal. The highest bid at or above the
                reserve wins and pays exactly what it bid. One shielded transaction then returns every other deposit and{" "}
                {auction.delivery ? "sets the price aside for the seller" : "pays the seller"}, so the site keeps nothing. Each payment carries an
                equal share of the network fee (about 0.00005 TAZ).
              </p>
            )}
            {auction.delivery && (
              <p className="muted small" style={{ margin: "10px 0 0" }} id="delivery-terms">
                <strong style={{ color: "var(--text)" }}>{auction.delivery.kind === "digital" ? "Digital lot." : auction.delivery.kind === "promise" ? "A promise." : "Physical lot."}</strong> The
                seller is not paid at the close: the price is held until {auction.delivery.kind === "promise" ? "the promise is kept" : "the lot is handed over"}.{" "}
                {auction.delivery.kind === "digital"
                  ? auction.practice
                    ? "Here the seller is this site: it encrypted the lot itself and, after the sale, sends the key sealed so only the winner can open it. In a real auction the seller's browser does both, and the site can't read the lot."
                    : "The lot was encrypted in the seller's browser. After the sale the seller's browser sends the key, sealed so only the winner can open it. If the key doesn't arrive, or doesn't open the lot, the winner is refunded."
                  : auction.delivery.kind === "promise"
                    ? "The winner tells the seller what they want, sealed so only the seller can read it. If the seller doesn't do it in time, the winner is refunded; a dispute is decided by the operator."
                    : "The winner sends shipping details sealed so only the seller can read them. If the seller doesn't ship in time, the winner is refunded; a dispute is decided by the operator."}{" "}
                Time limits: {span(auction.delivery.deliver_seconds)} to hand over, then {span(auction.delivery.dispute_seconds)} for the winner to open a dispute.
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

/** The link to hand to bidders, as text and as a QR code. Drawn here in the browser: the link is sent nowhere. */
function ShareCard({ link, isPrivate, ready, open }: { link: string; isPrivate: boolean; ready: boolean; open: boolean }) {
  const [qr, setQr] = useState(false);
  return (
    <div className="card" id="share-card">
      <h3>{isPrivate ? "Invite someone" : "Share this auction"}</h3>
      {isPrivate ? (
        <p className="small muted" id="share-warning">
          <strong style={{ color: "var(--amber)" }}>This link is the invite.</strong> Anyone who has it can see what is being sold and bid, and can pass
          it on. Send it only to the people you want here. It carries no bid and no wallet: yours stay in this browser.
        </p>
      ) : (
        <p className="small muted">
          {open ? "Anyone with this link can bid." : "Anyone with this link can see the result and check its proof."} It carries nothing of yours: your
          bids and tickets stay in this browser.
        </p>
      )}
      {ready ? (
        <>
          <div className="addr" id="share-link">
            {link}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <Copy text={link} label={isPrivate ? "Copy the invite link" : "Copy the link"} />
            <button type="button" className="link small" id="share-qr-toggle" onClick={() => setQr((q) => !q)}>
              {qr ? "Hide the QR code" : "Show a QR code"}
            </button>
          </div>
          {qr && (
            <div style={{ marginTop: 12 }} id="share-qr">
              <Qr value={link} size={190} />
              <p className="hint">Scan it with a phone camera to open this auction there.</p>
            </div>
          )}
        </>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          This browser doesn&apos;t hold the invite, so it has no link to share.
        </p>
      )}
    </div>
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
            <PayLink href={uri} />
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
  // Practice auctions: a practice wallet can stand in for the bidder's own.
  const [pw, setPw] = useState<WalletView | null>(null);
  const [ownWallet, setOwnWallet] = useState(false);
  const [making, setMaking] = useState(false);
  const isPractice = !!auction.practice;
  useEffect(() => {
    if (!isPractice) return;
    const load = () => void practiceWallet().then(setPw).catch(() => {});
    load();
    window.addEventListener(WALLET_EVENT, load);
    return () => window.removeEventListener(WALLET_EVENT, load);
  }, [isPractice]);
  const withPractice = isPractice && !!pw && !ownWallet;
  const bond = auction.delivery?.buyer_bond ?? 0;
  /** An auction with same-size deposits: everyone deposits this, whatever they bid. Null where a deposit is the bid plus the bond. */
  const fixed = auction.deposit_required;
  /** What a practice wallet's ready-made deposit covers. */
  const practiceCover = auction.practice?.wallet_deposit ?? 0;
  const required = fixed ?? (withPractice ? practiceCover : 0);
  // Ticked: deposit a round amount above the bid, so the site can't work the bid out from the deposit.
  const [hide, setHide] = useState(false);

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
          ? `A bid below the reserve (${formatCoins(auction.reserve)} TAZ) can't win.`
          : auction.ceiling != null && zat > auction.ceiling
            ? `The highest bid this auction allows is ${formatCoins(auction.ceiling)} TAZ.`
            : fixed == null && withPractice && zat > practiceCover
              ? `A practice wallet's deposit covers a bid of up to ${formatCoins(practiceCover)} TAZ. Bid less, or use your own wallet.`
              : null;
  // What this bid will deposit: its own amount and the bond, or the round amount above it.
  const exact = zat !== null && !problem ? zat + bond : null;
  const hidden = zat !== null && !problem ? hidingDeposit(auction.reserve, zat) + bond : null;
  const canHide = fixed == null && auction.scheme === 2 && !withPractice;
  const short = withPractice && pw!.balance < required;
  const ready = zat !== null && !problem && (withPractice ? !short && pw!.bids_left > 0 : refund.trim().length > 20) && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || zat === null) return;
    setBusy(true);
    setError(null);
    try {
      // All of this happens here, in the browser. Only the commitment, the
      // time-locked bid, the hash of a token and the refund address are sent.
      let nonce: string;
      let commitment: string;
      let sealed: string | undefined;
      if (auction.scheme === 2) {
        const lock = auction.timelock;
        if (!lock) throw new Error("this auction has no time lock yet. Reload the page and try again.");
        // Checked here, not taken on trust. For the public network, its key
        // and its clock are the constants built into this page; the lock must
        // open after bidding ends, and must not have opened already.
        const chain = trustedChain(lock.chain);
        if (lock.round < roundAfter(chain, auction.ends_at) || roundTimeMs(chain, lock.round) <= Date.now())
          throw new Error("this auction's time lock would open before bidding ends. Don't bid here.");
        nonce = newBlinding();
        commitment = pedersenCommit(auction.id, zat, nonce);
        sealed = await sealBid(chain, lock.round, zat, nonce);
      } else {
        nonce = newNonce();
        commitment = await commit(auction.id, zat, nonce);
      }
      // The access token has a secret of its own: the winner's nonce is published with the proof.
      const token_secret = newId() + newId();
      const token_hash = await sha256Hex(await bidToken(token_secret));
      // If this bid wins, the lot is sealed to this key. The private half stays in the ticket.
      const delivery_key = auction.delivery ? newDeliveryKey() : undefined;
      const invite = auction.private ? await inviteFor(auction.id) : null;
      const res = await fetch(`/api/auctions/${auction.id}/bids`, {
        method: "POST",
        // A private auction takes bids only from browsers that hold its invite.
        headers: { "Content-Type": "application/json", ...(await inviteHeaders(auction.id)) },
        body: JSON.stringify({
          commitment,
          token_hash,
          // With a practice wallet the site's house purse receives the refund, for that wallet.
          ...(withPractice ? { practice: practiceToken() } : { refund_address: refund.trim() }),
          ...(sealed ? { sealed } : {}),
          ...(delivery_key ? { delivery_pub: deliveryPublic(delivery_key) } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "the bid was refused");
      // The site's signed receipt: kept only if it really is this site's signature over this very bid.
      const r = body.receipt as Receipt | undefined;
      const receipt =
        sealed && r && auction.site_key && verifyReceipt(auction.site_key, r) && r.auction_id === auction.id && r.commitment === commitment && r.sealed_hash === sealedHash(sealed)
          ? r
          : undefined;
      const all = saveTicket({
        auction_id: auction.id,
        bid_id: body.bid_id,
        amount: zat,
        nonce,
        deposit_address: body.deposit_address,
        placed_at: Date.now(),
        ...(delivery_key ? { delivery_key } : {}),
        ...(receipt ? { receipt, site_key: auction.site_key ?? undefined } : {}),
        ...(sealed ? { sealed } : {}),
        token_secret,
        closes_at: auction.ends_at,
        ...(withPractice ? { practice: true } : {}),
        ...(canHide && hide && hidden !== null ? { send: hidden } : {}),
        ...(auction.private && invite ? { invite } : {}),
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

  // Every seat is taken: nobody can bid any more.
  const seats = seatsLeft(auction);
  if (seats && seats.left === 0) return <SeatsFull auction={auction} what="bids" />;

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
        One sealed number. If it is the highest, you win and pay exactly that. {auction.scheme === 2 ? "Nobody can open it" : "Nobody sees it"} until
        bidding has closed, and nothing anyone else bids can change what you pay.
      </p>
      <label htmlFor="amount">Your bid (TAZ)</label>
      <input id="amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={formatCoins(auction.reserve)} />
      <p className={problem ? "hint error" : "hint"}>
        {problem ??
          (fixed != null
            ? `Between ${formatCoins(auction.reserve)} and ${formatCoins(auction.ceiling ?? 0)} TAZ. Whatever you bid, you deposit ${formatCoins(fixed)} TAZ, the same as every bidder${
                auction.delivery && auction.delivery.buyer_bond > 0 ? ` (it includes a bond of ${formatCoins(auction.delivery.buyer_bond)} TAZ, which comes back unless you open a dispute and lose it)` : ""
              }. What you don't owe comes back.`
            : auction.scheme === 2
              ? `At least ${formatCoins(auction.reserve)} TAZ, the reserve. ${
                  withPractice
                    ? "Your practice wallet pays the deposit."
                    : bond > 0
                      ? `You deposit your bid plus a bond of ${formatCoins(bond)} TAZ. The bond comes back unless you open a dispute and lose it.`
                      : "You deposit your bid."
                }`
            : auction.delivery && auction.delivery.buyer_bond > 0
              ? `Stays in this browser until bidding closes. You will deposit your bid plus a bond of ${formatCoins(auction.delivery.buyer_bond)} TAZ, which comes back unless you open a dispute and lose it.`
              : "Stays in this browser until bidding closes.")}
      </p>

      {canHide && (
        <div className="hide-bid" id="hide-bid">
          <label>
            <input type="checkbox" id="hide-switch" checked={hide} onChange={(e) => setHide(e.target.checked)} /> Hide My Bid From This Site.
          </label>
          <p className="hint" id="deposit-plan">
            {exact === null || hidden === null ? (
              "This site sees deposits arrive, so it can work a bid out from its deposit. Tick this to send a larger, round amount instead. What you don't owe comes back."
            ) : hide ? (
              <>
                You will deposit <strong>{formatCoins(hidden)} TAZ</strong>, a round amount above your bid. The site then knows only that your bid is
                no more than {formatCoins(hidden - bond)} TAZ. What you don&apos;t owe comes back when the auction settles.
              </>
            ) : (
              <>
                You will deposit <strong>{formatCoins(exact)} TAZ</strong>
                {bond > 0 ? ", your bid plus the bond" : ", your bid"}. The chain shows nothing, but this site sees deposits arrive and can work
                your bid out from yours. Tick the box to send {formatCoins(hidden)} TAZ instead and keep it from the site too.
              </>
            )}
          </p>
        </div>
      )}

      {isPractice && !pw && (
        <div id="practice-offer" style={{ margin: "14px 0 4px" }}>
          <p className="small" style={{ marginBottom: 8 }}>
            <strong>No testnet coins?</strong> A practice wallet gives you testnet coins to bid with in practice auctions, enough for three
            bids at once. The site holds it for you, so it is for practice only.
          </p>
          <button
            type="button"
            id="practice-make"
            disabled={making}
            onClick={async () => {
              setMaking(true);
              setError(null);
              try {
                setPw(await makePracticeWallet());
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setMaking(false);
              }
            }}
          >
            {making ? "Making it…" : "Get a practice wallet"}
          </button>
          <p className="hint">Or bid with your own wallet: give a refund address below.</p>
        </div>
      )}
      {isPractice && pw && (
        <>
          <label>Pay the deposit with</label>
          <div className="pay-with" id="pay-with">
            <label className={!ownWallet ? "on" : undefined}>
              <input type="radio" name="pay-with" checked={!ownWallet} onChange={() => setOwnWallet(false)} /> Practice wallet ·{" "}
              <span className="mono">{formatCoins(pw.balance)} TAZ</span>
            </label>
            <label className={ownWallet ? "on" : undefined}>
              <input type="radio" name="pay-with" checked={ownWallet} onChange={() => setOwnWallet(true)} /> My own wallet
            </label>
          </div>
          {withPractice && (
            <p className={short || pw.bids_left <= 0 ? "hint error" : "hint"} id="practice-hint">
              {pw.bids_left <= 0
                ? "This practice wallet has funded all the bids it can. Use your own wallet."
                : short
                  ? `Your practice wallet holds ${formatCoins(pw.balance)} TAZ, less than the ${formatCoins(required)} TAZ a deposit takes. Deposits come back when their auctions settle.`
                  : "The site's house purse pays your deposit and gets the refund, on your practice wallet's account. The site can tell which practice bids are yours."}
            </p>
          )}
        </>
      )}

      {!withPractice && (
        <>
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
        </>
      )}

      {error && <p className="error">{error}</p>}
      <div className="row" style={{ marginTop: 18 }}>
        <button className="primary lg" disabled={!ready}>
          {busy ? (
            <>
              <span className="spinner" aria-hidden="true" /> {auction.scheme === 2 ? "Sealing and locking…" : "Sealing…"}
            </>
          ) : (
            "Seal my bid"
          )}
        </button>
      </div>
    </form>
  );
}

function MyBid({
  ticket,
  view,
  unknown,
  auction,
  title,
  note,
  refresh,
}: {
  ticket: Ticket;
  view?: BidView;
  /** The site has no bid for this ticket. */
  unknown: boolean;
  auction: PublicAuction;
  title: string;
  note?: string;
  refresh: () => void;
}) {
  const deposit = view?.deposit;
  // Where to pay is what the site says it made for this bid, never what the
  // ticket says: a ticket can come from a file, and a file can come from anyone.
  const payTo = view?.deposit_address ?? null;
  const funded = (deposit?.total ?? 0) > 0;
  const bond = auction.delivery?.buyer_bond ?? 0;
  const s2 = auction.scheme === 2;
  /** An auction with same-size deposits: everyone deposits the same amount. */
  const same = auction.deposit_required != null;
  // What this bid needs to count: that same amount, or its own amount and the bond.
  const needed = auction.deposit_required ?? ticket.amount + bond;
  const enough = (deposit?.total ?? 0) >= needed;
  // What to send: the round amount the bidder chose, to hide the bid from the site; otherwise what is needed.
  const hiding = s2 && !same && !!ticket.send && ticket.send > needed;
  const roomy = s2 ? (hiding ? ticket.send! : needed) : roomyDeposit(needed);
  /** What a practice wallet's ready-made deposit covers. */
  const practiceCover = auction.practice?.wallet_deposit ?? needed;
  const uri = payTo ? paymentRequest(payTo, formatCoins(roomy)) : "";
  const receipt = ticket.receipt ?? null;
  // A bid placed with a practice wallet: the house purse pays its deposit when asked.
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [sentNow, setSentNow] = useState(false);
  const practicePaid = sentNow || !!view?.practice?.paid;
  // Past this moment a deposit would not reach a block before the close, so the site no longer sends one.
  const payUntil = auction.practice?.pay_until ?? auction.ends_at;
  const tooLate = Date.now() > payUntil;
  const closingSoon = !tooLate && payUntil - Date.now() < 60_000;
  async function payPractice() {
    setPaying(true);
    setPayError(null);
    try {
      const res = await fetch(`/api/auctions/${auction.id}/bids/${ticket.bid_id}/practice-pay`, {
        method: "POST",
        headers: { "x-bid-token": await tokenOf(ticket), "x-practice-token": practiceToken() ?? "" },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        // An answer that isn't the site's own (no JSON) means the request never reached it: say so, don't blame the wallet.
        if (!body) throw new Error(`The site didn't answer as expected (${res.status}). Reload the page and try again.`);
        throw new Error(res.status === 404 ? "This browser no longer holds the practice wallet this bid was placed with." : (body.error ?? "the deposit could not be sent"));
      }
      setSentNow(true);
      window.dispatchEvent(new Event(WALLET_EVENT)); // the wallet panel's balance has changed
      refresh();
    } catch (e) {
      setPayError(e instanceof Error ? e.message : String(e));
    } finally {
      setPaying(false);
    }
  }

  if (unknown)
    return (
      <div className="card bad" data-bid={ticket.bid_id}>
        <h3>This Ticket Is Not Known Here</h3>
        <p className="small bid-unknown" style={{ margin: 0 }}>
          This browser holds a ticket for a bid of {formatCoins(ticket.amount)} TAZ in this auction, but the site has no bid that matches it.{" "}
          <strong>Don&apos;t send anything to an address from it.</strong> If it came from a file someone sent you, it is not yours.
        </p>
      </div>
    );

  return (
    <div className={`card ${view?.standing === "won" ? "accent" : ""}`} data-bid={ticket.bid_id}>
      <div className="row spread">
        <h3 style={{ margin: 0 }}>Your sealed bid</h3>
        <strong className="mono">{formatCoins(ticket.amount)} TAZ</strong>
      </div>

      {auction.state === "open" && !funded && ticket.practice && (
        <div id="practice-fund" style={{ marginTop: 12 }}>
          {same ? (
            <p className="small">
              <strong>Now fund it.</strong> Every bidder deposits <strong>{formatCoins(needed)} TAZ</strong>, whatever they bid, so a deposit says
              nothing about the bid. Your practice wallet pays it: a real shielded payment from the site&apos;s house purse to an address made
              for this bid alone.
            </p>
          ) : (
            <p className="small">
              <strong>Now fund it.</strong> Your practice wallet pays a ready-made deposit of about{" "}
              <strong>{formatCoins(practiceCover)} TAZ</strong>, enough for your bid: a real shielded payment from the site&apos;s house purse to an
              address made for this bid alone. What you don&apos;t owe goes back to your practice wallet.
            </p>
          )}
          {practicePaid ? (
            <p className="small ok" id="practice-sent" style={{ margin: 0 }}>
              Sent. It counts once it is in a block, which takes about 75 seconds on the testnet.
            </p>
          ) : (
            <>
              <button type="button" className="primary" id="practice-pay" disabled={paying || tooLate} onClick={() => void payPractice()}>
                {paying ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Sending…
                  </>
                ) : (
                  same ? `Pay ${formatCoins(needed)} TAZ from my practice wallet` : "Pay the deposit from my practice wallet"
                )}
              </button>
              {tooLate ? (
                <p className="hint error" id="practice-late">
                  Bidding closes too soon for a deposit to reach a block in time, so this bid won&apos;t count. Try the next practice auction.
                </p>
              ) : (
                closingSoon && <p className="hint error">Pay now: in under a minute it will be too late for the deposit to reach a block before the close.</p>
              )}
            </>
          )}
          {payError && <p className="error small">{payError}</p>}
        </div>
      )}
      {auction.state === "open" && !funded && !ticket.practice && !payTo && (
        <p className="small" style={{ marginTop: 12 }}>
          <span className="spinner" aria-hidden="true" /> Checking this bid with the site…
        </p>
      )}
      {auction.state === "open" && !funded && !ticket.practice && payTo && (
        <>
          {s2 && same ? (
            <p className="small" style={{ marginTop: 12 }} id="fund-it">
              <strong>Now fund it.</strong> Send <strong>exactly {formatCoins(needed)} TAZ</strong> from a shielded balance to the address below, with
              no memo. Every bidder sends this same amount (the highest bid allowed{bond > 0 && <>, plus the {formatCoins(bond)} TAZ bond</>}),
              so your deposit says nothing about your bid, even to this site. What you don&apos;t owe comes back when the auction settles.
            </p>
          ) : s2 ? (
            <p className="small" style={{ marginTop: 12 }} id="fund-it">
              <strong>Now fund it.</strong> Send <strong>{formatCoins(roomy)} TAZ</strong> from a shielded balance to the address below, with no
              memo. It was made for this bid alone.{" "}
              {hiding ? (
                <>
                  That is a round amount above your bid, as you chose, so this site can&apos;t work your bid out from it. Your bid needs{" "}
                  {formatCoins(needed)} TAZ{bond > 0 && <> (the bid plus the {formatCoins(bond)} TAZ bond)</>}; the rest comes back when the auction settles.
                </>
              ) : (
                <>
                  That is your bid{bond > 0 && <> plus the {formatCoins(bond)} TAZ bond</>}. A smaller deposit would not count. A larger one is
                  fine: what you don&apos;t owe comes back.
                </>
              )}
            </p>
          ) : (
            <p className="small" style={{ marginTop: 12 }}>
              <strong>Now fund it.</strong> Send <strong>at least {formatCoins(needed)} TAZ</strong>
              {bond > 0 && <> (your bid plus the {formatCoins(bond)} TAZ bond)</>} from a shielded balance to the
              address below, with no memo. It was made for this bid alone.
            </p>
          )}
          {auction.seats && auction.state === "open" && (
            <p className="hint seat-hold" id="seat-hold">
              Fund it within {auction.seats.hold_minutes} minutes to keep your seat. After that the seat goes back to the room, but a deposit
              that arrives before bidding closes still counts.
            </p>
          )}
          <div className="row" style={{ alignItems: "flex-start" }}>
            <Qr value={uri} size={150} />
            <div className="grow">
              <div className="addr deposit-address">{payTo}</div>
              <div className="row" style={{ marginTop: 10 }}>
                <PayLink href={uri} />
                <Copy text={payTo} label="Copy address" />
                <Copy text={uri} label="Copy payment request" />
              </div>
              <p className="hint">
                The button opens your Zcash wallet app with this address and {formatCoins(roomy)} TAZ filled in. No wallet app on this device?
                Scan the code with your phone.
              </p>
              {!s2 && (
                <p className="hint">
                  Sending more hides your bid from this site, which can see deposits: for example {formatCoins(roomy)} TAZ. Whatever you send
                  above your bid comes back to your refund address.
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {s2 && !ticket.practice && (auction.state === "open" || auction.state === "revealing" || auction.state === "settling") && roomy > ticket.amount && (
        <div className="deposit-math" id="deposit-math">
          {same ? (
            <>
              <strong>The deposit is not the price.</strong> You deposit {formatCoins(roomy)} TAZ, the same as every bidder, so nobody can tell what you bid.
            </>
          ) : hiding ? (
            <>
              <strong>The deposit is not the price.</strong> You deposit {formatCoins(roomy)} TAZ, more than your bid, so this site can&apos;t tell what you bid.
            </>
          ) : (
            <>
              <strong>What happens to your {formatCoins(roomy)} TAZ.</strong> It is your bid of {formatCoins(ticket.amount)} TAZ and the {formatCoins(bond)} TAZ bond.
            </>
          )}
          <ul>
            <li>
              If you win, you pay your bid, <strong>{formatCoins(ticket.amount)} TAZ</strong>, and <strong>{formatCoins(roomy - ticket.amount)} TAZ</strong> comes back
              {bond > 0 && roomy - ticket.amount > bond
                ? ` (${formatCoins(roomy - ticket.amount - bond)} at the close, the ${formatCoins(bond)} bond after the handover)`
                : bond > 0
                  ? " after the handover (it is the bond)"
                  : ""}
              .
            </li>
            <li>
              If you don&apos;t win, all <strong>{formatCoins(roomy)} TAZ</strong> comes back.
            </li>
          </ul>
          <span className="muted">A small network fee (about 0.00008 TAZ) comes off what is returned.</span>
        </div>
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
          {s2
            ? view?.revealed
              ? view.opened_by === "beacon"
                ? "opened by the time lock"
                : "opened from your ticket"
              : auction.state === "open"
                ? "sealed and locked in time"
                : auction.state === "revealing"
                  ? "opening…"
                  : "not opened"
            : view?.revealed
              ? "revealed"
              : auction.state === "open"
                ? "sealed"
                : auction.state === "revealing"
                  ? "revealing…"
                  : "not revealed"}
        </dd>
        {s2 && (
          <>
            <dt>Receipt</dt>
            <dd className="receipt-status">
              {receipt ? `#${receipt.position} on the board · signed` : "the site gave no valid receipt"}
            </dd>
          </>
        )}
        <dt>Refund {ticket.practice ? "goes to" : "address"}</dt>
        <dd>{ticket.practice ? "your practice wallet" : (view?.refund_address ?? "…")}</dd>
      </dl>

      {funded && !enough && auction.state === "open" && (
        <p className="error small" style={{ marginBottom: 0 }}>
          {s2 ? `Your deposit is smaller than the ${formatCoins(needed)} TAZ every bid must deposit.` : `Your deposit is smaller than your bid${bond > 0 ? " plus the bond" : ""} (${formatCoins(needed)} TAZ).`}{" "}
          Send the difference to the same address before bidding closes, or this bid won&apos;t count.
        </p>
      )}
      {note && <p className="error small">Couldn&apos;t {s2 ? "open your bid" : "reveal"} yet: {note}</p>}

      {view?.standing && (
        <div style={{ marginTop: 14 }} className="standing">
          <p style={{ marginBottom: 8 }}>
            <strong className={view.standing === "won" ? "ok" : undefined}>{(s2 ? (same ? STANDING_2 : STANDING_OPEN) : STANDING)[view.standing]}</strong>
            {view.standing === "won" && auction.outcome?.price != null && (
              <>
                {" "}
                You pay {formatCoins(auction.outcome.price)} TAZ, your bid.
                {s2 && (deposit?.total ?? 0) > auction.outcome.price && <> The rest of your {formatCoins(deposit!.total)} TAZ deposit comes back to you.</>}
              </>
            )}
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
        {s2 ? (
          <>
            Your bid opens by itself when bidding closes, even with this browser shut. The ticket is your own record of it: it carries the
            site&apos;s signed receipt, opens the bid if the time lock can&apos;t
            {auction.delivery?.kind === "digital" ? ", and unlocks a lot you win" : ""}.
          </>
        ) : (
          <>
            This browser holds the only copy of your bid. Without it the bid can&apos;t be revealed and won&apos;t count (your deposit still comes
            back){auction.delivery?.kind === "digital" ? ", and a lot you win can't be unlocked" : ""}.
          </>
        )}{" "}
        <button type="button" className="link small" onClick={() => download(`dark-vault-bid-${ticket.bid_id.slice(0, 8)}.txt`, ticketFile(ticket, title))}>
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
