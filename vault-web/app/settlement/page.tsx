import type { Metadata } from "next";
import Link from "next/link";
import { PiHandshakeBold, PiHandCoinsBold, PiLockKeyBold, PiVaultBold } from "react-icons/pi";
import { formatCoins } from "vault-core";
import MyDeals from "../components/MyDeals";
import OpenDeal from "../components/OpenDeal";
import { listAuctions } from "@/lib/store";
import { ledgerDeals } from "@/lib/views";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settlement" };

// The Settlement market: two people who have already agreed a price settle it
// here, through a shielded escrow. No bidding. The page explains it, opens a
// deal from its link, and lists the deals this browser is part of.

const STEPS = [
  {
    icon: PiHandshakeBold,
    title: "Agree, Anywhere.",
    text: "You and one other person settle on a price and what is handed over. In a chat, on a call, wherever you like.",
  },
  {
    icon: PiLockKeyBold,
    title: "Seal The Terms.",
    text: "The seller writes them here. They are encrypted in the seller's browser, and one private link carries the key to the buyer.",
  },
  {
    icon: PiVaultBold,
    title: "Pay Into Escrow.",
    text: "The buyer sends the price in one shielded payment. It is held, not paid: the chain shows no amount and no address.",
  },
  {
    icon: PiHandCoinsBold,
    title: "Hand Over, Then Release.",
    text: "A file unlocks, a parcel ships, or the work is done. The buyer confirms, the seller is paid, and both bonds go home.",
  },
];

const SEES: [string, string, boolean?][] = [
  ["Anyone Watching The Chain", "Nothing. Every payment is shielded.", true],
  ["The Public", "Nothing. Or, if the seller chose it, the price alone, added to the ledger with that day's other deals. Never the terms, the moment or who was involved."],
  ["This Site", "The price, the bonds and the time limits, because it runs the escrow, and it sees the payment arrive. Not the terms, not the item, not a postal address."],
  ["The Other Side", "The terms, and what is handed over. Nothing about your wallet."],
];

export default async function Settlement() {
  const done = await ledgerDeals(await listAuctions());
  const volume = done.reduce((sum, d) => sum + d.price, 0);

  return (
    <main>
      <div className="shell settle">
        <div className="row spread page-head">
          <div>
            <p className="peak">Privacy At Its Peak.</p>
            <h1>Settlement</h1>
            <p className="lead">
              Settle a deal you have already agreed, without having to trust each other and without showing the world. The buyer pays into a
              shielded escrow. The price is released when the handover is done.
            </p>
          </div>
          <div className="row">
            <Link href="/settlement/new" className="btn primary lg" id="new-deal">
              Create A Deal
            </Link>
            <Link href="/ledger" className="btn lg">
              See The Ledger
            </Link>
          </div>
        </div>

        <section className="settle-steps" aria-label="How a deal settles">
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

        <div className="dash-cols settle-cols">
          <MyDeals />
          <OpenDeal />
        </div>

        <section className="card" id="deal-sees">
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
            One exception, and it is the buyer&apos;s choice: to open a dispute, their browser hands the site the key to the terms, so the dispute
            can be judged against what was agreed.
          </p>
        </section>

        <section className="settle-stats" aria-label="Deals on the public ledger">
          <div>
            <b id="deals-settled">{done.length}</b>
            <span>{done.length === 1 ? "Deal" : "Deals"} On The Public Ledger</span>
          </div>
          <div>
            <b className="mono">{formatCoins(volume)}</b>
            <span>TAZ Settled Through Escrow</span>
          </div>
          <div>
            <b>2</b>
            <span>Bonds In Every Deal</span>
          </div>
          <div>
            <b>0</b>
            <span>Kept By The Site</span>
          </div>
        </section>
        <p className="muted small">
          Only completed deals whose seller chose to show the price are counted, and they are added once a day, so the count can&apos;t be watched
          to time a deal. The rest leave no public trace.{" "}
          <Link href="/ledger">Open the ledger.</Link>
        </p>
      </div>
    </main>
  );
}
