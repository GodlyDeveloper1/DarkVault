"use client";

// The tools either side has while a dispute is open, for every market:
//   - the site's request for proof, with its deadline, and the answer box
//     (silence loses the dispute);
//   - evidence photos (cleaned in this browser first, like listing photos: no
//     location, device or time survives the redraw);
//   - when the dispute ends by itself if it is never decided.
// One side wins the whole dispute. There are no offers and no splits.
// To both sides it is "the site" that asks and decides.
import Link from "next/link";
import { useState } from "react";
import { toBase64 } from "vault-core";
import { redrawPhoto } from "@/lib/photoClient";

const MAX = 3;

const when = (t: number | null | undefined) =>
  t ? new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "the time limit";

type Send = (body: Record<string, unknown>) => Promise<boolean>;

/** Up to three photos for the site. `field` is how the route names the photo ("photo" for the winner, "evidence" for the seller). */
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
        <strong>Your Photos</strong> <span className="muted">({count} of {MAX} added)</span>
      </p>
      <p className="hint" style={{ marginTop: 0 }}>
        What arrived, the packaging, a receipt of posting, an error on screen. Only the site sees them, never the other side, and they are deleted
        once the dispute is paid out. Your
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

export interface ProofAsk {
  side: "winner" | "seller";
  at: number;
  due: number;
  text: string;
  answered_at: number | null;
}

/**
 * The site's requests for proof to this side: the one waiting for an answer,
 * with its deadline and the answer box, and the ones already answered.
 */
export function ProofRequests({ requests, side, send, extra, id }: { requests: ProofAsk[]; side: "winner" | "seller"; send: Send; extra?: Record<string, unknown>; id: string }) {
  const mine = requests.filter((r) => r.side === side);
  const open = mine.find((r) => r.answered_at === null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  if (mine.length === 0) return null;
  const late = open ? Date.now() > open.due : false;
  return (
    <div className="proof-box" id={id}>
      {open ? (
        <div className={`card ${late ? "bad" : "accent"} proof-ask`}>
          <p className="proof-from">
            <strong>Dark Vault Needs Proof</strong>
          </p>
          <p className="small" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>
            {open.text}
          </p>
          <p className="small proof-due">
            {late ? (
              <strong>The time to answer has passed.</strong>
            ) : (
              <>
                Answer by <strong>{when(open.due)}</strong>. If nothing arrives by then, this dispute is decided against you.
              </>
            )}
          </p>
          {!late && (
            <>
              <label htmlFor={`${id}-text`}>Your Answer</label>
              <textarea
                id={`${id}-text`}
                className="proof-text"
                value={text}
                maxLength={600}
                onChange={(e) => setText(e.target.value)}
                placeholder="What happened, and what your photos show. Add your photos below too."
              />
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="primary send-proof"
                  disabled={busy || text.trim().length < 10}
                  onClick={() => {
                    setBusy(true);
                    void send({ ...(side === "winner" ? { action: "proof", text } : { proof: text }), ...extra })
                      .then((ok) => ok && setText(""))
                      .finally(() => setBusy(false));
                  }}
                >
                  {busy ? "Sending…" : "Send My Proof"}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <p className="small proof-sent">
          <strong className="ok">Your proof was sent</strong> on {when(mine[mine.length - 1]!.answered_at)}. The site will decide, or ask you for more.
        </p>
      )}
    </div>
  );
}

/** Said to both sides: nobody can sit on a dispute for ever. */
export function DecideBy({ at }: { at: number | null | undefined }) {
  if (!at) return null;
  return (
    <p className="small muted decide-by">
      If it is not decided by {when(at)}, everyone&apos;s own money goes back: the price to the buyer, and each bond to its owner. Nobody&apos;s
      money can be stuck.{" "}
      <Link href="/rules" target="_blank" className="dispute-rules-link">
        Read The Dispute Rules
      </Link>
    </p>
  );
}
