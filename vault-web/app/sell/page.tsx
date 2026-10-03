"use client";

// List a lot. No account: the seller's browser makes a manage key, which
// travels in the manage link's #fragment and never reaches the server. The
// server is shown a token derived from it and stores that token's hash.
//
// A digital lot (a text or a file) is encrypted here, in the browser, with a
// key derived from the manage key. The server gets the ciphertext and a hash
// of the key. A physical lot gets a public key that the winner's browser will
// seal the shipping address to.
import Link from "next/link";
import { useEffect, useState } from "react";
import { MAX_LOT_BYTES, MIN_BID, bondFor, encryptLot, formatCoins, lotKeyHash, manageToken, newNonce, parseCoins, sellerKeys, sha256Hex, toBase64 } from "vault-core";

const DURATIONS: [string, number][] = [
  ["15 minutes", 15 * 60],
  ["1 hour", 3600],
  ["6 hours", 6 * 3600],
  ["1 day", 86400],
  ["3 days", 3 * 86400],
  ["7 days", 7 * 86400],
];
const REVEALS: [string, number][] = [
  ["5 minutes", 5 * 60],
  ["15 minutes", 15 * 60],
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

export default function Sell() {
  const [kind, setKind] = useState<"digital" | "physical" | "promise">("digital");
  const [secret, setSecret] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [deliverIn, setDeliverIn] = useState(86400);
  const [disputeIn, setDisputeIn] = useState(86400);
  // The seller's bond. Empty means "the minimum"; the seller may stake more.
  const [bond, setBond] = useState("");
  const [bondPercent, setBondPercent] = useState(10);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((b) => typeof b.bond_percent === "number" && setBondPercent(b.bond_percent))
      .catch(() => {});
  }, []);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [reserve, setReserve] = useState("0.01");
  const [duration, setDuration] = useState(3600);
  const [reveal, setReveal] = useState(15 * 60);
  const [payout, setPayout] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; key: string; bond: number } | null>(null);
  const [copied, setCopied] = useState(false);

  const reserveZat = parseCoins(reserve);
  const reserveProblem =
    reserveZat === null ? "Enter an amount like 0.01" : reserveZat < MIN_BID ? `The reserve must be at least ${formatCoins(MIN_BID)} TAZ` : null;
  const lotProblem =
    kind !== "digital"
      ? null
      : file
        ? file.size > MAX_LOT_BYTES
          ? "That file is larger than 1 MB"
          : file.size === 0
            ? "That file is empty"
            : null
        : new TextEncoder().encode(secret).length > MAX_LOT_BYTES
          ? "That text is larger than 1 MB"
          : secret.trim() === ""
            ? "Add the text or a file the winner will receive"
            : null;
  const minBond = reserveZat !== null && !reserveProblem ? bondFor(reserveZat, bondPercent) : 0;
  const bondZat = bond.trim() === "" ? minBond : parseCoins(bond);
  const bondProblem =
    minBond === 0 ? null : bondZat === null ? "Enter an amount like 0.001" : bondZat < minBond ? `Your bond must be at least ${formatCoins(minBond)} TAZ` : null;
  const ready = title.trim().length >= 3 && !reserveProblem && !lotProblem && !bondProblem && payout.trim().length > 20 && !busy;

  function pick(next: "digital" | "physical" | "promise") {
    setKind(next);
    // Sensible time limits for each kind; the seller can change them.
    setDeliverIn(next === "digital" ? 86400 : next === "physical" ? 3 * 86400 : 7 * 86400);
    setDisputeIn(next === "digital" ? 86400 : next === "physical" ? 14 * 86400 : 3 * 86400);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const key = newNonce();
      // Everything below is derived from the manage key, here in the browser.
      const keys = await sellerKeys(key);
      const delivery: Record<string, unknown> = { kind, seller_pub: keys.publicKey, deliver_seconds: deliverIn, dispute_seconds: disputeIn, seller_bond: bondZat ?? minBond };
      if (kind === "digital") {
        const lot = file
          ? await encryptLot(keys.lotKey, { kind: "file", name: file.name, type: file.type }, new Uint8Array(await file.arrayBuffer()))
          : await encryptLot(keys.lotKey, { kind: "text" }, new TextEncoder().encode(secret));
        delivery.lot = toBase64(lot);
        delivery.key_hash = await lotKeyHash(keys.lotKey);
      }
      const res = await fetch("/api/auctions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          reserve: reserveZat,
          duration_seconds: duration,
          reveal_seconds: reveal,
          payout_address: payout.trim(),
          manage_key_hash: await sha256Hex(await manageToken(key)),
          delivery,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "could not create the auction");
      try {
        localStorage.setItem(`dv-manage-${body.auction.id}`, key);
      } catch {
        /* the link below still works */
      }
      setMade({ id: body.auction.id, key, bond: body.auction.state === "funding" ? (bondZat ?? minBond) : 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (made) {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const link = `${origin}/auction/${made.id}`;
    const manage = `${link}#manage=${made.key}`;
    return (
      <main>
        <div className="shell narrow">
          <p className="kicker">{made.bond > 0 ? "One step left: fund your bond" : "Your auction is live"}</p>
          <h1 style={{ fontSize: "clamp(1.9rem, 4.5vw, 3rem)" }}>{title.trim()}</h1>
          {made.bond > 0 && (
            <div className="card accent" id="bond-next">
              <h3>Bidding opens when your bond arrives</h3>
              <p className="small" style={{ margin: 0 }}>
                Save your seller link below, then press <strong>Open the auction</strong>. The page shows where to send your bond of{" "}
                <strong>{formatCoins(made.bond)} TAZ</strong>. The bidding time starts when it arrives, not now.
              </p>
            </div>
          )}
          <div className="card accent">
            <h3>Share this link with bidders</h3>
            <div className="addr" id="public-link">{link}</div>
          </div>
          <div className="card warn">
            <h3>Keep this link for yourself</h3>
            <p className="small">
              It opens the same page with your seller view. <strong>You need it to get paid:</strong>{" "}
              {kind === "digital"
                ? "after the sale, open it and your browser sends the winner the key to the lot. The price is released to you once they have it."
                : kind === "promise"
                  ? "after the sale, open it to read what the winner wants and to say when you have done it. The price is released to you once they confirm."
                  : "after the sale, open it to see where to send the lot and to say when you have shipped it. The price is released to you once the winner has it."}{" "}
              The part after the # never leaves your browser, and we can&apos;t recover it. <strong>Never share this link:</strong> anyone who has it
              can act as the seller.
            </p>
            <div className="addr" id="manage-link">{manage}</div>
            <div className="row" style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(manage);
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy my seller link"}
              </button>
              <Link className="btn primary" href={`/auction/${made.id}#manage=${made.key}`}>
                Open the auction →
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
        <p className="kicker">Sell something</p>
        <h1 style={{ fontSize: "clamp(1.9rem, 4.5vw, 3rem)" }}>List a lot</h1>
        <p className="muted">
          No account. Bidders send sealed bids as shielded deposits. When it ends, every losing deposit is returned and the
          winning bid is held for you until the lot has been handed over.
        </p>
        <form onSubmit={submit} className="card">
          <label htmlFor="title" style={{ marginTop: 0 }}>
            What are you selling?
          </label>
          <input id="title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="A first-edition zine, signed" />

          <label htmlFor="description">Description</label>
          <textarea id="description" value={description} maxLength={1200} onChange={(e) => setDescription(e.target.value)} placeholder="Condition, what exactly the winner gets, anything a bidder should know." />

          <label style={{ marginBottom: 8 }}>What kind of lot is it?</label>
          <div className="seg" role="radiogroup" aria-label="How the winner receives the lot">
            <label className={kind === "digital" ? "on" : undefined}>
              <input type="radio" name="kind" id="kind-digital" checked={kind === "digital"} onChange={() => pick("digital")} />
              <b>Digital</b>
              <span>A code, a link, a licence key or a file. Unlocks in the winner&apos;s browser.</span>
            </label>
            <label className={kind === "physical" ? "on" : undefined}>
              <input type="radio" name="kind" id="kind-physical" checked={kind === "physical"} onChange={() => pick("physical")} />
              <b>Physical</b>
              <span>You post it. The winner&apos;s address reaches only you.</span>
            </label>
            <label className={kind === "promise" ? "on" : undefined}>
              <input type="radio" name="kind" id="kind-promise" checked={kind === "promise"} onChange={() => pick("promise")} />
              <b>A promise</b>
              <span>Something you will do: naming rights, an hour of your time. The winner tells only you what they want.</span>
            </label>
          </div>

          {kind === "digital" ? (
            <>
              <label htmlFor="secret">What the winner receives</label>
              <textarea id="secret" value={secret} disabled={!!file} onChange={(e) => setSecret(e.target.value)} placeholder="The code, link or text. Only the winner will ever see it." />
              <div className="row" style={{ marginTop: 8 }}>
                <label className="btn sm" style={{ margin: 0 }}>
                  {file ? "Choose another file" : "Or attach a file (up to 1 MB)"}
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
              <p className={lotProblem && (file || secret) ? "hint error" : "hint"}>
                {lotProblem && (file || secret)
                  ? lotProblem
                  : "Encrypted in your browser before it is sent. The site stores it but can't read it, and neither can bidders."}
              </p>
            </>
          ) : (
            <p className="hint">
              {kind === "promise"
                ? "After the sale the winner tells you what they want (the name they choose, say), sealed so only your browser can read it. Say in the description exactly what you promise and what you won't do."
                : "After the sale the winner sends their address, sealed so only your browser can read it. Say in the description where you ship to."}
            </p>
          )}

          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="grow">
              <label htmlFor="deliver-in">{kind === "digital" ? "You hand over the key within" : kind === "promise" ? "You do it within" : "You ship within"}</label>
              <select id="deliver-in" value={deliverIn} onChange={(e) => setDeliverIn(Number(e.target.value))}>
                {WINDOWS.map(([label, s]) => (
                  <option key={s} value={s}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grow">
              <label htmlFor="dispute-in">The winner can complain for</label>
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
            The price is held until the handover. You are paid when the winner confirms, or when their time to complain runs out. If you
            don&apos;t hand over in time, they are refunded.
          </p>

          {minBond > 0 && (
            <>
              <label htmlFor="bond">Your bond (TAZ)</label>
              <input id="bond" inputMode="decimal" value={bond} onChange={(e) => setBond(e.target.value)} placeholder={formatCoins(minBond)} />
              <p className={bondProblem ? "hint error" : "hint"}>
                {bondProblem ??
                  `A deposit you make before bidding opens, at least ${formatCoins(minBond)} TAZ. You get it back with your payment, or when the lot doesn't sell. You lose it to the winner if you don't deliver or lose a dispute. Bidders see the amount: a larger bond shows you mean it. Each bidder puts down ${formatCoins(minBond)} TAZ on top of their bid, on the same terms.`}
              </p>
            </>
          )}

          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="grow">
              <label htmlFor="reserve">Reserve price (TAZ)</label>
              <input id="reserve" inputMode="decimal" value={reserve} onChange={(e) => setReserve(e.target.value)} />
              <p className={reserveProblem ? "hint error" : "hint"}>{reserveProblem ?? "The least you'll accept. It is public."}</p>
            </div>
            <div className="grow">
              <label htmlFor="duration">Bidding runs for</label>
              <select id="duration" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {DURATIONS.map(([label, s]) => (
                  <option key={s} value={s}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grow">
              <label htmlFor="reveal">Then bidders reveal within</label>
              <select id="reveal" value={reveal} onChange={(e) => setReveal(Number(e.target.value))}>
                {REVEALS.map(([label, s]) => (
                  <option key={s} value={s}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <label htmlFor="payout">Your shielded payout address</label>
          <input id="payout" className="mono" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="utest1…" spellCheck={false} autoComplete="off" />
          <p className="hint">A fresh unified address from your testnet wallet. Only this site sees it; it is never published.</p>

          {error && <p className="error">{error}</p>}
          <div className="row" style={{ marginTop: 20 }}>
            <button className="primary lg" disabled={!ready}>
              {busy ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Opening the vault…
                </>
              ) : (
                "Start the auction"
              )}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
