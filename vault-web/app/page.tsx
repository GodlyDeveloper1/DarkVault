import Link from "next/link";
import { listAuctions } from "@/lib/store";
import { infosFor, publicView } from "@/lib/views";
import AuctionTile from "./components/AuctionTile";

export const dynamic = "force-dynamic";

export default async function Home() {
  const auctions = await Promise.all(
    // A listing shows once the seller's bond has arrived: an unfunded one is not an auction yet.
    (await listAuctions())
      .filter((a) => a.state !== "funding" && !a.outcome?.cancelled)
      .map(async (a) => publicView(a, await infosFor(a))),
  );
  const rank = { open: 0, revealing: 1, settling: 2, delivering: 3, funding: 4, settled: 5 } as const;
  auctions.sort((a, b) => rank[a.state] - rank[b.state] || b.created_at - a.created_at);

  return (
    <main>
      <div className="shell">
        <section className="hero">
          <p className="kicker">Sealed-bid auctions on shielded Zcash</p>
          <h1>
            Bid in the dark.
            <br />
            <span className="lime">The highest sealed bid wins.</span>
          </h1>
          <p className="lead">
            Every bid is a shielded deposit, sealed until bidding closes. Nobody watching the chain can see who bid, how
            much, who won or what was paid.
          </p>
          <div className="cta">
            <Link className="btn primary lg" href="/#auctions">
              See the auctions
            </Link>
            <Link className="btn lg" href="/sell">
              Sell something
            </Link>
          </div>
        </section>

        <section className="facts">
          <div className="card">
            <h3>Sealed</h3>
            <p className="muted small" style={{ margin: 0 }}>
              Your browser sends a commitment, never an amount. The amount is revealed only after bidding closes.
            </p>
          </div>
          <div className="card">
            <h3>Shielded</h3>
            <p className="muted small" style={{ margin: 0 }}>
              Each bid has its own deposit address. Deposits and the payout are shielded transactions.
            </p>
          </div>
          <div className="card">
            <h3>Highest bid wins</h3>
            <p className="muted small" style={{ margin: 0 }}>
              The winner pays exactly what they bid. No other bid can change the price, so a fake bid can&apos;t push it up.
            </p>
          </div>
          <div className="card">
            <h3>One payout</h3>
            <p className="muted small" style={{ margin: 0 }}>
              A single transaction pays the seller and returns every other deposit. The vault ends empty.
            </p>
          </div>
        </section>

        <section id="auctions">
          <div className="row spread" style={{ marginBottom: 16 }}>
            <h2 style={{ margin: 0 }}>Auctions</h2>
            <Link href="/sell" className="small">
              List a lot →
            </Link>
          </div>
          {auctions.length === 0 ? (
            <div className="card">
              <p style={{ margin: 0 }}>
                No auctions yet. <Link href="/sell">List the first lot.</Link>
              </p>
            </div>
          ) : (
            <div className="grid">
              {auctions.map((a) => (
                <AuctionTile key={a.id} a={a} />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
