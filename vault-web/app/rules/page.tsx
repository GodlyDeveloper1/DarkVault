import type { Metadata } from "next";
import Link from "next/link";
import { PiChatCircleTextBold, PiGavelBold, PiHourglassHighBold, PiMagnifyingGlassBold } from "react-icons/pi";

export const metadata: Metadata = { title: "Dispute Rules" };

// How a dispute is decided, for both sides, in every market. The same page the
// dispute screens link to. One side wins the whole dispute; it is decided on
// proof; silence loses; and nobody's money can be stuck.

const STEPS = [
  {
    icon: PiChatCircleTextBold,
    title: "A Complaint.",
    text: "The buyer says what is wrong, inside the time limit. A digital lot must be checked at once: 2 hours from when it opens. A parcel gets at least a week, and 3 more days once if it hasn't arrived.",
  },
  {
    icon: PiMagnifyingGlassBold,
    title: "The Site Asks For Proof.",
    text: "Both sides are asked at once: photos (up to three, cleaned in the browser) and a short note. The site can ask again if it needs more.",
  },
  {
    icon: PiHourglassHighBold,
    title: "48 Hours To Answer.",
    text: "A side that sends nothing in time loses the dispute. If neither answers, everyone's own money goes back.",
  },
  {
    icon: PiGavelBold,
    title: "One Side Wins.",
    text: "No splits. The winner of the dispute takes the price and the other side's bond. If it is not decided within 3 days, everyone's own money goes back.",
  },
];

const MONEY = [
  { who: "The Seller Wins", price: "To the seller", buyer: "To the seller", seller: "Back to the seller" },
  { who: "The Buyer Wins", price: "Back to the buyer", buyer: "Back to the buyer", seller: "To the buyer" },
  { who: "The Buyer Wins, Return First", price: "Back to the buyer, once it is posted back", buyer: "Back to the buyer", seller: "To the buyer (it covers the postage)" },
  { who: "Lost In The Post", price: "Back to the buyer", buyer: "Back to the buyer", seller: "Back to the seller" },
  { who: "Not Decided In Time", price: "Back to the buyer", buyer: "Back to the buyer", seller: "Back to the seller" },
];

const CASES = [
  { claim: "It never arrived", proof: "The tracking shows it was delivered, to the town the buyer gave.", wins: "Seller" },
  { claim: "It never arrived", proof: "The seller has no receipt of posting and no tracking.", wins: "Buyer" },
  { claim: "It never arrived", proof: "The tracking shows it went somewhere else.", wins: "Buyer" },
  { claim: "The box was empty, or held the wrong thing", proof: "Photos of what arrived, against the seller's photos from before posting.", wins: "The clearer proof" },
  { claim: "Lost, damaged or held at customs", proof: "The tracking says so. Nobody lied.", wins: "Lost In The Post" },
  { claim: "The key or code doesn't work", proof: "The buyer shows the error, in order, within 2 hours; the seller shows where the key came from.", wins: "The clearer proof" },
  { claim: "The key or code doesn't work", proof: "Neither side can show more than the other.", wins: "Seller (the buyer keeps the key and can't give it back)" },
  { claim: "Not what was described", proof: "Photos or the delivered file, against the listing.", wins: "The clearer proof. A posted item that the buyer wins goes back first." },
  { claim: "It was not done as promised", proof: "Screenshots, messages, the result.", wins: "The clearer proof" },
  { claim: "Any claim", proof: "A side sends nothing in time.", wins: "The other side" },
  { claim: "Any claim", proof: "A side sends faked or edited proof.", wins: "The other side" },
];

export default function RulesPage() {
  return (
    <main>
      <div className="shell settle rules">
        <div className="row spread page-head">
          <div>
            <p className="peak">Fair To Both Sides.</p>
            <h1>Dispute Rules</h1>
            <p className="lead">
              How a dispute is decided, in every market: auctions, Order Flow and Settlement. One side wins the whole dispute, and it is decided on
              proof. Whoever loses also loses their bond to the other side, so lying costs money. Nobody&apos;s money can be stuck.
            </p>
          </div>
          <div className="row">
            <Link href="/auctions" className="btn primary lg">
              See The Auctions
            </Link>
          </div>
        </div>

        <section className="settle-steps" aria-label="How a dispute runs">
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

        <section className="card rules-card" aria-label="Where the money goes">
          <h2>Where The Money Goes</h2>
          <div className="rules-table" role="table">
            <div className="rules-row rules-head" role="row">
              <span role="columnheader">Outcome</span>
              <span role="columnheader">The Price</span>
              <span role="columnheader">The Buyer&apos;s Bond</span>
              <span role="columnheader">The Seller&apos;s Bond</span>
            </div>
            {MONEY.map((m) => (
              <div className="rules-row" role="row" key={m.who}>
                <span role="cell">
                  <strong>{m.who}</strong>
                </span>
                <span role="cell">{m.price}</span>
                <span role="cell">{m.buyer}</span>
                <span role="cell">{m.seller}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card rules-card" aria-label="How proof is weighed">
          <h2>How Proof Is Weighed</h2>
          <div className="rules-table cases" role="table">
            <div className="rules-row rules-head" role="row">
              <span role="columnheader">The Claim</span>
              <span role="columnheader">The Proof</span>
              <span role="columnheader">Who Wins</span>
            </div>
            {CASES.map((c, i) => (
              <div className="rules-row" role="row" key={i}>
                <span role="cell">{c.claim}</span>
                <span role="cell">{c.proof}</span>
                <span role="cell">
                  <strong>{c.wins}</strong>
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="card rules-card" aria-label="Returns">
          <h2>Returns</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            When the buyer wins a dispute over a posted item that is not what was described, they send it back before they are refunded. Nobody
            keeps the item and the money.
          </p>
          <ul className="rules-list">
            <li>
              <strong>48 hours:</strong> the seller gives a return address, sealed so only the buyer can read it. None: the buyer is refunded and
              keeps the item.
            </li>
            <li>
              <strong>5 days:</strong> the buyer posts it back, with tracking. Not posted: the seller is paid and gets the buyer&apos;s bond.
            </li>
            <li>
              <strong>7 days:</strong> the seller says it is back, or says what came back is wrong (then the site asks both for proof again).
              Silence: the buyer is refunded.
            </li>
          </ul>
        </section>

        <section className="card rules-card" aria-label="Good habits">
          <h2>Good Habits</h2>
          <ul className="rules-list">
            <li>
              <strong>Sellers:</strong> photograph the item and any serial number before posting, keep the receipt of posting, and use tracked post.
            </li>
            <li>
              <strong>Buyers:</strong> check a key or a file as soon as it opens, and film the unboxing of anything valuable.
            </li>
            <li>
              <strong>Both:</strong> cover names and addresses before adding a photo. Only the site sees your photos, never the other side, and they
              are deleted once the dispute is paid out.
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}
