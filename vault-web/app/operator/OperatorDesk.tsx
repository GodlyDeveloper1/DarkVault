"use client";

// The operator's desk. The key is typed here and kept for this tab only
// (session storage); every request carries it in a header. Nothing secret is
// in the page itself: without the key the site answers "not found".
import { useCallback, useEffect, useState } from "react";
import { formatCoins } from "vault-core";

interface Dispute {
  id: string;
  private: boolean;
  title: string;
  price: number | null;
  description: string;
  lot: "digital" | "physical" | "promise";
  kind: "not-as-described" | "physical" | "promise";
  seller_bond: number;
  buyer_bond: number;
  handed_over_at: number | null;
  disputed_at: number;
  reason: string | null;
  seller_reply: string | null;
  lot_available: boolean;
  market: "auction" | "settlement" | "order-flow";
  sale_id: string | null;
  evidence: { winner: number; seller: number };
  offer_percent: number | null;
  decide_by: number;
}

const KEY = "dv-operator-key";
const MARKET = { auction: "Auction", settlement: "Settlement Deal", "order-flow": "Order Flow Unit" } as const;
const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const readKey = () => {
  try {
    return sessionStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
};

export default function OperatorDesk() {
  const [key, setKey] = useState("");
  const [typed, setTyped] = useState("");
  const [disputes, setDisputes] = useState<Dispute[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async (k: string) => {
    setProblem(null);
    const res = await fetch("/api/operator/disputes", { headers: { "x-operator-key": k }, cache: "no-store" });
    if (!res.ok) {
      setDisputes(null);
      setKey("");
      setProblem("That key was not accepted.");
      try {
        sessionStorage.removeItem(KEY);
      } catch {}
      return;
    }
    setKey(k);
    try {
      sessionStorage.setItem(KEY, k);
    } catch {}
    setDisputes((await res.json()).disputes as Dispute[]);
  }, []);

  useEffect(() => {
    const k = readKey();
    if (k) void load(k);
  }, [load]);

  if (!key || !disputes) {
    return (
      <div className="op-lock card" id="operator-lock">
        <h1>This Page Is Private</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) void load(typed.trim());
          }}
        >
          <label htmlFor="op-key">Operator Key</label>
          <input id="op-key" type="password" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={!typed.trim()}>
              Open The Desk
            </button>
          </div>
          {problem && <p className="error small">{problem}</p>}
          <p className="hint">The key stays in this tab only, and is forgotten when you close it.</p>
        </form>
      </div>
    );
  }

  return (
    <div id="operator-desk">
      <div className="row spread page-head">
        <div>
          <p className="peak">Operator</p>
          <h1>Open Disputes</h1>
          <p className="lead">
            Every market in one list. You see a private listing only because its buyer handed over the key with the complaint; the keys and the
            photos are deleted once you decide and the payout is made.
          </p>
        </div>
        <div className="row">
          <button className="sm" onClick={() => void load(key)}>
            Refresh
          </button>
          <button
            className="sm"
            onClick={() => {
              try {
                sessionStorage.removeItem(KEY);
              } catch {}
              setKey("");
              setDisputes(null);
            }}
          >
            Lock
          </button>
        </div>
      </div>
      {disputes.length === 0 ? (
        <div className="card op-empty" id="op-empty">
          <strong>No open disputes.</strong>
          <p className="small muted">When a buyer opens one, it appears here.</p>
        </div>
      ) : (
        <div className="op-list">
          {disputes.map((d) => (
            <DisputeCard key={d.id} d={d} opKey={key} done={() => void load(key)} />
          ))}
        </div>
      )}
    </div>
  );
}

