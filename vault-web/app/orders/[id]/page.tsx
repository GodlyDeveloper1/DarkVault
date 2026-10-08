import { notFound, redirect } from "next/navigation";
import { advance } from "@/lib/engine";
import { infosFor, publicView } from "@/lib/views";
import SaleRoom from "./SaleRoom";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sale = /^[0-9a-f]{32}$/.test(id) ? await advance(id) : null;
  return { title: sale?.batch ? sale.title : "Sale Not Found" };
}

// One batch sale (the Order Flow market). Anything else with this id is shown
// at its own address: an auction at /auction/[id], which also keeps the gate
// of everything private.
export default async function SalePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sale = /^[0-9a-f]{32}$/.test(id) ? await advance(id) : null;
  if (!sale) notFound();
  if (!sale.batch) redirect(`/auction/${id}`);
  return (
    <main>
      <div className="shell">
        <SaleRoom initial={publicView(sale, await infosFor(sale))} serverNow={Date.now()} />
      </div>
    </main>
  );
}
