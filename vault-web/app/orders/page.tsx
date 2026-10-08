import type { Metadata } from "next";
import Link from "next/link";
import { PiHandCoinsBold, PiLockKeyBold, PiRankingBold, PiStackBold } from "react-icons/pi";
import { loadSales } from "../components/AuctionsGrid";
import SaleTile from "../components/SaleTile";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Order Flow" };

// The Order Flow market: one seller, several identical units, sealed orders.
// The highest orders win a unit each and each pays what it offered. The page
// explains it and lists every sale.

const STEPS = [
  {
    icon: PiStackBold,
    title: "Many Units, One Sale.",
    text: "A seller offers several identical units at once: licence keys, invite codes, tickets. Each is encrypted in the seller's browser with a key of its own.",
  },
  {
    icon: PiLockKeyBold,
    title: "Sealed Orders.",
    text: "Each buyer sends one sealed number for one unit, locked in time, with a shielded deposit. Nobody can read an order before the close, this site included.",
  },
  {
    icon: PiRankingBold,
    title: "The Highest Orders Win.",
    text: "At the close the lock opens. The highest orders take a unit each, and each buyer pays exactly what they offered. A proof shows the right orders won.",
  },
  {
    icon: PiHandCoinsBold,
    title: "Held, Then Paid, Unit By Unit.",
    text: "Each price waits in an escrow of its own until that buyer has their unit. Every other deposit goes home in one shielded transaction.",
  },
];

const SEES: [string, string, boolean?][] = [
  ["Anyone Watching The Chain", "Nothing. Every payment is shielded.", true],
  ["The Public", "The board of sealed orders, which of them won a unit, and the lowest order that won one. Not who placed any order, and not what any other order offered."],
  ["This Site", "No order until the close: they are locked in time. After it, every order that counted, because it has to pick the winners. It sees deposits arrive, never where they came from."],
  ["The Seller", "What each sold unit went for, because that is what they are paid. Nothing about any buyer's wallet."],
  ["Another Buyer", "Only what the public sees. Units are handed to the winners in an order nobody outside can predict, so a unit's number says nothing about anyone's order. Their key can't open your unit."],
];

export default async function Orders() {
  const sales = await loadSales();
  const open = sales.filter((a) => a.state === "open").length;
  const units = sales.reduce((n, a) => n + (a.batch?.units ?? 0), 0);
  const sold = sales.reduce((n, a) => n + (a.batch?.sold ?? 0), 0);

  return (
    <main>
      <div className="shell settle">
        <div className="row spread page-head">
          <div>
            <p className="peak">Privacy At Its Peak.</p>
            <h1>Order Flow</h1>
            <p className="lead">
              Sell many identical units in one sealed sale. Buyers send sealed orders, the highest win, and each pays what they offered. The
              price a unit went for is public. The orders, and the people behind them, are not.
            </p>
          </div>
          <div className="row">
            <Link href="/orders/new" className="btn primary lg" id="new-sale">
              Start A Sale
            </Link>
            <Link href="/ledger" className="btn lg">
              See The Ledger
            </Link>
          </div>
        </div>

        <section className="settle-steps" aria-label="How a batch sale works">
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

        <section id="sales">
          <div className="row spread" style={{ marginBottom: 16 }}>
            <h2 style={{ margin: 0 }}>The Sales</h2>
            <span className="muted small">Open ones first.</span>
          </div>
          {sales.length === 0 ? (
            <div className="card" id="no-sales">
              <p style={{ margin: 0 }}>
                No sales yet. <Link href="/orders/new">Start the first one.</Link>
              </p>
            </div>
          ) : (
            <div className="grid">
              {sales.map((a) => (
                <SaleTile key={a.id} a={a} />
              ))}
            </div>
          )}
        </section>

        <section className="card" id="order-rule">
          <h2>Why Each Buyer Pays What They Offered</h2>
          <p className="muted" style={{ margin: 0 }}>
            Some sales charge every winner the same price: the lowest order that won. Here each winner pays their own number. That keeps one rule
            for the whole site: what you pay is the number you sealed, and nothing anyone else does can move it. A seller can&apos;t place an
            order of their own to push your price up, and you can check the amount yourself, because you wrote it.
          </p>
        </section>

        <section className="card" id="order-sees">
          <h2>What Each Side Can See</h2>
          <dl className="who-rows">
            {SEES.map(([who, what, nothing]) => (
              <div className={nothing ? "who-row nothing" : "who-row"} key={who}>
                <dt>{who}</dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          <p className="muted small" style={{ margin: "14px 0 0" }}>
            A buyer who wants to keep an order from the site until the close, deposit and all, ticks Hide My Order From This Site and sends a
            larger, round amount. One exception, by the buyer&apos;s choice: to dispute a unit, their browser hands the operator that one
            unit&apos;s key.
          </p>
        </section>

        <section className="settle-stats" aria-label="Order Flow at a glance">
          <div>
            <b id="sales-open">{open}</b>
            <span>{open === 1 ? "Sale" : "Sales"} Open Now</span>
          </div>
          <div>
            <b id="sales-all">{sales.length}</b>
            <span>{sales.length === 1 ? "Sale" : "Sales"} In All</span>
          </div>
          <div>
            <b>{units}</b>
            <span>Units Offered</span>
          </div>
          <div>
            <b id="units-sold">{sold}</b>
            <span>Units Sold</span>
          </div>
        </section>
      </div>
    </main>
  );
}
