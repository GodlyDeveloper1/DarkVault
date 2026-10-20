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
  requests: { side: "winner" | "seller"; at: number; due: number; text: string; answer: { at: number; text: string } | null }[];
  decide_by: number;
  return: { at: number; address_by: number; address_at: number | null; send_by: number | null; sent_at: number | null; confirm_by: number | null; problem: string | null } | null;
}

type Decision = "release" | "refund" | "lost" | "return";

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
  const [confirm, setConfirm] = useState<null | { decision: Decision }>(null);
  const [asking, setAsking] = useState<null | "winner" | "seller">(null);
  const [askText, setAskText] = useState("");
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

  async function ask() {
    if (!asking) return;
    setBusy(true);
    setProblem(null);
    const res = await fetch(`/api/operator/disputes/${d.id}/ask`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ side: asking, text: askText }),
    });
    setBusy(false);
    if (!res.ok) return setProblem((await res.json().catch(() => ({}))).error ?? "The request was refused.");
    setAsking(null);
    setAskText("");
    done();
  }

  async function decide(decision: Decision) {
    setBusy(true);
    setProblem(null);
    const res = await fetch(`/api/operator/disputes/${d.id}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    setBusy(false);
    if (!res.ok) return setProblem((await res.json().catch(() => ({}))).error ?? "The decision was refused.");
    setConfirm(null);
    done();
  }

  const said = confirm
    ? confirm.decision === "release"
      ? "The seller wins: they are paid, and the buyer's bond goes to them."
      : confirm.decision === "refund"
        ? "The buyer wins: their payment comes back, with the seller's bond."
        : confirm.decision === "return"
          ? "The buyer wins, but posts the item back first. The seller has 48 hours to give a return address; the refund, with the seller's bond, follows the return."
          : "Lost in the post: the buyer is refunded, and each bond goes back to its owner."
    : "";
  // During a return its own deadlines decide; asking again is for a problem with what came back.
  const openAsk = (side: "winner" | "seller") => (!!d.return && !d.return.problem) || d.requests.some((r) => r.side === side && !r.answer);

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
        <dd>{when(d.decide_by)} <span className="muted small">(then: everyone&apos;s own money goes back)</span></dd>
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
      {d.requests.length > 0 && (
        <div className="op-requests">
          {d.requests.map((r, i) => (
            <div key={i} className={`op-request${r.answer ? " answered" : Date.now() > r.due ? " missed" : ""}`}>
              <p className="small">
                <strong>Asked the {r.side === "winner" ? "buyer" : "seller"}</strong> <span className="muted">{when(r.at)}</span>
              </p>
              <p className="small muted" style={{ whiteSpace: "pre-wrap" }}>{r.text}</p>
              {r.answer ? (
                <p className="small" style={{ whiteSpace: "pre-wrap" }}>
                  <strong>Answer ({when(r.answer.at)}):</strong> &ldquo;{r.answer.text}&rdquo;
                </p>
              ) : (
                <p className="small">
                  <strong className={Date.now() > r.due ? "error" : undefined}>
                    {Date.now() > r.due ? "No answer in time: this side loses on the next pass." : `Waiting for an answer until ${when(r.due)}.`}
                  </strong>
                </p>
              )}
            </div>
          ))}
        </div>
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

      {d.return && (
        <div className="op-request answered op-return">
          <p className="small">
            <strong>Return under way</strong> <span className="muted">since {when(d.return.at)}</span>
          </p>
          <p className="small">
            {d.return.problem
              ? `The seller says what came back is wrong: "${d.return.problem}". Both sides have been asked for proof.`
              : !d.return.address_at
                ? `Waiting for the seller's return address until ${when(d.return.address_by)} (then: refund, the buyer keeps it).`
                : !d.return.sent_at
                  ? `Waiting for the buyer to post it back until ${when(d.return.send_by)} (then: the seller is paid).`
                  : `Posted back ${when(d.return.sent_at)}. Waiting for the seller to confirm until ${when(d.return.confirm_by)} (then: refund).`}
          </p>
        </div>
      )}
      {asking && (
        <div className="card op-ask">
          <label htmlFor={`ask-${d.id}`}>Ask The {asking === "winner" ? "Buyer" : "Seller"} For Proof</label>
          <textarea
            id={`ask-${d.id}`}
            value={askText}
            maxLength={600}
            onChange={(e) => setAskText(e.target.value)}
            placeholder="What you need to see. They read it as a request from the site, with 48 hours to answer."
          />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" disabled={busy || askText.trim().length < 10} onClick={() => void ask()}>
              {busy ? "Sending…" : "Send The Request"}
            </button>
            <button disabled={busy} onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {!confirm ? (
        <div className="op-decide">
          <div className="row">
            <button disabled={busy || openAsk("winner")} onClick={() => setAsking("winner")} title={openAsk("winner") ? "The buyer has not answered the last request yet" : undefined}>
              Ask The Buyer
            </button>
            <button disabled={busy || openAsk("seller")} onClick={() => setAsking("seller")} title={openAsk("seller") ? "The seller has not answered the last request yet" : undefined}>
              Ask The Seller
            </button>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" disabled={busy} onClick={() => setConfirm({ decision: "release" })}>
              Seller Wins
            </button>
            <button className="danger" disabled={busy} onClick={() => setConfirm({ decision: "refund" })}>
              Buyer Wins
            </button>
            {d.lot === "physical" && !d.return && (
              <button className="danger" disabled={busy} onClick={() => setConfirm({ decision: "return" })}>
                Buyer Wins, Return First
              </button>
            )}
            {d.lot === "physical" && (
              <button disabled={busy} onClick={() => setConfirm({ decision: "lost" })}>
                Lost In The Post
              </button>
            )}
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
