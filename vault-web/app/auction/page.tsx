import { redirect } from "next/navigation";

// An auction's own page is /auction/ITS-ID. Without an id, this is the list.
export default function AuctionIndex() {
  redirect("/auctions");
}
