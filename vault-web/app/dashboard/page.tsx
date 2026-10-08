import type { Metadata } from "next";
import Link from "next/link";
import AuctionsGrid, { loadListed, loadSales } from "../components/AuctionsGrid";
import DashMine from "../components/DashMine";
import MoveVault from "../components/MoveVault";
import PracticePanel from "../components/PracticePanel";
import SaleTile from "../components/SaleTile";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard" };

// The app's front door, for people who are here to use it rather than read
// about it: what is open, what this browser has bid on and listed, and the
// first steps for someone new.
export default async function Dashboard() {
  const auctions = await loadListed();
  const open = auctions.filter((a) => a.state === "open");
  // Batch sales (the Order Flow market) taking orders now.
  const sales = (await loadSales()).filter((a) => a.state === "open");

  return (
    <main>
      <div className="shell dash">
        <div className="row spread page-head">
          <div>
            <p className="peak">Privacy At Its Peak.</p>
            <h1>Dashboard</h1>
            <p className="lead">Your side of Dark Vault. Your bids, orders and listings are kept in this browser, not in an account. <a href="#move">Move them to another browser</a> whenever you like.</p>
          </div>
          <div className="row">
            <Link href="/auctions" className="btn primary lg">
              See The Auctions
            </Link>
            <Link href="/sell" className="btn lg">
              Sell Something
            </Link>
          </div>
        </div>

        <DashMine open={open.length} total={auctions.length} />

        <PracticePanel />

        <MoveVault />

        <section id="open-now">
          <div className="row spread" style={{ marginBottom: 16 }}>
            <h2 style={{ margin: 0 }}>Open Now</h2>
            <Link href="/auctions" className="small">
              All Auctions →
            </Link>
          </div>
          <AuctionsGrid auctions={open} limit={6} empty="Nothing is open right now." />
        </section>

        {sales.length > 0 && (
          <section id="sales-now">
            <div className="row spread" style={{ marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>Sales Taking Orders</h2>
              <Link href="/orders" className="small">
                Order Flow →
              </Link>
            </div>
            <div className="grid">
              {sales.slice(0, 6).map((a) => (
                <SaleTile key={a.id} a={a} />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
