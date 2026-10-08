import type { Metadata } from "next";
import Link from "next/link";
import { PiArrowsSplitBold, PiHandCoinsBold, PiLockKeyOpenBold, PiSealCheckBold } from "react-icons/pi";
import { formatCoins } from "vault-core";
import { loadListed, loadSales } from "../components/AuctionsGrid";
import { listAuctions } from "@/lib/store";
import { ledgerDeals, type PublicAuction } from "@/lib/views";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ledger" };

// The public record of the three markets: how every listed auction ended and
// how it was paid, how many units every batch sale sold and the lowest order
// that won, and every completed private deal whose seller chose to show its
// price. Everything here is already public. It shows no address, no
// deposit, no losing bid, and nothing that says which deal a deal's row is or
// when it happened: deals are added in batches (see ledgerDeals in lib/views).

const STEPS = [
  {
    icon: PiLockKeyOpenBold,
    title: "The Lock Opens.",
    text: "At the close of an auction or a sale the time lock releases every bid or order at once. Nobody chose the moment, this site included. A deal has a fixed price, so it has nothing to open.",
  },
  {
    icon: PiSealCheckBold,
    title: "The Result Is Proved.",
    text: "The site publishes the price with a proof that the highest bid won, or that the highest orders won the units. Your browser checks it. The other amounts stay hidden.",
  },
  {
    icon: PiArrowsSplitBold,
    title: "One Shielded Transaction.",
    text: "It returns every deposit that did not win and sets the price aside. The chain shows no amounts and no addresses.",
  },
  {
    icon: PiHandCoinsBold,
    title: "Held, Then Paid.",
    text: "The price waits in escrow until the handover. Then the seller is paid and both bonds go home.",
  },
];

type Tone = "lime" | "amber" | "red" | "";
type Said = { text: string; tone: Tone };
/** The parts of a row that an auction and a deal share. */
type Settling = Pick<PublicAuction, "state" | "paid"> & { stage: string | null | undefined; sold: boolean; decided: boolean; hasDelivery: boolean };

function payout(a: Settling, prices = "Price"): Said {
  if (!a.decided) return { text: "Not Yet", tone: "" };
  if (a.state === "settling") return { text: "Being Sent", tone: "amber" };
  if (a.state === "delivering") return { text: a.sold ? `Deposits Returned, ${prices} In Escrow` : "Bond Being Returned", tone: "amber" };
  if (a.paid === "mined") return { text: "In A Block", tone: "lime" };
  if (a.paid === "nothing-to-pay") return { text: "Nothing To Pay", tone: "" };
  if (a.paid === "expired") return { text: "Expired, Being Sent Again", tone: "amber" };
  return { text: "On Its Way To A Block", tone: "amber" };
}

function handover(a: Settling, buyer: string): Said {
  if (!a.decided) return { text: "Not Yet", tone: "" };
  if (!a.sold) return { text: a.state === "settled" ? "No Sale, Deposits Returned" : "No Sale", tone: "" };
  if (!a.hasDelivery) return { text: "Seller Paid At The Close", tone: "lime" };
  switch (a.stage) {
    case "released":
      return { text: "Handed Over, Seller Paid", tone: "lime" };
    case "refunded":
      return { text: `${buyer} Refunded`, tone: "red" };
    case "disputed":
      return { text: "In Dispute", tone: "red" };
    case "awaiting-confirmation":
      return { text: `${buyer} Is Checking It`, tone: "amber" };
    case "awaiting-address":
      return { text: `Waiting For The ${buyer}`, tone: "amber" };
    case "awaiting-handover":
      return { text: "Waiting For The Seller", tone: "amber" };
    default:
      return { text: "Not Started", tone: "" };
  }
}

function auctionResult(a: PublicAuction): Said {
  if (!a.outcome) return { text: a.scheme === 2 ? "Opening The Bids" : "Waiting For Reveals", tone: "amber" };
  if (a.delivery?.stage === "refunded") return { text: "Sale Undone", tone: "red" };
  return a.outcome.sold ? { text: `Sold For ${formatCoins(a.outcome.price!)} TAZ`, tone: "lime" } : { text: "Not Sold", tone: "" };
}

/** Order Flow: what a batch sale's row says. The one public amount is the lowest order that won. */
function saleResult(a: PublicAuction): Said {
  if (!a.outcome) return { text: "Opening The Orders", tone: "amber" };
  if (a.outcome.cancelled) return { text: "Never Opened", tone: "" };
  const sold = a.batch?.sold ?? 0;
  return a.outcome.sold ? { text: `${sold} Of ${a.batch!.units} Units Sold, From ${formatCoins(a.outcome.price!)} TAZ`, tone: "lime" } : { text: "Nothing Sold", tone: "" };
}

