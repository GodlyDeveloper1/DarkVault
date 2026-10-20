"use client";

// Start a batch sale (the Order Flow market). No account: the seller's browser
// makes a key that travels only after the # of their own link.
//
// A sale offers several identical units, and every unit is digital: a code, a
// key, a link, a line of text. The seller writes one per line. Each line is
// encrypted here, in the browser, with a key of its own, so handing one buyer
// their unit's key opens nobody else's. The site gets the ciphertexts and a
// hash of each key.
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  BATCH_MAX_ORDER,
  BATCH_MAX_UNITS,
  BATCH_MIN_UNITS,
  MIN_BID,
  bondFor,
  encryptLot,
  formatCoins,
  lotKeyHash,
  manageToken,
  newNonce,
  parseCoins,
  sellerKeys,
  sha256Hex,
  toBase64,
  unitLotKey,
} from "vault-core";
import BondFixed from "@/app/components/BondFixed";
import PhotoPicker from "@/app/components/PhotoPicker";
import Qr from "@/app/components/Qr";
import type { PickedPhoto } from "@/lib/photoClient";
import { addressProblem } from "@/lib/wallet";

const DURATIONS: [string, number][] = [
  ["15 minutes", 15 * 60],
  ["30 minutes", 30 * 60],
  ["1 hour", 3600],
  ["6 hours", 6 * 3600],
  ["1 day", 86400],
  ["3 days", 3 * 86400],
  ["7 days", 7 * 86400],
];
const REVEALS: [string, number][] = [
  ["5 minutes", 5 * 60],
  ["15 minutes", 15 * 60],
  ["30 minutes", 30 * 60],
  ["1 hour", 3600],
  ["6 hours", 6 * 3600],
];
const WINDOWS: [string, number][] = [
  ["1 hour", 3600],
  ["1 day", 86400],
  ["3 days", 3 * 86400],
  ["7 days", 7 * 86400],
  ["14 days", 14 * 86400],
];
/** One unit is a code, a key or a short text. */
const MAX_UNIT_BYTES = 60 * 1024;

