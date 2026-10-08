import type { Metadata } from "next";
import Link from "next/link";
import AuctionsGrid from "../components/AuctionsGrid";
import PracticePanel from "../components/PracticePanel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Auctions" };

// Every auction in one place. The header's "Auctions" link comes here.
export default function Auctions() {
  return (
    <main>
      <div className="shell">
        <div className="row spread page-head">
          <div>
            <p className="kicker">Sealed-bid auctions on shielded Zcash</p>
            <h1>Auctions</h1>
            <p className="lead">
              Every lot here is sold by sealed bid. Open one to see its board and place a bid, or list a lot of your own.
            </p>
          </div>
          <Link href="/sell" className="btn primary lg">
            List A Lot
          </Link>
        </div>

        <PracticePanel />

        <section id="auctions">
          <AuctionsGrid />
        </section>
      </div>
    </main>
  );
}
