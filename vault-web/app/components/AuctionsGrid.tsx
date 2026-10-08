import Link from "next/link";
import { listAuctions } from "@/lib/store";
import { infosFor, listed, listedSales, publicView, type PublicAuction } from "@/lib/views";
import AuctionTile from "./AuctionTile";

/** Every listed auction as the public sees it, open ones first. */
export async function loadListed(): Promise<PublicAuction[]> {
  const auctions = await Promise.all(
    // A listing shows once the seller's bond has arrived: an unfunded one is not an auction yet.
    listed(await listAuctions()).map(async (a) => publicView(a, await infosFor(a))),
  );
  const rank = { open: 0, revealing: 1, settling: 2, delivering: 3, funding: 4, settled: 5 } as const;
  return auctions.sort((a, b) => rank[a.state] - rank[b.state] || b.created_at - a.created_at);
}

/** Every batch sale (the Order Flow market) as the public sees it, open ones first. */
export async function loadSales(): Promise<PublicAuction[]> {
  const sales = await Promise.all(listedSales(await listAuctions()).map(async (a) => publicView(a, await infosFor(a))));
  const rank = { open: 0, revealing: 1, settling: 2, delivering: 3, funding: 4, settled: 5 } as const;
  return sales.sort((a, b) => rank[a.state] - rank[b.state] || b.created_at - a.created_at);
}

// The auctions as tiles. Used by the home page, /auctions and the dashboard.
// A page that has already loaded them (to count them, say) passes them in.
export default async function AuctionsGrid({ auctions, limit, empty }: { auctions?: PublicAuction[]; limit?: number; empty?: string }) {
  const all = auctions ?? (await loadListed());
  const shown = limit ? all.slice(0, limit) : all;

  if (shown.length === 0) {
    return (
      <div className="card">
        <p style={{ margin: 0 }}>
          {empty ?? "No auctions yet."} <Link href="/sell">List the first lot.</Link>
        </p>
      </div>
    );
  }
  return (
    <div className="grid">
      {shown.map((a) => (
        <AuctionTile key={a.id} a={a} />
      ))}
    </div>
  );
}