export default function NewSale() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [lines, setLines] = useState("");
  const [price, setPrice] = useState("0.01");
  const [deliverIn, setDeliverIn] = useState(86400);
  const [disputeIn, setDisputeIn] = useState(86400);
  const [duration, setDuration] = useState(3600);
  const [reveal, setReveal] = useState(15 * 60);
  // The seller's bond for the whole sale is fixed: one unit's bond for each unit.
  const [bondPercent, setBondPercent] = useState(10);
  const [payout, setPayout] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; key: string; bond: number; units: number } | null>(null);
  const [copied, setCopied] = useState<"sale" | "seller" | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((b) => {
        if (typeof b.bond_percent === "number") setBondPercent(b.bond_percent);
      })
      .catch(() => {});
  }, []);

  // One unit per line. Empty lines are not units.
  const units = lines
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const unitsProblem =
    units.length === 0
      ? "Write what each buyer receives, one unit per line."
      : units.length < BATCH_MIN_UNITS
        ? `A sale offers at least ${BATCH_MIN_UNITS} units. For one item, list an auction.`
        : units.length > BATCH_MAX_UNITS
          ? `A sale offers at most ${BATCH_MAX_UNITS} units. You have ${units.length} lines.`
          : units.some((u) => new TextEncoder().encode(u).length > MAX_UNIT_BYTES)
            ? "One of the lines is larger than 60 KB."
            : new Set(units).size !== units.length
              ? "Two lines are the same. Every buyer must receive a unit of their own."
              : null;
  const priceZat = parseCoins(price);
  const priceProblem =
    priceZat === null ? "Enter an amount like 0.01." : priceZat < MIN_BID ? `The lowest price must be at least ${formatCoins(MIN_BID)} TAZ.` : priceZat > BATCH_MAX_ORDER ? "That is more than one order can be." : null;
  const count = unitsProblem ? 0 : units.length;
  const perUnit = priceZat !== null && !priceProblem ? bondFor(priceZat, bondPercent) : 0;
  const minBond = perUnit * Math.max(count, BATCH_MIN_UNITS);
  const bondZat = minBond;
  const payoutProblem = addressProblem(payout);
  const ready = title.trim().length >= 3 && !unitsProblem && priceZat !== null && !priceProblem && payout.trim().length > 20 && !payoutProblem && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || priceZat === null) return;
    setBusy(true);
    setError(null);
    try {
      const key = newNonce();
      // Everything below is made from that key, here in the browser.
      const keys = await sellerKeys(key);
      const lots: { key_hash: string; lot: string }[] = [];
      for (let i = 0; i < units.length; i++) {
        const unitKey = await unitLotKey(key, i);
        lots.push({ key_hash: await lotKeyHash(unitKey), lot: toBase64(await encryptLot(unitKey, { kind: "text" }, new TextEncoder().encode(units[i]!))) });
      }
      const res = await fetch("/api/auctions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          ...(photos.length ? { photos: photos.map((p) => toBase64(p.bytes)) } : {}),
          reserve: priceZat,
          duration_seconds: duration,
          reveal_seconds: reveal,
          payout_address: payout.trim(),
          manage_key_hash: await sha256Hex(await manageToken(key)),
          delivery: { kind: "digital", seller_pub: keys.publicKey, deliver_seconds: deliverIn, dispute_seconds: disputeIn, seller_bond: bondZat ?? minBond },
          batch: { lots },
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "the sale could not be started");
      try {
        localStorage.setItem(`dv-manage-${body.auction.id}`, key);
      } catch {
        /* the link below still works */
      }
      setMade({ id: body.auction.id, key, bond: body.auction.state === "funding" ? (bondZat ?? minBond) : 0, units: units.length });
      window.scrollTo({ top: 0 });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(m.charAt(0).toUpperCase() + m.slice(1));
    } finally {
      setBusy(false);
    }
  }

  if (made) {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const saleLink = `${origin}/orders/${made.id}`;
    const sellerLink = `${origin}/orders/${made.id}#manage=${made.key}`;
    return (
      <main>
        <div className="shell narrow">
          <p className="kicker">{made.bond > 0 ? "One Step Left: Fund Your Bond" : "Your Sale Is Open"}</p>
          <h1 style={{ fontSize: "clamp(1.9rem, 4.5vw, 3rem)" }}>{title.trim()}</h1>
          {made.bond > 0 && (
            <div className="card accent" id="bond-next">
              <h3>Orders Open When Your Bond Arrives</h3>
              <p className="small" style={{ margin: 0 }}>
                Save your seller link below, then press <strong>Open The Sale</strong>. The page shows where to send your bond of{" "}
                <strong>{formatCoins(made.bond)} TAZ</strong>, for all {made.units} units. The sale&apos;s time starts when it arrives, not now.
              </p>
            </div>
          )}
          <div className="card accent" id="share-made">
            <h3>Share This Link With Buyers</h3>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <Qr value={saleLink} size={150} />
              <div className="grow">
                <div className="addr" id="public-link">
                  {saleLink}
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    id="copy-share"
                    onClick={() => {
                      void navigator.clipboard?.writeText(saleLink);
                      setCopied("sale");
                    }}
                  >
                    {copied === "sale" ? "Copied" : "Copy The Link"}
                  </button>
                </div>
                <p className="hint">The sale is also listed on the Order Flow page. The QR code holds the same link.</p>
              </div>
            </div>
          </div>
          <div className="card warn">
            <h3>Keep This Link For Yourself</h3>
            <p className="small">
              It opens the same page with your seller view. <strong>You need it to get paid:</strong> after the sale closes, open it and your browser
              sends each buyer the key to their unit. Each unit&apos;s price is released to you once its buyer has it. The part after the # never
              leaves your browser, and we can&apos;t recover it. <strong>Never share this link.</strong>
            </p>
            <div className="addr" id="manage-link">
              {sellerLink}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(sellerLink);
                  setCopied("seller");
                }}
              >
                {copied === "seller" ? "Copied" : "Copy My Seller Link"}
              </button>
              <Link className="btn primary" id="open-sale" href={`/orders/${made.id}#manage=${made.key}`}>
                Open The Sale →
              </Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="shell narrow">
        <p className="kicker">Order Flow</p>
        <h1 style={{ fontSize: "clamp(1.9rem, 4.5vw, 3rem)" }}>Start A Sale</h1>
        <p className="muted">
          Sell several identical units at once: licence keys, invite codes, tickets. Buyers send sealed orders, one order for one unit. The
          highest orders win, and each buyer pays what they offered.
        </p>
        <form onSubmit={submit} className="card" id="sale-form">
          <label htmlFor="title" style={{ marginTop: 0 }}>
            What Are You Selling?
          </label>
          <input id="title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Licence keys for a font family" />

          <label htmlFor="description">Description</label>
          <textarea id="description" value={description} maxLength={1200} onChange={(e) => setDescription(e.target.value)} placeholder="What one unit is, and anything a buyer should know. Every unit must match this." />

          <PhotoPicker photos={photos} onChange={setPhotos} sealed={false} />

          <label htmlFor="units">The Units, One Per Line</label>
          <textarea
            id="units"
            className="mono units-box"
            value={lines}
            onChange={(e) => setLines(e.target.value)}
            spellCheck={false}
            placeholder={"KEY-AAAA-1111\nKEY-BBBB-2222\nKEY-CCCC-3333"}
          />
          <p className={unitsProblem && lines.trim() !== "" ? "hint error" : "hint"} id="units-count">
            {unitsProblem && lines.trim() !== "" ? (
              unitsProblem
            ) : (
              <>
                {count > 0 && (
                  <>
                    <strong>
                      {count} {count === 1 ? "Unit" : "Units"}.
                    </strong>{" "}
                  </>
                )}
                Each line is what one buyer receives: a code, a key, a link. {BATCH_MIN_UNITS} to {BATCH_MAX_UNITS} lines. Each is encrypted in your
                browser with a key of its own before it is sent. The site stores them but can&apos;t read them, and no buyer can open another&apos;s.
              </>
            )}
          </p>

          <label htmlFor="price">Lowest Price For One Unit (TAZ)</label>
          <input id="price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          <p className={priceProblem ? "hint error" : "hint"} id="price-effect">
            {priceProblem ??
              `The least you'll accept for a unit. It is public, and no order below it can win. The highest orders win a unit each, and each buyer pays what they offered${
                perUnit > 0 ? `, plus a bond of ${formatCoins(perUnit)} TAZ that comes back to them` : ""
              }.`}
          </p>

          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="grow">
              <label htmlFor="deliver-in">You Hand Over Each Key Within</label>
              <select id="deliver-in" value={deliverIn} onChange={(e) => setDeliverIn(Number(e.target.value))}>
                {WINDOWS.map(([label, s]) => (
                  <option key={s} value={s}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grow">
              <label htmlFor="dispute-in">A Buyer Can Open A Dispute For</label>
              <select id="dispute-in" value={disputeIn} onChange={(e) => setDisputeIn(Number(e.target.value))}>
                {WINDOWS.map(([label, s]) => (
                  <option key={s} value={s}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="hint">
            Each price is held until that unit&apos;s handover. Open your seller link after the close and your browser sends every key by itself.
            You are paid for a unit when its buyer confirms, or when their time to complain runs out.
          </p>

          {perUnit > 0 && (
            <>
              <span className="label-like">Your Bond, For The Whole Sale</span>
              <BondFixed amount={minBond} of="the lowest price" each={perUnit} units={Math.max(count, BATCH_MIN_UNITS)} />
              <p className="hint" id="bond-effect">
                {`A deposit you make before orders open: ${formatCoins(perUnit)} TAZ for each unit. The share of every unit that doesn't sell comes straight back, and each sold unit's share comes back with its payment. You lose a unit's share to its buyer if you don't hand that unit over or lose a dispute about it. Anything you send above it comes straight back.`}
              </p>
            </>
          )}

          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="grow">
              <label htmlFor="duration">Orders Are Taken For</label>
              <select id="duration" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {DURATIONS.map(([label, s]) => (
                  <option key={s} value={s}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grow">
              <label htmlFor="reveal">Backup Window</label>
              <select id="reveal" value={reveal} onChange={(e) => setReveal(Number(e.target.value))}>
                {REVEALS.map(([label, s]) => (
                  <option key={s} value={s}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="hint">Orders open by themselves when the sale closes. This window is only used if that fails.</p>
            </div>
          </div>

          <label htmlFor="payout">Your Shielded Payout Address</label>
          <input id="payout" className="mono" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="utest1…" spellCheck={false} autoComplete="off" />
          <p className={payoutProblem ? "hint error" : "hint"}>{payoutProblem ?? "A fresh unified address from your testnet wallet. Only this site sees it; it is never published."}</p>

          {error && <p className="error">{error}</p>}
          <div className="row" style={{ marginTop: 20 }}>
            <button className="primary lg" id="start-sale" disabled={!ready}>
              {busy ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Opening The Vault…
                </>
              ) : (
                "Start The Sale"
              )}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
