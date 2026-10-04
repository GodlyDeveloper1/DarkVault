"use client";

// The practice auction panel on the home page.
//
// A visitor with no testnet coins, or who arrives when nothing is on sale, can
// still try a whole auction: the site lists a small lot, two house bidders
// (automated) bid on it, and a practice wallet gives the visitor coins to bid
// with. This panel shows the practice auction that is open, or starts one.
// It renders nothing on a site that runs no practice auctions.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatCoins } from "vault-core";
import Countdown from "./Countdown";

interface Practice {
  enabled: boolean;
  open?: { id: string; ends_at: number; title: string } | null;
  can_start?: boolean;
  wait?: string | null;
  duration_seconds?: number;
  bots?: number;
  bot_max?: number;
  reserve?: number;
  ceiling?: number;
}

export default function PracticePanel() {
  const router = useRouter();
  const [p, setP] = useState<Practice | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/practice");
      if (!res.ok) return;
      const date = res.headers.get("date");
      if (date) setOffset(new Date(date).getTime() - Date.now());
      setP((await res.json()).practice);
    } catch {
      /* the next poll tries again */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/practice/auction", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "a practice auction could not be started");
      router.push(`/auction/${body.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      void load();
    }
  }

  if (!p?.enabled) return null;
  const minutes = Math.max(1, Math.round((p.duration_seconds ?? 480) / 60));

  return (
    <section className="practice card accent" id="practice-panel">
      <div className="practice-in">
        <div>
          <p className="kicker" style={{ margin: 0 }}>
            No testnet coins? No auction on?
          </p>
          <h2 style={{ margin: "6px 0 8px" }}>Try a practice auction</h2>
          <p className="muted small" style={{ margin: 0, maxWidth: 620 }}>
            The site lists a small sealed lot and {p.bots} house bidders (automated) bid on it. A practice wallet gives you coins to bid
            against them. It takes about {minutes} {minutes === 1 ? "minute" : "minutes"}, with real shielded deposits on the Zcash testnet, a time-locked bid and a
            proof of the result. House bidders never bid above {formatCoins(p.bot_max ?? 0)} TAZ.
          </p>
        </div>
        <div className="practice-act">
          {p.open ? (
            <>
              <span className="muted small">Open now · closes in</span>
              <div className="practice-clock">
                <Countdown to={p.open.ends_at} offset={offset} onDone={() => void load()} />
              </div>
              <button type="button" className="primary lg" id="practice-join" onClick={() => router.push(`/auction/${p.open!.id}`)}>
                Join the practice auction
              </button>
            </>
          ) : p.can_start ? (
            <button type="button" className="primary lg" id="practice-start" disabled={busy} onClick={() => void start()}>
              {busy ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Starting…
                </>
              ) : (
                "Start a practice auction"
              )}
            </button>
          ) : (
            <p className="small" id="practice-wait" style={{ margin: 0, maxWidth: 280 }}>
              {p.wait ?? "A practice auction can't be started right now."}
            </p>
          )}
          {error && (
            <p className="error small" style={{ margin: "8px 0 0", maxWidth: 280 }}>
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
