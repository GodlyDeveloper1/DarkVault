// List auctions (public view) and create one.
import { bondFor, fromBase64, newId } from "vault-core";
import { advance } from "@/lib/engine";
import { bad, clientKey, limited, ok, readJson, tooMany } from "@/lib/http";
import { LIMITS } from "@/lib/limits";
import { checkAddress, createVault, newDepositAddress, SignerError } from "@/lib/signer";
import { createAuction, listAuctions, saveLot } from "@/lib/store";
import type { Delivery } from "@/lib/types";
import { infosFor, publicView } from "@/lib/views";

export const dynamic = "force-dynamic";

export async function GET() {
  const auctions = (await listAuctions()).filter((a) => a.state !== "funding" && !a.outcome?.cancelled);
  const views = await Promise.all(
    auctions.map(async (a) => publicView(a, await infosFor(a))),
  );
  return ok({ auctions: views });
}

export async function POST(req: Request) {
  const wait = limited("create", clientKey(req), 5, 3600_000);
  if (wait) return tooMany(wait, "new auctions");

  // Large enough for an encrypted lot of 1 MB, as base64.
  const body = await readJson(req, 1_450_000);
  if (!body) return bad("invalid request, or the lot is larger than 1 MB");

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const reserve = body.reserve;
  const durationSec = body.duration_seconds;
  const revealSec = body.reveal_seconds;
  const payout = typeof body.payout_address === "string" ? body.payout_address.trim() : "";
  const keyHash = typeof body.manage_key_hash === "string" ? body.manage_key_hash : "";

  if (title.length < 3 || title.length > LIMITS.titleMax) return bad(`the title needs 3 to ${LIMITS.titleMax} characters`);
  if (description.length > LIMITS.descriptionMax) return bad(`the description can have at most ${LIMITS.descriptionMax} characters`);
  if (typeof reserve !== "number" || !Number.isSafeInteger(reserve) || reserve < LIMITS.minReserve)
    return bad(`the reserve must be at least ${LIMITS.minReserve} zatoshis`);
  if (typeof durationSec !== "number" || !Number.isInteger(durationSec) || durationSec < LIMITS.minDurationSec || durationSec > LIMITS.maxDurationSec)
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
    // Bonds. The buyer's is fixed by the reserve; the seller may stake more than the minimum, never less.
    const minBond = typeof reserve === "number" ? bondFor(reserve, LIMITS.bondPercent) : 0;
    const sellerBond = d.seller_bond === undefined ? minBond : d.seller_bond;
    if (typeof sellerBond !== "number" || !Number.isSafeInteger(sellerBond) || sellerBond < minBond || sellerBond > LIMITS.maxSellerBond)
      return bad(`the seller's bond must be at least ${minBond} zatoshis`);
    delivery = {
      kind: d.kind,
      seller_pub: d.seller_pub,
      deliver_seconds: d.deliver_seconds,
      dispute_seconds: d.dispute_seconds,
      seller_bond: sellerBond,
      buyer_bond: minBond,
    };
    if (d.kind === "digital") {
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

  try {
    const check = await checkAddress(payout);
    if (!check.ok) return bad(`payout address: ${check.reason}`);
    const vault = await createVault();
    const now = Date.now();
    const id = newId();
    // A second vault for this auction: it holds the price between the sale and the handover.
    let escrow: Pick<Delivery, "escrow_vault_id" | "escrow_address"> | null = null;
    if (delivery) {
      const held = await createVault();
      escrow = { escrow_vault_id: held.vault_id, escrow_address: await newDepositAddress(held.vault_id) };
    }
    if (lot) await saveLot(id, lot);
    await createAuction({
      id,
      created_at: now,
      title,
      description,
      reserve,
      ends_at: now + durationSec * 1000,
      duration_seconds: durationSec,
      reveal_seconds: revealSec,
      seller: { payout_address: payout, key_hash: keyHash },
      vault_id: vault.vault_id,
      ...(delivery && escrow ? { delivery: { ...delivery, ...escrow } } : {}),
      // With a bond, bidding opens when the seller's bond has arrived.
      state: delivery && delivery.seller_bond > 0 ? "funding" : "open",
      bids: [],
      settlements: [],
    });
    const auction = await advance(id, true);
    return ok({ auction: publicView(auction!, { info: null, escrow: null }) }, 201);
  } catch (e) {
    if (e instanceof SignerError) return bad(e.status === 503 ? e.message : "the signer could not open a vault for this auction", 503);
    return bad("could not create the auction", 500);
  }
}
