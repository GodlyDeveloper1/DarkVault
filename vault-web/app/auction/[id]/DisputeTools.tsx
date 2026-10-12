"use client";

// The tools either side has while a dispute is open, for every market:
//   - evidence photos for the operator (cleaned in this browser first, like
//     listing photos: no location, device or time survives the redraw);
//   - the seller's offer of part of the price back, and the winner accepting it,
//     which ends the dispute without the operator;
//   - when the dispute ends by itself if the operator never decides.
import { useState } from "react";
import { toBase64 } from "vault-core";
import { redrawPhoto } from "@/lib/photoClient";

const MAX = 3;

const when = (t: number | null | undefined) =>
  t ? new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "the time limit";

type Send = (body: Record<string, unknown>) => Promise<boolean>;

/** Up to three photos for the operator. `field` is how the route names the photo ("photo" for the winner, "evidence" for the seller). */
export function EvidencePhotos({ count, send, field, extra, id }: { count: number; send: Send; field: "photo" | "evidence"; extra?: Record<string, unknown>; id: string }) {
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const left = MAX - count;

  async function add(file: File) {
    setWorking(true);
    setProblem(null);
    try {
      const photo = await redrawPhoto(file);
      URL.revokeObjectURL(photo.url);
      await send({ ...(field === "photo" ? { action: "evidence" } : {}), [field]: toBase64(photo.bytes), ...extra });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="evidence" id={id}>
      <p className="small" style={{ margin: "12px 0 6px" }}>
        <strong>Photos For The Operator</strong> <span className="muted">({count} of {MAX} added)</span>
      </p>
      <p className="hint" style={{ marginTop: 0 }}>
        What arrived, the packaging, a receipt of posting. Only the operator sees them, and they are deleted once the dispute is paid out. Your
        browser removes the location, device and time from each photo before it is sent. Cover any name or address label first.
      </p>
      {left > 0 && (
        <label className={`btn sm evidence-add${working ? " busy" : ""}`}>
          {working ? "Cleaning And Sending…" : "Add A Photo"}
          <input
            type="file"
            accept="image/*"
            hidden
            disabled={working}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void add(f);
            }}
          />
        </label>
      )}
      {problem && <p className="error small">{problem}</p>}
    </div>
  );
}

/** The seller offers part of the price back. They can change it, or withdraw it, until the winner accepts. */
export function SellerOffer({ current, send, extra, who, id }: { current: number | null; send: Send; extra?: Record<string, unknown>; who: string; id: string }) {
  const [pct, setPct] = useState(current ?? 50);
  const [busy, setBusy] = useState(false);
  const go = async (offer: number) => {
    setBusy(true);
    await send({ offer, ...extra });
    setBusy(false);
  };
  return (
    <div className="offer-box" id={id}>
      <p className="small" style={{ margin: "12px 0 6px" }}>
        <strong>Settle It Yourselves</strong>
      </p>
      <p className="hint" style={{ marginTop: 0 }}>
        Offer the {who} part of the price back. If they accept, the dispute ends at once, without the operator: they get that share back, you get the
        rest, and both bonds go back to their owners. 100% is a full refund, with your bond kept.
      </p>
      {current !== null && (
        <p className="small offer-standing">
          You offer <strong>{current}%</strong> of the price back. The {who} has not accepted yet.
        </p>
      )}
      <div className="row offer-row">
        <input
          type="number"
          min={1}
          max={100}
          step={1}
          inputMode="numeric"
          className="offer-pct"
          aria-label="Percent of the price to give back"
          value={pct}
          onChange={(e) => setPct(Math.max(1, Math.min(100, Math.round(Number(e.target.value) || 1))))}
        />
        <span className="small muted">% of the price</span>
        <button className="primary sm" disabled={busy || pct === current} onClick={() => void go(pct)}>
          {current === null ? `Offer ${pct}% Back` : `Change To ${pct}%`}
        </button>
        {current !== null && (
          <button className="sm" disabled={busy} onClick={() => void go(0)}>
            Withdraw The Offer
          </button>
        )}
      </div>
    </div>
  );
}

/** The winner sees the seller's offer and may accept it. */
export function WinnerOffer({ percent, send, id }: { percent: number; send: Send; id: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card accent offer-made" id={id} style={{ margin: "12px 0 0" }}>
      <strong>The seller offers {percent}% of the price back.</strong>
      <p className="small" style={{ margin: "6px 0 10px" }}>
        {percent === 100
          ? "That is a full refund. If you accept, the dispute ends now: your payment and your bond come back, and nobody is at fault."
          : `If you accept, the dispute ends now, without the operator: ${percent}% of the price and your bond come back to you, and the seller keeps the rest. Nobody is at fault.`}
      </p>
      <button
        className="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void send({ action: "accept_offer", percent }).finally(() => setBusy(false));
        }}
      >
        Accept {percent}% Back
      </button>
    </div>
  );
}

/** Said to both sides: the operator can't sit on a dispute for ever. */
export function DecideBy({ at }: { at: number | null | undefined }) {
  if (!at) return null;
  return (
    <p className="small muted decide-by">
      If the operator has not decided by {when(at)}, the price goes back to the buyer and both bonds go back to their owners. Nobody&apos;s money
      can be stuck.
    </p>
  );
}
