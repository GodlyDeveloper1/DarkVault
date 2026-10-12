"use client";

// Create a private deal (the Settlement market). No account: the seller's
// browser makes a key that travels only after the # of their own link.
//
// The terms (what the deal is for, and what was agreed) are encrypted here,
// with a key that travels only in the link the seller sends the buyer. The
// site stores them unread. A digital item is encrypted here too. The site is
// told the price, the bonds and the time limits, because it runs the escrow.
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  MAX_LOT_BYTES,
  MIN_BID,
  bondFor,
  encryptListing,
  encryptLot,
  encryptPhoto,
  formatCoins,
  inviteAccess,
  inviteFromManage,
  lotKeyHash,
  manageToken,
  newNonce,
  parseCoins,
  sellerKeys,
  sha256Hex,
  toBase64,
} from "vault-core";
import BondFixed from "@/app/components/BondFixed";
import PhotoPicker from "@/app/components/PhotoPicker";
import Qr from "@/app/components/Qr";
import { rememberInvite } from "@/lib/invites";
import type { PickedPhoto } from "@/lib/photoClient";
import { addressProblem } from "@/lib/wallet";

const OFFERS: [string, number][] = [
  ["1 hour", 3600],
  ["6 hours", 6 * 3600],
  ["1 day", 86400],
  ["3 days", 3 * 86400],
  ["7 days", 7 * 86400],
];
const WINDOWS: [string, number][] = [
  ["1 hour", 3600],
  ["1 day", 86400],
  ["3 days", 3 * 86400],
  ["7 days", 7 * 86400],
  ["14 days", 14 * 86400],
];
type Kind = "digital" | "physical" | "promise";

