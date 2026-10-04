import { notFound } from "next/navigation";
import { advance } from "@/lib/engine";
import { infosFor, publicView } from "@/lib/views";
import AuctionRoom from "./AuctionRoom";
import PrivateGate from "./PrivateGate";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auction = await advance(id);
  // A private auction's real title is encrypted; the page's name gives nothing away.
  return { title: auction ? auction.title : "Auction not found" };
}

export default async function AuctionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auction = await advance(id);
  if (!auction) notFound();
  // Nothing about a private auction is sent with the page. Whether this
  // browser was invited is settled in the browser (see PrivateGate).
  if (auction.private)
    return (
      <main>
        <div className="shell">
          <PrivateGate id={id} />
        </div>
      </main>
    );
  const infos = await infosFor(auction);
  return (
    <main>
      <div className="shell">
        <AuctionRoom initial={publicView(auction, infos)} serverNow={Date.now()} />
      </div>
    </main>
  );
}
