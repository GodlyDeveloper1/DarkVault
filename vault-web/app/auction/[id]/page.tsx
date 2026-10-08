import { notFound, redirect } from "next/navigation";
import { advance } from "@/lib/engine";
import { infosFor, publicView } from "@/lib/views";
import AuctionRoom from "./AuctionRoom";
import PrivateGate from "./PrivateGate";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auction = await advance(id);
  // A private page's real title is encrypted; the page's name gives nothing away, not even whether it is an auction or a deal.
  return { title: auction ? (auction.private ? "Private" : auction.title) : "Auction not found" };
}

export default async function AuctionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auction = await advance(id);
  if (!auction) notFound();
  // Nothing about a private auction, or a private deal, is sent with the page.
  // Whether this browser was invited is settled in the browser (see PrivateGate).
  if (auction.private)
    return (
      <main>
        <div className="shell">
          <PrivateGate id={id} />
        </div>
      </main>
    );
  // A batch sale has a room of its own (the Order Flow market).
  if (auction.batch) redirect(`/orders/${id}`);
  const infos = await infosFor(auction);
  return (
    <main>
      <div className="shell">
        <AuctionRoom initial={publicView(auction, infos)} serverNow={Date.now()} />
      </div>
    </main>
  );
}
