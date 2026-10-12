// List auctions (public view) and create one. A private deal (the Settlement
// market) is created here too: it is the same record with a fixed price and
// no bidding. So is a batch sale (the Order Flow market): the same record
// with several units, each with an encrypted lot of its own.
import { BATCH_MAX_ORDER, BATCH_MAX_UNITS, BATCH_MIN_UNITS, MAX_PHOTOS, MIN_BOND, PHOTO_MAX_BYTES, SEALED_PHOTO_BYTES, bondFor, cleanJpeg, fromBase64, validSealedListing } from "vault-core";
import { DEAL_TITLE, PRIVATE_TITLE } from "@/lib/access";
import { bad, clientKey, limited, ok, readJson, tooMany } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { createListing } from "@/lib/listing";
import { checkAddress, SignerError } from "@/lib/signer";
import { isSiteAddress, OWN_ADDRESS } from "@/lib/siteAddresses";
import { listAuctions } from "@/lib/store";
import type { Delivery } from "@/lib/types";
import { infosFor, listed, listedSales, publicView } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // ?market=orders lists the batch sales (Order Flow) in place of the auctions.
  const all = await listAuctions();
  const auctions = new URL(req.url).searchParams.get("market") === "orders" ? listedSales(all) : listed(all);
  const views = await Promise.all(
    auctions.map(async (a) => publicView(a, await infosFor(a))),
  );
  return ok({ auctions: views });
}

