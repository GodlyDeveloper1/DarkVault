import { notFound } from "next/navigation";
import { advance } from "@/lib/engine";
import { infosFor, publicView } from "@/lib/views";
import AuctionRoom from "./AuctionRoom";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auction = await advance(id);
  return { title: auction ? auction.title : "Auction not found" };
}

export default async function AuctionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auction = await advance(id);
  if (!auction) notFound();
  const infos = await infosFor(auction);
  return (
    <main>
      <div className="shell">
        <AuctionRoom initial={publicView(auction, infos)} serverNow={Date.now()} />
      </div>
    </main>
  );
}
