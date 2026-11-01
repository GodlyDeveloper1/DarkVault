"use client";

// Pay Anywhere (NEAR HACKATHON, November 2026): pay a Dark Vault deposit with
// USDC, ETH, SOL, BTC or NEAR. NEAR Intents swaps it and delivers the exact
// shielded ZEC to this deposit's one-time address. See lib/oneclick.ts.
//
// Only this browser talks to NEAR Intents. Dark Vault's server never sees which
// coin or wallet paid: it sees a shielded deposit arrive, as with any wallet.

import { useEffect, useMemo, useState } from "react";
import { formatCoins } from "vault-core";
import Qr from "@/app/components/Qr";
import { COIN } from "@/lib/network";
import { offeredTokens, quoteZec, refundProblem, STATUS_TEXT, swapStatus, type Offered, type Quote, type SwapStatus } from "@/lib/oneclick";

interface Saved {
  quote: Quote;
  label: string;
  symbol: string;
}

const KEY = (to: string) => `dv-anywhere-${to.slice(-24)}`;
const load = (to: string): Saved | null => {
  try {
    const v = localStorage.getItem(KEY(to));
    return v ? (JSON.parse(v) as Saved) : null;
  } catch {
    return null;
  }
};
const store = (to: string, s: Saved | null) => {
  try {
    if (s) localStorage.setItem(KEY(to), JSON.stringify(s));
    else localStorage.removeItem(KEY(to));
  } catch {
    /* private mode: the quote still works for this visit */
  }
};