export async function POST(req: Request) {
  const wait = limited("create", clientKey(req), 5, 3600_000);
  if (wait) return tooMany(wait, "new auctions");

  // Large enough for an encrypted lot of 1 MB and three photos, as base64.
  const body = await readJson(req, 3_000_000);
  if (!body) return bad("invalid request, or the lot is larger than 1 MB");

  // A private auction: the title and description arrive encrypted (the
  // seller's browser did it, and the site can't open them), with the hash of
  // the token invited browsers will show. Nothing readable is taken from the
  // request in their place.
  let hidden: { listing: string; access_hash: string } | null = null;
  if (body.private !== undefined) {
    const p = body.private as Record<string, unknown> | null;
    if (!p || typeof p !== "object") return bad("invalid private listing");
    if (!validSealedListing(p.listing)) return bad("the encrypted listing is not valid");
    if (typeof p.access_hash !== "string" || !/^[0-9a-f]{64}$/.test(p.access_hash)) return bad("invalid invite");
    if (body.title !== undefined || body.description !== undefined) return bad("a private auction sends no readable title or description");
    hidden = { listing: p.listing, access_hash: p.access_hash };
  }
  // A deal: two people settling a price they already agreed. Always private, always with a handover.
  let deal: { public_price: boolean } | null = null;
  if (body.deal !== undefined) {
    const d = body.deal as Record<string, unknown> | null;
    if (!d || typeof d !== "object") return bad("invalid deal");
    if (!hidden) return bad("a deal's terms are sent encrypted");
    if (body.delivery === undefined) return bad("a deal needs a handover: digital, physical or a promise");
    if (body.ceiling !== undefined && body.ceiling !== null) return bad("a deal has one price");
    deal = { public_price: d.public_price === true };
  }
  // A batch sale: several identical units, one sealed order per unit. Public, and every unit is digital.
  let batch: { lots: { key_hash: string; bytes: Uint8Array }[] } | null = null;
  if (body.batch !== undefined) {
    const b = body.batch as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || !Array.isArray(b.lots)) return bad("invalid batch sale");
    if (hidden || deal) return bad("a batch sale is public");
    if (body.ceiling !== undefined && body.ceiling !== null) return bad("a batch sale has no highest order");
    if (b.lots.length < BATCH_MIN_UNITS || b.lots.length > BATCH_MAX_UNITS) return bad(`a batch sale offers ${BATCH_MIN_UNITS} to ${BATCH_MAX_UNITS} units`);
    const lots: { key_hash: string; bytes: Uint8Array }[] = [];
    let total = 0;
    for (const raw of b.lots as unknown[]) {
      const u = raw as Record<string, unknown> | null;
      if (!u || typeof u !== "object" || typeof u.key_hash !== "string" || !/^[0-9a-f]{64}$/.test(u.key_hash)) return bad("invalid unit key hash");
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(typeof u.lot === "string" ? u.lot : "!");
      } catch {
        return bad("an encrypted unit is not valid");
      }
      // 12 bytes of nonce, a 4-byte header length, at least one byte of content, a 16-byte tag.
      if (bytes.length < 33 || bytes.length > LIMITS.maxUnitLotBytes) return bad(`an encrypted unit is empty or larger than ${Math.floor(LIMITS.maxUnitLotBytes / 1024)} KB`);
      total += bytes.length;
      lots.push({ key_hash: u.key_hash, bytes });
    }
    if (total > LIMITS.maxLotBytes) return bad("the units together are larger than 1 MB");
    // Every unit has a key of its own: the same key twice would let one buyer open another's unit.
    if (new Set(lots.map((l) => l.key_hash)).size !== lots.length) return bad("two units have the same key");
    batch = { lots };
  }
  // Listing photos. A public one must be a JPEG with no camera details left in
  // it (the seller's browser redraws every photo); a private one arrives
  // encrypted, all the same size, and can't be checked here.
  const photos: Uint8Array[] = [];
  if (body.photos !== undefined) {
    if (!Array.isArray(body.photos) || body.photos.length > MAX_PHOTOS) return bad(`a listing can have at most ${MAX_PHOTOS} photos`);
    for (const raw of body.photos as unknown[]) {
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(typeof raw === "string" ? raw : "!");
      } catch {
        return bad("a photo is not valid");
      }
      if (hidden) {
        if (bytes.length !== SEALED_PHOTO_BYTES) return bad("an encrypted photo is not valid");
      } else if (!cleanJpeg(bytes)) {
        return bad(`a photo must be a JPEG of at most ${Math.round(PHOTO_MAX_BYTES / 1000)} KB, with no camera details in it; please pick it again`);
      }
      photos.push(bytes);
    }
  }
  const units = batch?.lots.length ?? 1;
  const title = hidden ? (deal ? DEAL_TITLE : PRIVATE_TITLE) : typeof body.title === "string" ? body.title.trim() : "";
  const description = hidden ? "" : typeof body.description === "string" ? body.description.trim() : "";
  const reserve = body.reserve;
  const durationSec = body.duration_seconds;
  // A deal has nothing to reveal.
  const revealSec = deal ? LIMITS.minRevealSec : body.reveal_seconds;
  const payout = typeof body.payout_address === "string" ? body.payout_address.trim() : "";
  const keyHash = typeof body.manage_key_hash === "string" ? body.manage_key_hash : "";

  if (title.length < 3 || title.length > LIMITS.titleMax) return bad(`the title needs 3 to ${LIMITS.titleMax} characters`);
  if (description.length > LIMITS.descriptionMax) return bad(`the description can have at most ${LIMITS.descriptionMax} characters`);
  if (typeof reserve !== "number" || !Number.isSafeInteger(reserve) || reserve < LIMITS.minReserve)
    return bad(`the ${deal ? "price" : "reserve"} must be at least ${LIMITS.minReserve} zatoshis`);
  // A listing normally has no highest bid: a bidder deposits their bid plus the bond.
  // One sent with a ceiling is an auction with same-size deposits: every bidder deposits the ceiling plus the bond.
  const ceiling: number | undefined = body.ceiling === undefined || body.ceiling === null ? undefined : (body.ceiling as number);
  if (ceiling !== undefined && (typeof ceiling !== "number" || !Number.isSafeInteger(ceiling) || ceiling < reserve || ceiling > reserve * LIMITS.maxCeilingMultiple || ceiling > LIMITS.maxAmount))
    return bad(`the highest bid allowed must be between the reserve and ${LIMITS.maxCeilingMultiple} times the reserve`);
  if (reserve > LIMITS.maxAmount) return bad(`the ${deal ? "price" : "reserve"} is too high`);
  if (batch && reserve > BATCH_MAX_ORDER) return bad("the lowest price is too high");
  if (deal && (typeof durationSec !== "number" || !Number.isInteger(durationSec) || durationSec < LIMITS.minDurationSec || durationSec > LIMITS.maxDealOfferSec))
    return bad(`a deal's offer stands between ${Math.ceil(LIMITS.minDurationSec / 60)} minutes and ${LIMITS.maxDealOfferSec / 86400} days`);
  if (!deal && (typeof durationSec !== "number" || !Number.isInteger(durationSec) || durationSec < LIMITS.minDurationSec || durationSec > LIMITS.maxDurationSec))
    return bad(`an auction runs between ${Math.ceil(LIMITS.minDurationSec / 60)} minutes and ${LIMITS.maxDurationSec / 86400} days`);
  if (typeof revealSec !== "number" || !Number.isInteger(revealSec) || revealSec < LIMITS.minRevealSec || revealSec > LIMITS.maxRevealSec)
    return bad(`the reveal window is between ${Math.ceil(LIMITS.minRevealSec / 60)} minutes and 24 hours`);
  if (!/^[0-9a-f]{64}$/.test(keyHash)) return bad("invalid manage key");
  if (payout.length < 20 || payout.length > 600) return bad("please give a shielded payout address");

  // Delivery: how the lot reaches the winner. With it, the price is held until the handover.
  let delivery: Omit<Delivery, "escrow_vault_id" | "escrow_address"> | null = null;
  let lot: Uint8Array | null = null;
  if (body.delivery !== undefined) {
    const d = body.delivery as Record<string, unknown> | null;
    if (!d || typeof d !== "object") return bad("invalid delivery");
    if (d.kind !== "digital" && d.kind !== "physical" && d.kind !== "promise") return bad("the lot must be digital, physical or a promise");
    if (typeof d.seller_pub !== "string" || !/^[0-9a-f]{64}$/.test(d.seller_pub)) return bad("invalid seller key");
    const within = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= LIMITS.minDeliverySec && v <= LIMITS.maxDeliverySec;
    if (!within(d.deliver_seconds) || !within(d.dispute_seconds))
      return bad(`delivery time limits are between ${Math.ceil(LIMITS.minDeliverySec / 60)} minutes and ${LIMITS.maxDeliverySec / 86400} days`);
    // Bonds are fixed, the same rule for both sides: 10% of the reserve (a
    // deal's price, a batch sale's lowest unit price), never under MIN_BOND.
    // A seller can't choose a bigger or smaller one; a seller_bond sent with
    // the listing is ignored. A batch sale's seller puts down one bond per unit.
    const minBond = typeof reserve === "number" ? bondFor(reserve, LIMITS.bondPercent) : 0;
    const sellerBond = minBond * units;
    if (minBond > LIMITS.maxSellerBond) return bad(`the ${deal ? "price" : batch ? "lowest price" : "reserve"} is higher than this site takes: its bond would be more than ${LIMITS.maxSellerBond} zatoshis`);
    if (typeof sellerBond !== "number" || !Number.isSafeInteger(sellerBond) || sellerBond < minBond * units)
      return bad(`the seller's bond must be at least ${minBond * units} zatoshis`);
    if (sellerBond > LIMITS.maxSellerBond * units) return bad(`the seller's bond can be at most ${LIMITS.maxSellerBond * units} zatoshis`);
    // A bond is either nothing or enough to be moved: a smaller one could never be paid back, or shared between units.
    if (sellerBond !== 0 && sellerBond < MIN_BOND * units) return bad(`a seller's bond, if there is one, must be at least ${MIN_BOND * units} zatoshis`);
    if (batch && (d.kind !== "digital" || d.key_hash !== undefined || d.lot !== undefined)) return bad("every unit of a batch sale is digital, with a key of its own");
    delivery = {
      kind: d.kind,
      seller_pub: d.seller_pub,
      deliver_seconds: d.deliver_seconds,
      dispute_seconds: d.dispute_seconds,
      seller_bond: sellerBond,
      buyer_bond: minBond,
    };
    if (d.kind === "digital" && !batch) {
      if (typeof d.key_hash !== "string" || !/^[0-9a-f]{64}$/.test(d.key_hash)) return bad("invalid lot key hash");
      try {
        lot = fromBase64(typeof d.lot === "string" ? d.lot : "!");
      } catch {
        return bad("the encrypted lot is not valid");
      }
      // 12 bytes of nonce, a 4-byte header length, at least one byte of content, a 16-byte tag.
      if (lot.length < 33 || lot.length > LIMITS.maxLotBytes) return bad("the encrypted lot is empty or larger than 1 MB");
      delivery!.lot = { key_hash: d.key_hash, bytes: lot.length };
    }
  }

  if (batch && !delivery) return bad("a batch sale needs its handover time limits");

  if (await isSiteAddress(payout)) return bad(`payout address: ${OWN_ADDRESS}`);
  try {
    const check = await checkAddress(payout);
    if (!check.ok) return bad(`payout address: ${check.reason}`);
    const auction = await createListing({
      title,
      description,
      reserve,
      ceiling,
      durationSec: durationSec as number,
      revealSec: revealSec as number,
      payout,
      keyHash,
      delivery,
      lot,
      ...(hidden ? { private: hidden } : {}),
      ...(deal ? { deal: { price: reserve, public_price: deal.public_price } } : {}),
      ...(batch ? { unitLots: batch.lots } : {}),
      ...(photos.length ? { photos } : {}),
    });
    return ok({ auction: publicView(auction, { info: null, escrow: null, site_key: null }) }, 201);
  } catch (e) {
    if (e instanceof SignerError) return bad(e.status === 503 ? e.message : "the signer could not open a vault for this auction", 503);
    return bad("could not create the auction", 500);
  }
}