function saleHandover(a: PublicAuction): Said {
  if (!a.outcome) return { text: "Not Yet", tone: "" };
  const sold = a.batch?.sold ?? 0;
  if (!a.outcome.sold) return { text: a.state === "settled" ? "No Sale, Deposits Returned" : "No Sale", tone: "" };
  const done = a.batch?.done ?? 0;
  return done >= sold ? { text: sold === 1 ? "The Unit Is Finished" : `All ${sold} Units Finished`, tone: "lime" } : { text: `${done} Of ${sold} Units Finished`, tone: "amber" };
}

const ofAuction = (a: PublicAuction): Settling => ({ state: a.state, paid: a.paid, stage: a.delivery?.stage, sold: a.outcome?.sold === true, decided: !!a.outcome, hasDelivery: !!a.delivery });

export default async function Ledger() {
  const listed = await loadListed();
  // Auctions past their closing time, newest first.
  const auctions = listed.filter((a) => a.state !== "open" && a.state !== "funding").sort((a, b) => b.ends_at - a.ends_at);
  // Completed deals that chose to show their price, largest first. They carry no time, and their order gives none away.
  const deals = await ledgerDeals(await listAuctions());

  // Batch sales past their closing time, newest first.
  const sales = (await loadSales()).filter((a) => a.state !== "open" && a.state !== "funding").sort((a, b) => b.ends_at - a.ends_at);

  const sold = auctions.filter((a) => a.outcome?.sold && a.delivery?.stage !== "refunded");
  // Only public prices are added up. A sale's units each sold at or above its lowest winning order, and only that is public: the sum counts each at that.
  const volume =
    sold.reduce((sum, a) => sum + (a.outcome!.price ?? 0), 0) +
    deals.reduce((sum, d) => sum + d.price, 0) +
    sales.reduce((sum, a) => sum + (a.outcome?.sold ? (a.batch?.sold ?? 0) * a.outcome.price! : 0), 0);
  const empty = auctions.length + deals.length + sales.length === 0;

  return (
    <main>
      <div className="shell settle">
        <div className="row spread page-head">
          <div>
            <p className="peak">Privacy At Its Peak.</p>
            <h1>Ledger</h1>
            <p className="lead">
              The public record of Dark Vault: how every auction ended, what every sale&apos;s units went for, and every deal that chose to show its
              price. The price is public. Who paid it, who was refunded and what the others offered are not.
            </p>
          </div>
          <div className="row">
            <Link href="/auctions" className="btn primary lg">
              See The Auctions
            </Link>
            <Link href="/orders" className="btn lg">
              See The Sales
            </Link>
            <Link href="/settlement" className="btn lg">
              Settle A Deal
            </Link>
          </div>
        </div>

        <section className="settle-steps" aria-label="How a sale settles">
          {STEPS.map((s, i) => (
            <div className="settle-step" key={s.title} style={{ animationDelay: `${i * 90}ms` }}>
              <span className="settle-n mono">{i + 1}</span>
              <i className="settle-ico" aria-hidden="true">
                <s.icon />
              </i>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          ))}
        </section>

        <section className="settle-stats" aria-label="At a glance">
          <div>
            <b id="settle-closed">{auctions.length}</b>
            <span>{auctions.length === 1 ? "Auction" : "Auctions"} Closed</span>
          </div>
          <div>
            <b id="ledger-sales">{sales.length}</b>
            <span>{sales.length === 1 ? "Sale" : "Sales"} Closed</span>
          </div>
          <div>
            <b id="ledger-deals">{deals.length}</b>
            <span>{deals.length === 1 ? "Deal" : "Deals"} In Public View</span>
          </div>
          <div>
            <b className="mono">{formatCoins(volume)}</b>
            <span>TAZ Through The Vault, At Public Prices</span>
          </div>
        </section>

        <section id="ledger">
          <div className="row spread" style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0 }}>The Ledger</h2>
            <span className="muted small">Listed auctions, batch sales, and completed deals whose seller chose to show the price. Private auctions are not here.</span>
          </div>

          {empty ? (
            <div className="card">
              <p style={{ margin: 0 }}>
                Nothing has closed yet. <Link href="/auctions">See what is open.</Link>
              </p>
            </div>
          ) : (
            <div className="ledger" role="table" aria-label="Closed auctions, closed sales and settled deals">
              <div className="ledger-row ledger-head" role="row">
                <span role="columnheader">Lot</span>
                <span role="columnheader">Result</span>
                <span role="columnheader">Sealed Bids Or Orders</span>
                <span role="columnheader">Payout</span>
                <span role="columnheader">Handover</span>
                <span role="columnheader">Proof</span>
              </div>
              {auctions.map((a, i) => {
                const r = auctionResult(a);
                const p = payout(ofAuction(a));
                const h = handover(ofAuction(a), "Winner");
                return (
                  <div className="ledger-row" role="row" data-market="auction" key={a.id} style={{ animationDelay: `${Math.min(i, 10) * 50}ms` }}>
                    <span role="cell" data-label="Lot" className="ledger-lot">
                      <Link href={`/auction/${a.id}`}>{a.title}</Link>
                      <i className="badge">Auction</i>
                      {a.practice && <i className="badge practice-tag">Practice</i>}
                    </span>
                    <span role="cell" data-label="Result" className={`ledger-tone ${r.tone}`}>
                      {r.text}
                    </span>
                    <span role="cell" data-label="Sealed Bids">
                      {a.bids}
                      {a.outcome && <i className="ledger-sub">{a.outcome.counted} counted</i>}
                    </span>
                    <span role="cell" data-label="Payout" className={`ledger-tone ${p.tone}`}>
                      {p.text}
                    </span>
                    <span role="cell" data-label="Handover" className={`ledger-tone ${h.tone}`}>
                      {h.text}
                    </span>
                    <span role="cell" data-label="Proof">
                      {a.scheme === 2 && a.proof ? (
                        <>
                          <Link href={`/auction/${a.id}#verify-card`} className="ledger-check">
                            Check It
                          </Link>
                          <a href={`/api/auctions/${a.id}/proof`} className="ledger-sub" target="_blank" rel="noreferrer">
                            raw file
                          </a>
                        </>
                      ) : (
                        <i className="ledger-sub">{a.outcome ? "none: an older auction" : "after the close"}</i>
                      )}
                    </span>
                  </div>
                );
              })}
              {sales.map((a, i) => {
                const r = saleResult(a);
                const p = payout({ state: a.state, paid: a.paid, stage: null, sold: a.outcome?.sold === true, decided: !!a.outcome, hasDelivery: true }, "Prices");
                const h = saleHandover(a);
                return (
                  <div className="ledger-row" role="row" data-market="sale" key={a.id} style={{ animationDelay: `${Math.min(auctions.length + i, 10) * 50}ms` }}>
                    <span role="cell" data-label="Lot" className="ledger-lot">
                      <Link href={`/orders/${a.id}`}>{a.title}</Link>
                      <i className="badge units-tag">Order Flow</i>
                    </span>
                    <span role="cell" data-label="Result" className={`ledger-tone ${r.tone}`}>
                      {r.text}
                    </span>
                    <span role="cell" data-label="Sealed Orders">
                      {a.bids}
                      {a.outcome && <i className="ledger-sub">{a.outcome.counted} counted</i>}
                    </span>
                    <span role="cell" data-label="Payout" className={`ledger-tone ${p.tone}`}>
                      {p.text}
                    </span>
                    <span role="cell" data-label="Handover" className={`ledger-tone ${h.tone}`}>
                      {h.text}
                    </span>
                    <span role="cell" data-label="Proof">
                      {a.proof ? (
                        <>
                          <Link href={`/orders/${a.id}#verify-card`} className="ledger-check">
                            Check It
                          </Link>
                          <a href={`/api/auctions/${a.id}/proof`} className="ledger-sub" target="_blank" rel="noreferrer">
                            raw file
                          </a>
                        </>
                      ) : (
                        <i className="ledger-sub">after the close</i>
                      )}
                    </span>
                  </div>
                );
              })}
              {deals.map((d, i) => (
                // Every deal's row is the same but for its price: nothing else about a deal is public.
                <div className="ledger-row" role="row" data-market="deal" key={`deal-${i}`} style={{ animationDelay: `${Math.min(auctions.length + sales.length + i, 10) * 50}ms` }}>
                  <span role="cell" data-label="Lot" className="ledger-lot">
                    <b>A Private Deal</b>
                    <i className="badge private-tag">Settlement</i>
                  </span>
                  <span role="cell" data-label="Result" className="ledger-tone lime">
                    Settled For {formatCoins(d.price)} TAZ
                  </span>
                  <span role="cell" data-label="Sealed Bids">
                    <i className="ledger-sub">no bidding</i>
                  </span>
                  <span role="cell" data-label="Payout" className="ledger-tone lime">
                    In A Block
                  </span>
                  <span role="cell" data-label="Handover" className="ledger-tone lime">
                    Handed Over, Seller Paid
                  </span>
                  <span role="cell" data-label="Proof">
                    <i className="ledger-sub">none needed: a fixed price</i>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card settle-note">
          <h3>What This Page Can&apos;t Show</h3>
          <p>
            Who was paid, where a refund went, and what each deposit was. Settlement is one shielded transaction, so none of that is on the chain,
            and the site shows a payment only to the person it pays. A sale&apos;s row gives the lowest order that won a unit: what each other buyer
            offered, and paid, is shown to that buyer and the seller alone. A deal&apos;s row says only that a deal of that price was
            completed: not which deal, not what it was for, not between whom. Deals are added in batches, once a day at midnight UTC, largest
            first, so a row can&apos;t be matched to a moment or to a transaction. If you took part, your own payment and its transaction are on that auction&apos;s, sale&apos;s or deal&apos;s page, in
            this browser.
          </p>
        </section>
      </div>
    </main>
  );
}
