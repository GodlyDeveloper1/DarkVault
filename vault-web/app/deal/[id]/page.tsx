import { notFound, redirect } from "next/navigation";
import PrivateGate from "@/app/auction/[id]/PrivateGate";
import { advance } from "@/lib/engine";

export const dynamic = "force-dynamic";
// The real title is in the encrypted terms; the page's name gives nothing away.
export const metadata = { title: "Private" };

// A private deal. Nothing about it is sent with the page: whether this browser
// holds the link is settled in the browser (see PrivateGate), and only then is
// the deal fetched, with its terms still encrypted.
//
// This address and /auction/[id] answer alike for every private record, deal
// or auction, so a locked page doesn't say which it is.
export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auction = /^[0-9a-f]{32}$/.test(id) ? await advance(id) : null;
  if (!auction) notFound();
  // Not a deal: straight to its own address (a batch sale's room, or the auction's).
  if (!auction.private) redirect(auction.batch ? `/orders/${id}` : `/auction/${id}`);
  return (
    <main>
      <div className="shell">
        <PrivateGate id={id} />
      </div>
    </main>
  );
}