function DisputeCard({ d, opKey, done }: { d: Dispute; opKey: string; done: () => void }) {
  const [photos, setPhotos] = useState<{ side: string; url: string }[]>([]);
  const [lotText, setLotText] = useState<string | null>(null);
  const [pct, setPct] = useState(50);
  const [noFault, setNoFault] = useState(false);
  const [confirm, setConfirm] = useState<null | { decision: "release" | "refund" | "split" }>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const headers = { "x-operator-key": opKey };

  useEffect(() => {
    let stop = false;
    const urls: string[] = [];
    void (async () => {
      const out: { side: string; url: string }[] = [];
      for (const side of ["winner", "seller"] as const)
        for (let n = 1; n <= d.evidence[side]; n++) {
          const res = await fetch(`/api/operator/disputes/${d.id}/evidence/${side}/${n}`, { headers, cache: "no-store" });
          if (!res.ok) continue;
          const url = URL.createObjectURL(await res.blob());
          urls.push(url);
          out.push({ side, url });
        }
      if (!stop) setPhotos(out);
    })();
    return () => {
      stop = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.id, d.evidence.winner, d.evidence.seller]);

  async function openLot() {
    const res = await fetch(`/api/operator/disputes/${d.id}/lot`, { headers, cache: "no-store" });
    if (!res.ok) return setProblem("The delivered lot could not be opened.");
    if ((res.headers.get("content-type") ?? "").includes("json")) return setLotText((await res.json()).text);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob());
    a.download = "delivered-lot";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function decide(decision: "release" | "refund" | "split") {
    setBusy(true);
    setProblem(null);
    const res = await fetch(`/api/operator/disputes/${d.id}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(decision === "split" ? { decision, winner_percent: pct } : { decision, no_fault: noFault }),
    });
    setBusy(false);
    if (!res.ok) return setProblem((await res.json().catch(() => ({}))).error ?? "The decision was refused.");
    setConfirm(null);
    done();
  }

  const said = confirm
    ? confirm.decision === "split"
      ? `Give the buyer ${pct}% of the price back and the seller ${100 - pct}%. Both bonds go back.`
      : confirm.decision === "release"
        ? `Pay the seller.${noFault ? " Both bonds go back." : " The buyer loses their bond to the seller."}`
        : `Refund the buyer.${noFault ? " Both bonds go back." : " The seller loses their bond to the buyer."}`
    : "";

  return (
    <article className="card op-card" data-id={d.id}>
      <div className="row op-tags">
        <span className="badge">{MARKET[d.market]}</span>
        {d.private && <span className="badge">Private</span>}
        <span className="badge">{d.lot === "digital" ? "Digital" : d.lot === "physical" ? "Physical" : "Promise"}</span>
        <span className="small muted">Opened {when(d.disputed_at)}</span>
      </div>
      <h2>{d.title}</h2>
      <dl className="kv op-kv">
        <dt>Price</dt>
        <dd>{d.price !== null ? `${formatCoins(d.price)} TAZ` : "—"}</dd>
        <dt>Bonds</dt>
        <dd>
          Seller {formatCoins(d.seller_bond)} · Buyer {formatCoins(d.buyer_bond)} TAZ
        </dd>
        <dt>Handed over</dt>
        <dd>{when(d.handed_over_at)}</dd>
        <dt>Decide by</dt>
        <dd>{when(d.decide_by)} <span className="muted small">(then: refund, nobody at fault)</span></dd>
      </dl>
      {d.description && (
        <details className="op-desc">
          <summary>What was described</summary>
          <p className="small" style={{ whiteSpace: "pre-wrap" }}>{d.description}</p>
        </details>
      )}
      <p className="small op-said">
        <strong>The buyer says:</strong> &ldquo;{d.reason ?? "—"}&rdquo;
      </p>
      <p className="small op-said">
        <strong>The seller answers:</strong> {d.seller_reply ? <>&ldquo;{d.seller_reply}&rdquo;</> : <span className="muted">No answer yet.</span>}
      </p>
      {d.offer_percent !== null && (
        <p className="small">
          <strong>Standing offer:</strong> the seller offers {d.offer_percent}% back. The buyer has not accepted it.
        </p>
      )}
      {d.lot_available && (
        <div className="row" style={{ margin: "8px 0" }}>
          <button className="sm" onClick={() => void openLot()}>
            Open The Delivered Lot
          </button>
        </div>
      )}
      {lotText !== null && <pre className="sealed-text op-lot">{lotText}</pre>}
      {photos.length > 0 && (
        <div className="op-photos">
          {photos.map((p, i) => (
            <figure key={i}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={`Evidence from the ${p.side === "winner" ? "buyer" : "seller"}`} />
              <figcaption className="small muted">{p.side === "winner" ? "Buyer" : "Seller"}</figcaption>
            </figure>
          ))}
        </div>
      )}

      {!confirm ? (
        <div className="op-decide">
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => setConfirm({ decision: "release" })}>
              Release To Seller
            </button>
            <button className="danger" disabled={busy} onClick={() => setConfirm({ decision: "refund" })}>
              Refund The Buyer
            </button>
            <label className="op-nofault small">
              <input type="checkbox" checked={noFault} onChange={(e) => setNoFault(e.target.checked)} /> Nobody at fault (both bonds go back)
            </label>
          </div>
          <div className="row offer-row" style={{ marginTop: 10 }}>
            <input
              type="number"
              className="offer-pct"
              min={1}
              max={99}
              value={pct}
              aria-label="Percent of the price back to the buyer"
              onChange={(e) => setPct(Math.max(1, Math.min(99, Math.round(Number(e.target.value) || 1))))}
            />
            <span className="small muted">% back to the buyer</span>
            <button disabled={busy} onClick={() => setConfirm({ decision: "split" })}>
              Split The Price
            </button>
          </div>
        </div>
      ) : (
        <div className="card warn op-confirm">
          <strong>{said}</strong>
          <p className="small muted" style={{ margin: "6px 0 10px" }}>This is final: the payout goes out on the next pass.</p>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void decide(confirm.decision)}>
              {busy ? "Deciding…" : "Yes, Decide"}
            </button>
            <button disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {problem && <p className="error small">{problem}</p>}
    </article>
  );
}
