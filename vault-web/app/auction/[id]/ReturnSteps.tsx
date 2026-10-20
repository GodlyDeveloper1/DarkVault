"use client";

// A return, for both sides. The buyer won a dispute over a posted item and
// sends it back before the refund:
//   1. the seller says where it should go, sealed in their browser so only the
//      buyer can read it (the site passes it on and can't);
//   2. the buyer posts it back and says so, with an optional note (a tracking
//      number) sealed so only the seller can read it;
//   3. the seller says it is back, or that what came back is wrong.
// Each step has a deadline, and whoever misses theirs loses the return.
import { useEffect, useState } from "react";
import { deliveryContext, openText, sealText, sellerKeys } from "vault-core";

export interface ReturnView {
  at: number;
  address_by: number;
  address: string | null;
  address_at: number | null;
  send_by: number | null;
  sent_at: number | null;
  note: string | null;
  confirm_by: number | null;
  problem: string | null;
}

type Send = (body: Record<string, unknown>) => Promise<boolean>;

const when = (t: number | null | undefined) =>
  t ? new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "the time limit";

/** Opens a sealed text in this browser; null until it is open, or if it can't be. */
function useOpened(envelope: string | null, open: (envelope: string) => Promise<string>): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!envelope) return setText(null);
    let stop = false;
    open(envelope)
      .then((t) => !stop && setText(t))
      .catch(() => !stop && setText(null));
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envelope]);
  return text;
}