const TERMINAL = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export default function PayAnywhere({ to, zat }: { to: string; zat: number }) {
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState<Offered[] | null>(null);
  const [pick, setPick] = useState("");
  const [refund, setRefund] = useState("");
  const [estimate, setEstimate] = useState<Quote | null>(null);
  const [live, setLive] = useState<Saved | null>(null);
  const [status, setStatus] = useState<SwapStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = load(to);
    if (s && Date.parse(s.quote.deadline) > Date.now() - 6 * 3600_000) {
      setLive(s);
      setOpen(true);
    }
  }, [to]);

  useEffect(() => {
    if (!open || tokens) return;
    offeredTokens()
      .then((t) => {
        setTokens(t);
        setPick((p) => p || t[0]?.assetId || "");
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, [open, tokens]);

  const from = useMemo(() => tokens?.find((t) => t.assetId === pick) ?? null, [tokens, pick]);
  const refundIssue = from && refund ? refundProblem(from.blockchain, refund) : null;

  // A fresh price whenever the coin changes (dry: no deposit address is made).
  useEffect(() => {
    setEstimate(null);
    if (!from || live) return;
    let gone = false;
    const placeholderRefund = from.blockchain === "sol" ? "11111111111111111111111111111111" : from.blockchain === "btc" ? "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" : from.blockchain === "near" ? "intents.near" : "0x0000000000000000000000000000000000000000";
    quoteZec({ from, zat, zecAddress: to, refundTo: refund && !refundProblem(from.blockchain, refund) ? refund : placeholderRefund, dry: true })
      .then((q) => !gone && setEstimate(q))
      .catch((e) => !gone && setError(String(e?.message ?? e)));
    return () => {
      gone = true;
    };
  }, [from, zat, to, live, refund]);

  // Follow the swap until it ends.
  useEffect(() => {
    if (!live) return;
    let gone = false;
    let timer = 0;
    const tick = async () => {
      try {
        const s = await swapStatus(live.quote.depositAddress, live.quote.depositMemo);
        if (gone) return;
        setStatus(s);
        if (TERMINAL.has(s)) return;
      } catch {
        /* try again */
      }
      timer = window.setTimeout(tick, 8000);
    };
    void tick();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [live]);

  async function getAddress() {
    if (!from || refundIssue || !refund) return;
    setBusy(true);
    setError(null);
    try {
      const quote = await quoteZec({ from, zat, zecAddress: to, refundTo: refund, dry: false });
      if (!quote.depositAddress) throw new Error("NEAR Intents gave no deposit address");
      const s = { quote, label: from.label, symbol: from.symbol };
      store(to, s);
      setLive(s);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="anywhere" id="pay-anywhere">
        <button type="button" className="btn sm" onClick={() => setOpen(true)}>
          Pay With Another Coin
        </button>
        <span className="hint" style={{ marginLeft: 10 }}>
          USDC, ETH, SOL, BTC or NEAR, swapped to shielded {COIN} by NEAR Intents.
        </span>
      </div>
    );
  }

  return (
    <div className="anywhere card" id="pay-anywhere">
      <p className="anywhere-title">
        <strong>Pay Anywhere</strong> <span className="hint">through NEAR Intents</span>
      </p>

      {live ? (
        <>
          <p className="small">
            Send <strong className="mono">{live.quote.amountInFormatted} {live.symbol}</strong> ({live.label}) to this address before{" "}
            {new Date(live.quote.deadline).toLocaleTimeString()}:
          </p>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <Qr value={live.quote.depositAddress} size={130} />
            <div className="grow">
              <div className="addr mono" id="anywhere-address">{live.quote.depositAddress}</div>
              {live.quote.depositMemo && (
                <p className="small">
                  Memo (required): <span className="mono">{live.quote.depositMemo}</span>
                </p>
              )}
              <p className="small" id="anywhere-status" style={{ marginTop: 10 }}>
                {status && !TERMINAL.has(status) && <span className="spinner" aria-hidden="true" />} {STATUS_TEXT[status ?? "PENDING_DEPOSIT"] ?? status}
              </p>
              <p className="hint">
                NEAR Intents delivers exactly {formatCoins(zat)} {COIN} to this deposit&apos;s shielded address. Dark Vault sees only that shielded
                deposit, never your {live.symbol} wallet.
              </p>
              {status && TERMINAL.has(status) && status !== "SUCCESS" && (
                <button
                  type="button"
                  className="link small"
                  onClick={() => {
                    store(to, null);
                    setLive(null);
                    setStatus(null);
                  }}
                >
                  Get a new quote
                </button>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          <label htmlFor="anywhere-coin">Pay With</label>
          <select id="anywhere-coin" value={pick} onChange={(e) => setPick(e.target.value)} disabled={!tokens}>
            {!tokens && <option>Loading coins…</option>}
            {tokens?.map((t) => (
              <option key={t.assetId} value={t.assetId}>
                {t.label}
              </option>
            ))}
          </select>
          <p className="small" id="anywhere-estimate" style={{ minHeight: 22 }}>
            {estimate ? (
              <>
                About <strong className="mono">{estimate.amountInFormatted} {from?.symbol}</strong> for exactly {formatCoins(zat)} {COIN}.
              </>
            ) : from ? (
              <span className="hint">Asking NEAR Intents for a price…</span>
            ) : null}
          </p>

          <label htmlFor="anywhere-refund">Your Refund Address On That Chain</label>
          <input
            id="anywhere-refund"
            className="mono"
            value={refund}
            onChange={(e) => setRefund(e.target.value)}
            placeholder={from?.blockchain === "sol" ? "Solana address" : from?.blockchain === "btc" ? "bc1…" : from?.blockchain === "near" ? "you.near" : "0x…"}
            spellCheck={false}
            autoComplete="off"
          />
          <p className={refundIssue ? "hint error" : "hint"}>
            {refundIssue ?? "Only used if the swap can't be done: NEAR Intents sends your coins back here."}
          </p>

          <button type="button" className="btn primary sm" disabled={!from || !refund || !!refundIssue || busy} onClick={getAddress} id="anywhere-go">
            {busy ? "Getting an address…" : "Get A Deposit Address"}
          </button>
        </>
      )}

      {error && <p className="hint error">{error}</p>}
      <p className="hint anywhere-privacy">
        Said plainly: your payment is public on its own chain, and NEAR Intents sees it and this deposit&apos;s address. From the Zcash side on, it
        is shielded. Only this browser talks to NEAR Intents.
      </p>
    </div>
  );
}
