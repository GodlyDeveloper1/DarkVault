// Opening an auction: its vaults, its record, its time lock. Used by the sell
// form's route and by the house, which lists practice auctions itself.
// The caller has already checked the values.
import "server-only";
import { newId } from "vault-core";
import { advance, lockInTime } from "./engine";
import { createVault, newDepositAddress } from "./signer";
import { createAuction, saveLot, saveUnitLot } from "./store";
import type { Auction, Delivery } from "./types";

export interface Listing {
  title: string;
  description: string;
  reserve: number;
  /** The highest bid allowed, for an auction with same-size deposits. Left out, a deposit is the bid plus the bond and there is no highest bid. */
  ceiling?: number;
  durationSec: number;
  revealSec: number;
  payout: string;
  /** Hash of the seller's manage token. */
  keyHash: string;
  delivery: Omit<Delivery, "escrow_vault_id" | "escrow_address"> | null;
  /** The encrypted lot, for a digital delivery. */
  lot: Uint8Array | null;
  /** Set on practice auctions run by the site. */
  house?: Auction["house"];
  /** A private auction: the encrypted listing and the hash of the invite's access token. */
  private?: Auction["private"];
  /** A private deal (Settlement): a fixed price and no bidding. `reserve` is the price. */
  deal?: Auction["deal"];
  /** A batch sale (Order Flow): the encrypted lot of each unit, with the hash of its key. `reserve` is the lowest price per unit. */
  unitLots?: { key_hash: string; bytes: Uint8Array }[];
}

/** Opens the vaults and saves the auction. Throws SignerError if the signer can't be reached. */
export async function createListing(l: Listing): Promise<Auction> {
  const vault = await createVault();
  const now = Date.now();
  const id = newId();
  // A second vault for this auction: it holds the price between the sale and the handover.
  let escrow: Pick<Delivery, "escrow_vault_id" | "escrow_address"> | null = null;
  if (l.delivery) {
    const held = await createVault();
    escrow = { escrow_vault_id: held.vault_id, escrow_address: await newDepositAddress(held.vault_id) };
  }
  if (l.lot) await saveLot(id, l.lot);
  if (l.unitLots) for (let i = 0; i < l.unitLots.length; i++) await saveUnitLot(id, i, l.unitLots[i]!.bytes);
  const record: Auction = {
    id,
    created_at: now,
    title: l.title,
    description: l.description,
    // A deal has no sealed bids, so none of scheme 2 (commitments, time lock, proof) applies to it.
    ...(l.deal ? { deal: l.deal } : { scheme: 2 as const }),
    reserve: l.reserve,
    ...(l.ceiling != null ? { ceiling: l.ceiling } : {}),
    ends_at: now + l.durationSec * 1000,
    duration_seconds: l.durationSec,
    reveal_seconds: l.revealSec,
    seller: { payout_address: l.payout, key_hash: l.keyHash },
    vault_id: vault.vault_id,
    ...(l.delivery && escrow ? { delivery: { ...l.delivery, ...escrow } } : {}),
    ...(l.house ? { house: l.house } : {}),
    ...(l.private ? { private: l.private } : {}),
    ...(l.unitLots ? { batch: { units: l.unitLots.length, lots: l.unitLots.map((u) => ({ key_hash: u.key_hash, bytes: u.bytes.length })) } } : {}),
    // With a bond, bidding opens when the seller's bond has arrived.
    state: l.delivery && l.delivery.seller_bond > 0 ? "funding" : "open",
    bids: [],
    settlements: [],
  };
  // Bidding that opens now is locked in time now; with a bond, when the bond arrives.
  if (record.state === "open") await lockInTime(record);
  await createAuction(record);
  return (await advance(id, true))!;
}