export function SellerReturn({
  auctionId,
  r,
  winnerPub,
  manageKey,
  send,
  who,
  extra,
  id,
}: {
  auctionId: string;
  r: ReturnView;
  winnerPub: string | null;
  manageKey: string;
  send: Send;
  who: string;
  /** Order Flow: which unit this return is for. */
  extra?: Record<string, unknown>;
  id?: string;
}) {
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState("");
  const [reporting, setReporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const note = useOpened(r.note, async (e) => openText((await sellerKeys(manageKey)).privateKey, e, deliveryContext(auctionId, "return-note")));

  const go = async (body: Record<string, unknown>) => {
    setBusy(true);
    const ok = await send({ ...body, ...extra });
    setBusy(false);
    return ok;
  };

  return (
    <div className="card return-card" id={id ?? "seller-return"}>
      <p className="proof-from">
        <strong>The Item Is Coming Back</strong>
      </p>
      {r.problem ? (
        <p className="small" style={{ margin: "6px 0 0" }}>
          You said what came back is wrong: &ldquo;{r.problem}&rdquo; The site has asked you both for proof and will decide.
        </p>
      ) : !r.address_at ? (
        <>
          <p className="small" style={{ margin: "6px 0 0" }}>
            The site decided the {who} is right. They get their payment back once the item is on its way back to you. Say where it should go by{" "}
            <strong>{when(r.address_by)}</strong>. If you don&apos;t, the {who} is refunded and keeps the item.
          </p>
          <label htmlFor="return-address">Your Return Address</label>
          <textarea
            id="return-address"
            value={address}
            maxLength={1000}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={"Name\nStreet and number\nPostcode, town\nCountry"}
          />
          <p className="hint">Sealed in your browser so only the {who} can read it; the site can&apos;t.</p>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="primary"
              id="send-return-address"
              disabled={busy || !winnerPub || address.trim().length < 10}
              onClick={() =>
                void (async () => {
                  const envelope = await sealText(winnerPub!, address.trim(), deliveryContext(auctionId, "return-address"));
                  if (await go({ return_address: envelope })) setAddress("");
                })()
              }
            >
              {busy ? "Sealing…" : "Send My Return Address"}
            </button>
          </div>
        </>
      ) : !r.sent_at ? (
        <p className="small" style={{ margin: "6px 0 0" }}>
          Your return address is with the {who}. They must post it back by <strong>{when(r.send_by)}</strong>. If they don&apos;t, you are paid, with
          their bond.
        </p>
      ) : (
        <>
          <p className="small" style={{ margin: "6px 0 0" }}>
            <strong>The {who} has posted it back.</strong> When it arrives, say so. If you say nothing by <strong>{when(r.confirm_by)}</strong>, the {who}{" "}
            is refunded.
          </p>
          {note && (
            <pre className="sealed-text" id="return-note">
              {note}
            </pre>
          )}
          {!reporting ? (
            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" id="return-received" disabled={busy} onClick={() => void go({ return_received: true })}>
                I Have It Back
              </button>
              <button type="button" id="return-problem-open" disabled={busy} onClick={() => setReporting(true)}>
                What Came Back Is Wrong
              </button>
            </div>
          ) : (
            <>
              <label htmlFor="return-problem">What Is Wrong With What Came Back?</label>
              <textarea id="return-problem" value={problem} maxLength={600} onChange={(e) => setProblem(e.target.value)} placeholder="A different item, an empty box, damage that wasn't there." />
              <p className="hint">The site then asks you both for proof and decides. Faked claims lose.</p>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="primary" id="return-problem-send" disabled={busy || problem.trim().length < 10} onClick={() => void go({ return_problem: problem })}>
                  Report It
                </button>
                <button type="button" onClick={() => setReporting(false)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export function WinnerReturn({ auctionId, r, deliveryKey, sellerPub, act }: { auctionId: string; r: ReturnView; deliveryKey: string | undefined; sellerPub: string | undefined; act: Send }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const address = useOpened(r.address, (e) => openText(deliveryKey!, e, deliveryContext(auctionId, "return-address")));

  return (
    <div className="card return-card" id="winner-return">
      <p className="proof-from">
        <strong>Send It Back To Get Your Money</strong>
      </p>
      {r.problem ? (
        <p className="small" style={{ margin: "6px 0 0" }}>
          The seller says what came back is not what they sent: &ldquo;{r.problem}&rdquo; The site has asked you both for proof and will decide.
        </p>
      ) : !r.address_at ? (
        <p className="small" style={{ margin: "6px 0 0" }}>
          The site decided you are right. Your payment comes back, with the seller&apos;s bond, once the item is on its way back. Waiting for the
          seller&apos;s return address, until <strong>{when(r.address_by)}</strong>. If it doesn&apos;t come, you are refunded and keep the item.
        </p>
      ) : !r.sent_at ? (
        <>
          <p className="small" style={{ margin: "6px 0 6px" }}>
            Post it back by <strong>{when(r.send_by)}</strong>, then say so here. Use tracked post. If you don&apos;t, the seller is paid and you lose
            your bond.
          </p>
          <p className="small" style={{ marginBottom: 6 }}>
            <strong>Send it to:</strong> <span className="muted">(only your browser can read this)</span>
          </p>
          <pre className="sealed-text" id="return-address-open">
            {address ?? (deliveryKey ? "Opening…" : "This browser doesn't hold this purchase's key. Restore your ticket file to read it.")}
          </pre>
          <label htmlFor="return-tracking">Tracking Number Or A Note For The Seller (Optional)</label>
          <input id="return-tracking" value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} placeholder="Sealed so only the seller can read it" />
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="primary"
              id="return-sent"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  const envelope = note.trim() && sellerPub ? await sealText(sellerPub, note.trim(), deliveryContext(auctionId, "return-note")) : undefined;
                  await act(envelope ? { action: "returned", envelope } : { action: "returned" });
                  setBusy(false);
                })()
              }
            >
              {busy ? "Saving…" : "I Have Posted It Back"}
            </button>
          </div>
        </>
      ) : (
        <p className="small" style={{ margin: "6px 0 0" }}>
          <strong className="ok">Posted back.</strong> The seller has until <strong>{when(r.confirm_by)}</strong> to say it arrived or that something is
          wrong. Then your payment comes back, with the seller&apos;s bond.
        </p>
      )}
    </div>
  );
}