export default function NewDeal() {
  const [title, setTitle] = useState("");
  const [terms, setTerms] = useState("");
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [price, setPrice] = useState("");
  const [kind, setKind] = useState<Kind>("digital");
  const [secret, setSecret] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [deliverIn, setDeliverIn] = useState(86400);
  const [disputeIn, setDisputeIn] = useState(86400);
  const [offer, setOffer] = useState(86400);
  const [bondPercent, setBondPercent] = useState(10);
  const [payout, setPayout] = useState("");
  const [showPrice, setShowPrice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; key: string; invite: string; bond: number } | null>(null);
  const [copied, setCopied] = useState<"deal" | "seller" | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((b) => {
        if (typeof b.bond_percent === "number") setBondPercent(b.bond_percent);
      })
      .catch(() => {});
  }, []);

  const priceZat = parseCoins(price);
  const priceProblem = price.trim() === "" ? null : priceZat === null ? "Enter an amount like 0.5." : priceZat < MIN_BID ? `The price must be at least ${formatCoins(MIN_BID)} TAZ.` : null;
  const itemProblem =
    kind !== "digital"
      ? null
      : file
        ? file.size > MAX_LOT_BYTES
          ? "That file is larger than 1 MB."
          : file.size === 0
            ? "That file is empty."
            : null
        : new TextEncoder().encode(secret).length > MAX_LOT_BYTES
          ? "That text is larger than 1 MB."
          : secret.trim() === ""
            ? "Add the text or a file the buyer will receive."
            : null;
  const minBond = priceZat !== null && !priceProblem ? bondFor(priceZat, bondPercent) : 0;
  const bondZat = minBond;
  const payoutProblem = addressProblem(payout);
  const ready = title.trim().length >= 3 && priceZat !== null && !priceProblem && !itemProblem && payout.trim().length > 20 && !payoutProblem && !busy;

  function pick(next: Kind) {
    setKind(next);
    setDeliverIn(next === "digital" ? 86400 : next === "physical" ? 3 * 86400 : 7 * 86400);
    setDisputeIn(next === "digital" ? 86400 : next === "physical" ? 14 * 86400 : 3 * 86400);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || priceZat === null) return;
    setBusy(true);
    setError(null);
    try {
      const key = newNonce();
      // Everything below is made from that key, here in the browser.
      const keys = await sellerKeys(key);
      const invite = await inviteFromManage(key);
      const delivery: Record<string, unknown> = { kind, seller_pub: keys.publicKey, deliver_seconds: deliverIn, dispute_seconds: disputeIn, seller_bond: bondZat ?? minBond };
      if (kind === "digital") {
        const item = file
          ? await encryptLot(keys.lotKey, { kind: "file", name: file.name, type: file.type }, new Uint8Array(await file.arrayBuffer()))
          : await encryptLot(keys.lotKey, { kind: "text" }, new TextEncoder().encode(secret));
        delivery.lot = toBase64(item);
        delivery.key_hash = await lotKeyHash(keys.lotKey);
      }
      const res = await fetch("/api/auctions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // The terms leave this page encrypted. The site gets the ciphertext and the hash of an access token.
          private: { listing: await encryptListing(invite, { title: title.trim(), description: terms.trim() }), access_hash: await sha256Hex(await inviteAccess(invite)) },
          deal: { public_price: showPrice },
          // Photos, redrawn when picked, encrypted here with the deal's key and padded to one size.
          ...(photos.length ? { photos: await Promise.all(photos.map(async (p, i) => toBase64(await encryptPhoto(invite, i, p.bytes)))) } : {}),
          reserve: priceZat,
          duration_seconds: offer,
          payout_address: payout.trim(),
          manage_key_hash: await sha256Hex(await manageToken(key)),
          delivery,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "the deal could not be created");
      try {
        localStorage.setItem(`dv-manage-${body.auction.id}`, key);
      } catch {
        /* the link below still works */
      }
      rememberInvite(body.auction.id, invite);
      setMade({ id: body.auction.id, key, invite, bond: body.auction.state === "funding" ? (bondZat ?? minBond) : 0 });
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
    const dealLink = `${origin}/deal/${made.id}#invite=${made.invite}`;
    const sellerLink = `${origin}/deal/${made.id}#manage=${made.key}`;
    return (
      <main>
        <div className="shell narrow">
          <p className="kicker">{made.bond > 0 ? "One Step Left: Fund Your Bond" : "Your Deal Is Open"}</p>
          <h1 style={{ fontSize: "clamp(1.9rem, 4.5vw, 3rem)" }}>{title.trim()}</h1>
          {made.bond > 0 && (
            <div className="card accent" id="bond-next">
              <h3>The Deal Opens When Your Bond Arrives</h3>
              <p className="small" style={{ margin: 0 }}>
                Save your seller link below, then press <strong>Open The Deal</strong>. The page shows where to send your bond of{" "}
                <strong>{formatCoins(made.bond)} TAZ</strong>. The buyer can pay once it is in a block.
              </p>
            </div>
          )}
          <div className="card accent" id="share-made">
            <h3>Send This To Your Buyer</h3>
            <p className="small" id="invite-note">
              <strong>This link is the deal.</strong> Whoever has it can read the terms and pay, so send it only to the person you agreed with. The
              terms were encrypted in your browser: this site can&apos;t read them. The part after the # is the key; it never reaches this site.
            </p>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <Qr value={dealLink} size={150} />
              <div className="grow">
                <div className="addr" id="public-link">
                  {dealLink}
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    type="button"
                    id="copy-share"
                    onClick={() => {
                      void navigator.clipboard?.writeText(dealLink);
                      setCopied("deal");
                    }}
                  >
                    {copied === "deal" ? "Copied" : "Copy The Deal Link"}
                  </button>
                </div>
                <p className="hint">The QR code holds the same link.</p>
              </div>
            </div>
          </div>
          <div className="card warn">
            <h3>Keep This Link For Yourself</h3>
            <p className="small">
              It opens the same page with your seller view. <strong>You need it to get paid:</strong>{" "}
              {kind === "digital"
                ? "once the buyer has paid, open it and your browser sends them the key. The price is released to you once they have it."
                : kind === "promise"
                  ? "once the buyer has paid, open it to read what they want and to say when you have done it. The price is released to you once they confirm."
                  : "once the buyer has paid, open it to see where to send the item and to say when you have shipped it. The price is released to you once they have it."}{" "}
              The part after the # never leaves your browser, and we can&apos;t recover it. <strong>Never share this link.</strong>
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
              <Link className="btn primary" id="open-deal" href={`/deal/${made.id}#manage=${made.key}`}>
                Open The Deal →
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
        <p className="kicker">Settlement</p>
        <h1 style={{ fontSize: "clamp(1.9rem, 4.5vw, 3rem)" }}>Create A Deal</h1>
        <p className="muted">
          For a price you and one other person have already agreed. No bidding, no account. The buyer pays into a shielded escrow, you hand
          over, and the price is released to you.
        </p>
        <form onSubmit={submit} className="card" id="deal-form">
          <label htmlFor="title" style={{ marginTop: 0 }}>
            What Is The Deal For?
          </label>
          <input id="title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Logo design, final files" />

          <label htmlFor="terms">The Terms You Agreed</label>
          <textarea id="terms" value={terms} maxLength={1200} onChange={(e) => setTerms(e.target.value)} placeholder="Exactly what the buyer gets, and anything else the two of you agreed. If there is a dispute, this is what it is judged against." />
          <p className="hint" id="terms-hint">
            Both are encrypted in your browser before they are sent. Only someone with the deal link can read them: this site can&apos;t. One
            exception: if the buyer opens a dispute, their browser gives the operator the key to these terms, so the dispute can be judged.
          </p>

          <PhotoPicker photos={photos} onChange={setPhotos} sealed />

          <label htmlFor="price">The Price (TAZ)</label>
          <input id="price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.5" />
          <p className={priceProblem ? "hint error" : "hint"} id="price-effect">
            {priceProblem ?? `One fixed price. The buyer pays exactly this${minBond > 0 ? `, plus a bond of ${formatCoins(minBond)} TAZ that comes back to them` : ""}. The site is told the price, because it holds it in escrow.`}
          </p>

          <label style={{ marginBottom: 8 }}>What Is Handed Over?</label>
          <div className="seg" role="radiogroup" aria-label="What is handed over">
            <label className={kind === "digital" ? "on" : undefined}>
              <input type="radio" name="kind" id="kind-digital" checked={kind === "digital"} onChange={() => pick("digital")} />
              <b>Digital</b>
              <span>A file, a code, a link or a text. Unlocks in the buyer&apos;s browser.</span>
            </label>
            <label className={kind === "physical" ? "on" : undefined}>
              <input type="radio" name="kind" id="kind-physical" checked={kind === "physical"} onChange={() => pick("physical")} />
              <b>Physical</b>
              <span>You post it. The buyer&apos;s address reaches only you.</span>
            </label>
            <label className={kind === "promise" ? "on" : undefined}>
              <input type="radio" name="kind" id="kind-promise" checked={kind === "promise"} onChange={() => pick("promise")} />
              <b>A Promise</b>
              <span>Work you will do, or a service. The buyer tells only you what they want.</span>
            </label>
          </div>

          {kind === "digital" ? (
            <>
              <label htmlFor="secret">What The Buyer Receives</label>
              <textarea id="secret" value={secret} disabled={!!file} onChange={(e) => setSecret(e.target.value)} placeholder="The code, link or text. Only the buyer will ever see it." />
              <div className="row" style={{ marginTop: 8 }}>
                <label className="btn sm" style={{ margin: 0 }}>
                  {file ? "Choose Another File" : "Or Attach A File (Up To 1 MB)"}
                  <input id="lot-file" type="file" style={{ display: "none" }} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </label>
                {file && (
                  <>
                    <span className="mono small">{file.name}</span>
                    <button type="button" className="link small" onClick={() => setFile(null)}>
                      Remove
                    </button>
                  </>
                )}
              </div>
              <p className={itemProblem && (file || secret) ? "hint error" : "hint"}>
                {itemProblem && (file || secret) ? itemProblem : "Encrypted in your browser before it is sent. The site stores it but can't read it. The buyer gets the key only after they have paid."}
              </p>
            </>
          ) : (
            <p className="hint">
              {kind === "promise"
                ? "After paying, the buyer tells you what they want, sealed so only your browser can read it. Say in the terms exactly what you will do."
                : "After paying, the buyer sends their address, sealed so only your browser can read it. Say in the terms where you ship to."}
            </p>
          )}

          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="grow">
              <label htmlFor="deliver-in">{kind === "digital" ? "You Hand Over The Key Within" : kind === "promise" ? "You Do It Within" : "You Ship Within"}</label>
              <select id="deliver-in" value={deliverIn} onChange={(e) => setDeliverIn(Number(e.target.value))}>
                {WINDOWS.map(([label, s]) => (
                  <option key={s} value={s}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grow">
              <label htmlFor="dispute-in">The Buyer Can Open A Dispute For</label>
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
            The price is held until the handover. You are paid when the buyer confirms, or when their time to complain runs out. If you don&apos;t
            hand over in time, they are refunded.
          </p>

          {minBond > 0 && (
            <>
              <span className="label-like">Your Bond</span>
              <BondFixed amount={minBond} of="the price" />
              <p className="hint">
                {`A deposit you make before the deal opens. You get it back with your payment, or when the offer runs out. You lose it to the buyer if you don't deliver or lose a dispute. The buyer puts down the same ${formatCoins(minBond)} TAZ on the same terms. Anything you send above it comes straight back.`}
              </p>
            </>
          )}

          <label htmlFor="offer">This Offer Stands For</label>
          <select id="offer" value={offer} onChange={(e) => setOffer(Number(e.target.value))}>
            {OFFERS.map(([label, s]) => (
              <option key={s} value={s}>
                {label}
              </option>
            ))}
          </select>
          <p className="hint">How long the buyer has to pay, counted from when your bond arrives. After that the deal closes and your bond comes back.</p>

          <label htmlFor="payout">Your Shielded Payout Address</label>
          <input id="payout" className="mono" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="utest1…" spellCheck={false} autoComplete="off" />
          <p className={payoutProblem ? "hint error" : "hint"}>{payoutProblem ?? "A fresh unified address from your testnet wallet. Only this site sees it; it is never published."}</p>

          <label className="check" htmlFor="show-price">
            <input type="checkbox" id="show-price" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} />
            <span>
              <b>Show The Price On The Public Ledger.</b> If the deal completes, the ledger shows that a deal of this price was settled. It is added
              with that day&apos;s other deals, so it can&apos;t be timed. Nothing else is shown: not the terms, not you, not the buyer. Untick it and nothing
              about this deal is ever public.
            </span>
          </label>

          {error && <p className="error">{error}</p>}
          <div className="row" style={{ marginTop: 20 }}>
            <button className="primary lg" id="create-deal" disabled={!ready}>
              {busy ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Opening The Escrow…
                </>
              ) : (
                "Create The Deal"
              )}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
