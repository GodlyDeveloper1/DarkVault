// The site's own addresses: never a refund or payout address.
//
// Found on testnet: a buyer pasted the address the page asked them to pay
// (the auction's escrow address) into the refund field. The site accepted it,
// so the money meant to come back went into the site's own escrow instead.
// Every address the site hands out is in a record (a bid's deposit address, a
// sale's escrow address) or in the house purse (its slots), so a refund or
// payout address is checked against all of them before it is accepted.

import { readPurse } from "./house/purse";
import { listRecords } from "./store";

export const OWN_ADDRESS =
  "that is one of this site's own addresses (one it asked someone to pay). Use your own wallet's address, the one your wallet shows when you press Receive.";

/** Every address this site has handed out for someone to pay into. */
async function siteAddresses(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const r of await listRecords()) {
    for (const b of r.bids) if (b.deposit_address) out.add(b.deposit_address);
    if (r.delivery?.escrow_address) out.add(r.delivery.escrow_address);
  }
  try {
    const purse = await readPurse();
    for (const s of purse.slots) out.add(s.address);
  } catch {
    /* no house purse on this site */
  }
  return out;
}

/** True if `address` is one the site handed out (compared without spaces). */
export async function isSiteAddress(address: string): Promise<boolean> {
  const a = address.trim();
  if (a === "") return false;
  return (await siteAddresses()).has(a);
}
