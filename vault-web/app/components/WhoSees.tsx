"use client";

// Who learns what, and when. The same table as the README, with a switch
// between the two moments that matter: while bidding is open, and after the close.
import { useState } from "react";

type When = "open" | "after";

const ROWS: { who: string; open: string; after: string; nothing?: When[] }[] = [
  {
    who: "Anyone Watching The Chain",
    open: "Nothing. All payments are shielded.",
    after: "Nothing.",
    nothing: ["open", "after"],
  },
  {
    who: "Other Bidders And Visitors",
    open: "Commitments only.",
    after: "The price, which bids counted, and the proof. No losing amounts.",
  },
  {
    who: "This Site",
    open: "Commitments, locked bids it can't open, refund addresses, and the size of each deposit: the most that bidder can have bid.",
    after: "The amounts of the bids that were funded in full.",
  },
  {
    who: "The Seller",
    open: "What visitors see.",
    after: "What visitors see, plus their own payment.",
  },
];

export default function WhoSees() {
  const [when, setWhen] = useState<When>("open");
  return (
    <div className="who" data-reveal>
      <div className="who-switch" role="group" aria-label="Choose the moment">
        <button type="button" className={when === "open" ? "on" : ""} aria-pressed={when === "open"} onClick={() => setWhen("open")}>
          While Bidding Is Open
        </button>
        <button type="button" className={when === "after" ? "on" : ""} aria-pressed={when === "after"} onClick={() => setWhen("after")}>
          After The Close
        </button>
      </div>
      <dl className="who-rows">
        {ROWS.map((r, i) => (
          <div className={r.nothing?.includes(when) ? "who-row nothing" : "who-row"} key={r.who}>
            <dt>{r.who}</dt>
            {/* The key makes the answer fade in again each time the moment changes. */}
            <dd key={when} style={{ animationDelay: `${i * 70}ms` }}>
              {r[when]}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
