"use client";

// Delivery, as the seller and the winner see it.
//
// When a lot sells, the price is held in the auction's escrow vault. It goes to
// the seller once the lot has been handed over, or back to the winner if it
// was not.
//
// Everything secret here is sealed in the browser before it is sent:
//   - the lot key, by the seller's browser, to the winner's delivery key;
//   - shipping details, by the winner's browser, to the seller's key.
// The site passes the sealed envelopes on and can't open them. The one
// exception is a dispute over a digital lot, where the winner chooses to hand
// over their delivery key so the site can check who is right.
import { useEffect, useRef, useState } from "react";
import {
  bidToken,
  decryptLot,
  deliveryContext,
  formatCoins,
  lotKeyHash,
  open,
  openText,
  seal,
  sealText,
  sellerKeys,
  type LotHeader,
} from "vault-core";
import type { Ticket } from "@/lib/tickets";
import type { BidView, PublicAuction, SellerView } from "@/lib/views";

const when = (t: number | null) =>
  t ? new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "the time limit";

/** The same reasons, said to the winner. */
const REASON_WINNER: Record<string, string> = {
  confirmed: "You confirmed you have the lot.",
  "no-complaint": "You did not complain within the time limit.",
  "not-delivered": "The seller did not hand it over in time.",
  "no-shipping-details": "No shipping details were sent in time.",
  "wrong-key": "The key that was delivered does not open the lot.",
  "key-was-right": "The check showed the delivered key opens the lot.",
  operator: "The operator decided the dispute.",
};

const REASON: Record<string, string> = {
  confirmed: "The winner confirmed they have the lot.",
  "no-complaint": "The winner did not complain within the time limit.",
  "not-delivered": "The lot was not handed over in time.",
  "no-shipping-details": "The winner did not send shipping details in time.",
  "wrong-key": "The key that was delivered does not open the lot.",
  "key-was-right": "A dispute was opened, and the check showed the delivered key opens the lot.",
  operator: "A dispute was opened and the operator decided it.",
};

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "the request was refused");
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// Seller
// ---------------------------------------------------------------------------

export function SellerDelivery({
  auction,
  seller,
  manageKey,
  token,
  refresh,
}: {
  auction: PublicAuction;
  seller: SellerView;
  /** The raw manage key from the link. It stays in this browser: the seller's keys are derived from it. */
  manageKey: string;
  /** What the site is shown instead. */
  token: string;
  refresh: () => void;
}) {
  const d = seller.delivery;
  const kind = auction.delivery?.kind;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const sending = useRef(false);
  const url = `/api/auctions/${auction.id}/seller/delivery`;

  // Digital: hand the lot key over as soon as there is a winner, with no click.
  useEffect(() => {
    if (!d || d.kind !== "digital" || d.stage !== "awaiting-handover" || !d.winner_pub || sending.current) return;
    sending.current = true;
    void (async () => {
      try {
        const keys = await sellerKeys(manageKey);
        const envelope = await seal(d.winner_pub!, keys.lotKey, deliveryContext(auction.id, "lot-key"));
        await post(url, { "x-manage-key": token }, { envelope });
        setError(null);
        refresh();
      } catch (e) {
        setError(message(e));
        sending.current = false; // the next poll tries again
      }
    })();
  }, [d, auction.id, manageKey, token, url, refresh]);

  // Physical: open the winner's shipping details, here in the browser.
  const sealedAddress = d?.shipping?.envelope;
  useEffect(() => {
    if (!sealedAddress) return setAddress(null);
    let stop = false;
    void (async () => {
      try {
        const keys = await sellerKeys(manageKey);
        const text = await openText(keys.privateKey, sealedAddress, deliveryContext(auction.id, "shipping"));
        if (!stop) setAddress(text);
      } catch {
        if (!stop) setAddress("These shipping details could not be opened with your key.");
      }
    })();
    return () => {
      stop = true;
    };
  }, [sealedAddress, manageKey, auction.id]);

  async function shipped() {
    if (!d?.winner_pub) return;
    setBusy(true);
    setError(null);
    try {
      const envelope = note.trim() ? await sealText(d.winner_pub, note.trim(), deliveryContext(auction.id, "note")) : undefined;
      await post(url, { "x-manage-key": token }, envelope ? { envelope } : {});
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (!d) {
    if (!kind || auction.state === "settled") return null;
    return (
      <p className="small muted" style={{ margin: "12px 0 0" }} id="seller-delivery">
        {kind === "digital"
          ? "When the lot sells, the price is held. Keep this link: open it after the sale and your browser sends the winner the key. You are paid once they have it."
          : "When the lot sells, the price is held. Open this link after the sale to see where to send it. You are paid once the winner has it."}
      </p>
    );
  }

  return (
    <div id="seller-delivery" data-stage={d.stage} style={{ marginTop: 14 }}>
      <h3>Delivery</h3>
      {d.held != null && !d.resolution && (
        <p className="small">
          <strong>{formatCoins(d.held)} TAZ is held</strong> until the lot is handed over.
        </p>
      )}

      {d.stage === "awaiting-handover" && d.kind === "digital" && (
        <p className="small">
          <span className="spinner" aria-hidden="true" /> Sending the lot key to the winner, sealed so only they can open it…
        </p>
      )}

      {d.stage === "awaiting-address" && (
        <p className="small">
          Waiting for the winner to say where to send it. They have until {when(d.address_by)}; if they don&apos;t, the sale is undone and they
          are refunded.
        </p>
      )}

      {d.kind === "physical" && address && (
        <>
          <p className="small" style={{ marginBottom: 6 }}>
            <strong>Send it to:</strong> <span className="muted">(only your browser can read this)</span>
          </p>
          <pre className="sealed-text" id="shipping-details">
            {address}
          </pre>
        </>
      )}

      {d.stage === "awaiting-handover" && d.kind === "physical" && (
        <>
          <p className="small">Ship it by {when(d.deliver_by)}, then say so here. If you don&apos;t, the winner is refunded.</p>
          <label htmlFor="ship-note">Tracking number or a note for the winner (optional)</label>
          <input id="ship-note" value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} placeholder="Sealed so only the winner can read it" />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" id="mark-shipped" disabled={busy} onClick={() => void shipped()}>
              {busy ? "Saving…" : "I have shipped it"}
            </button>
          </div>
        </>
      )}

      {d.stage === "awaiting-confirmation" && (
        <p className="small" id="seller-waiting">
          {d.kind === "digital" ? "The key has been delivered." : "Marked as shipped."} You are paid as soon as the winner confirms, or on{" "}
          {when(d.dispute_by)} if they don&apos;t complain.
        </p>
      )}

      {d.stage === "disputed" && (
        <div className="card warn" style={{ marginBottom: 0 }}>
          <strong>The winner opened a dispute.</strong>
          {d.dispute?.reason && (
            <p className="small" style={{ margin: "8px 0 0", whiteSpace: "pre-wrap" }}>
              &ldquo;{d.dispute.reason}&rdquo;
            </p>
          )}
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            The price stays held until the operator decides.
          </p>
        </div>
      )}

      {d.resolution && (
        <p className="small" id="seller-resolution">
          <strong className={d.resolution.decision === "release" ? "ok" : "error"}>
            {d.resolution.decision === "release" ? "The price is released to you." : "The price went back to the winner."}
          </strong>{" "}
          {REASON[d.resolution.reason]}
        </p>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Winner
// ---------------------------------------------------------------------------

type Unlocked = { state: "working" } | { state: "open"; header: LotHeader; content: Uint8Array } | { state: "bad"; why: string } | { state: "no-key" };

export function WinnerDelivery({ auction, ticket, view, refresh }: { auction: PublicAuction; ticket: Ticket; view: BidView; refresh: () => void }) {
  const d = view.delivery!;
  const sellerPub = auction.delivery?.seller_pub;
  const url = `/api/auctions/${auction.id}/bids/${ticket.bid_id}/delivery`;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [complaining, setComplaining] = useState(false);
  const [reason, setReason] = useState("");
  const confirming = useRef(false);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await post(url, { "x-bid-token": await bidToken(ticket.nonce) }, body);
      refresh();
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Digital: open the envelope, check the key against the listing, decrypt the lot. All in this browser.
  const envelope = d.kind === "digital" ? d.envelope : null;
  useEffect(() => {
    if (!envelope || !d.lot) return setUnlocked(null);
    if (!ticket.delivery_key) return setUnlocked({ state: "no-key" });
    let stop = false;
    setUnlocked({ state: "working" });
    void (async () => {
      try {
        const lotKey = await open(ticket.delivery_key!, envelope, deliveryContext(auction.id, "lot-key"));
        if ((await lotKeyHash(lotKey)) !== d.lot!.key_hash) throw new Error("it is not the key the listing promised");
        const res = await fetch(`/api/auctions/${auction.id}/bids/${ticket.bid_id}/lot`, { headers: { "x-bid-token": await bidToken(ticket.nonce) } });
        if (!res.ok) throw new Error("the encrypted lot could not be downloaded");
        const lot = await decryptLot(lotKey, new Uint8Array(await res.arrayBuffer()));
        if (!stop) setUnlocked({ state: "open", ...lot });
      } catch (e) {
        if (!stop) setUnlocked({ state: "bad", why: e instanceof DOMException ? "it does not decrypt the lot" : message(e) });
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envelope, ticket.delivery_key, auction.id, ticket.bid_id]);

  // A lot that opened is a lot that was delivered: say so, which releases the seller's payment.
  useEffect(() => {
    if (unlocked?.state !== "open" || d.stage !== "awaiting-confirmation" || confirming.current) return;
    confirming.current = true;
    void act({ action: "confirm" }).then((done) => {
      if (!done) confirming.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked?.state, d.stage]);

  // Physical: the seller's note (a tracking number, say), sealed to this bid.
  const sealedNote = d.kind === "physical" ? d.envelope : null;
  useEffect(() => {
    if (!sealedNote || !ticket.delivery_key) return setNote(null);
    let stop = false;
    openText(ticket.delivery_key, sealedNote, deliveryContext(auction.id, "note"))
      .then((t) => !stop && setNote(t))
      .catch(() => !stop && setNote(null));
    return () => {
      stop = true;
    };
  }, [sealedNote, ticket.delivery_key, auction.id]);

  async function sendAddress(e: React.FormEvent) {
    e.preventDefault();
    if (!sellerPub || address.trim().length < 10) return;
    const envelope = await sealText(sellerPub, address.trim(), deliveryContext(auction.id, "shipping"));
    if (await act({ action: "shipping", envelope })) {
      setAddress("");
      setEditing(false);
    }
  }

  function save(header: LotHeader, content: Uint8Array) {
    const blob = new Blob([content.slice()], { type: header.type || "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = header.name || "lot";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const showAddressForm = d.kind === "physical" && (d.stage === "awaiting-address" || (editing && d.stage === "awaiting-handover"));

  return (
    <div id="winner-delivery" data-stage={d.stage} style={{ marginTop: 14 }}>
      <h3>Delivery</h3>
      {!d.resolution && <p className="small">Your payment is held and is not with the seller yet. It is released when you have the lot.</p>}

      {/* Digital */}
      {d.kind === "digital" && d.stage === "awaiting-handover" && (
        <p className="small">
          Waiting for the seller to send the key. If they don&apos;t by {when(d.deliver_by)}, your payment comes back.
        </p>
      )}
      {unlocked?.state === "working" && (
        <p className="small">
          <span className="spinner" aria-hidden="true" /> Unlocking the lot in your browser…
        </p>
      )}
      {unlocked?.state === "open" && (
        <div className="card accent" id="lot" style={{ marginBottom: 12 }}>
          <strong>Your lot</strong> <span className="muted small">(unlocked in this browser; the site can&apos;t read it)</span>
          {unlocked.header.kind === "text" ? (
            <pre className="sealed-text" id="lot-text">
              {new TextDecoder().decode(unlocked.content)}
            </pre>
          ) : (
            <p style={{ margin: "10px 0 0" }}>
              <button className="primary" id="lot-download" onClick={() => save(unlocked.header, unlocked.content)}>
                Download {unlocked.header.name || "the file"} ({Math.max(1, Math.round(unlocked.content.length / 1024))} KB)
              </button>
            </p>
          )}
        </div>
      )}
      {unlocked?.state === "bad" && !d.resolution && (
        <div className="card bad" id="lot-bad" style={{ marginBottom: 12 }}>
          <strong>The key the seller sent does not open the lot:</strong> {unlocked.why}.
          <p className="small" style={{ margin: "8px 0 12px" }}>
            Ask for your payment back. Your browser hands this bid&apos;s delivery key to the site, which repeats the check and refunds you if
            it fails. You have until {when(d.dispute_by)}.
          </p>
          <button className="primary" id="open-dispute" disabled={busy} onClick={() => void act({ action: "dispute", delivery_key: ticket.delivery_key })}>
            {busy ? "Checking…" : "Get my payment back"}
          </button>
        </div>
      )}
      {unlocked?.state === "no-key" && (
        <p className="error small">
          This browser doesn&apos;t hold this bid&apos;s delivery key, so it can&apos;t unlock the lot. Restore the ticket you saved when you bid.
        </p>
      )}

      {/* Physical */}
      {showAddressForm && (
        <form onSubmit={sendAddress} id="shipping-form">
          <label htmlFor="shipping">Where should the seller send it?</label>
          <textarea id="shipping" value={address} maxLength={1000} onChange={(e) => setAddress(e.target.value)} placeholder={"Name\nStreet and number\nPostcode, town\nCountry"} />
          <p className="hint">
            Sealed in your browser so only the seller can read it; the site can&apos;t.
            {d.stage === "awaiting-address" && <> Send it by {when(d.address_by)}, or the sale is undone and your payment comes back.</>}
          </p>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy || address.trim().length < 10}>
              {busy ? "Sealing…" : "Send to the seller"}
            </button>
            {editing && (
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
      {d.kind === "physical" && d.stage === "awaiting-handover" && !editing && (
        <p className="small" id="shipping-sent">
          Your shipping details are with the seller. They have until {when(d.deliver_by)} to ship; if they don&apos;t, your payment comes back.{" "}
          <button type="button" className="link small" onClick={() => setEditing(true)}>
            Correct the details
          </button>
        </p>
      )}
      {d.kind === "physical" && d.stage === "awaiting-confirmation" && (
        <>
          <p className="small">
            <strong>The seller has shipped it.</strong> Confirm when it arrives. If you say nothing by {when(d.dispute_by)}, the seller is paid.
          </p>
          {note && (
            <pre className="sealed-text" id="seller-note">
              {note}
            </pre>
          )}
        </>
      )}
      {d.kind === "physical" && (d.stage === "awaiting-handover" || d.stage === "awaiting-confirmation") && !complaining && !editing && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" id="confirm-received" disabled={busy} onClick={() => void act({ action: "confirm" })}>
            I have received it
          </button>
          {d.stage === "awaiting-confirmation" && (
            <button type="button" id="complain" onClick={() => setComplaining(true)}>
              Something is wrong
            </button>
          )}
        </div>
      )}
      {complaining && d.stage === "awaiting-confirmation" && (
        <form
          id="dispute-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act({ action: "dispute", reason }).then((done) => done && setComplaining(false));
          }}
        >
          <label htmlFor="reason">What is wrong?</label>
          <textarea id="reason" value={reason} maxLength={600} onChange={(e) => setReason(e.target.value)} placeholder="It has not arrived, or it is not what was described." />
          <p className="hint">The seller and the operator of this site can read this. Your payment stays held until the operator decides.</p>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy || reason.trim().length < 10}>
              Open a dispute
            </button>
            <button type="button" onClick={() => setComplaining(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {d.stage === "disputed" && (
        <p className="small" id="dispute-open">
          <strong>Your dispute is open.</strong> Your payment stays held until the operator decides.
        </p>
      )}

      {d.resolution && (
        <p className="small" id="winner-resolution">
          <strong className={d.resolution.decision === "refund" ? "ok" : undefined}>
            {d.resolution.decision === "refund" ? "Your payment is coming back to you." : "Your payment went to the seller."}
          </strong>{" "}
          {REASON_WINNER[d.resolution.reason]}
        </p>
      )}
      {d.refund && (
        <dl className="kv">
          <dt>Returned to you</dt>
          <dd>
            {formatCoins(d.refund.paid)} TAZ <span className="muted">(after {formatCoins(d.refund.owed - d.refund.paid)} network fee)</span>
          </dd>
          <dt>Transaction ({d.refund.status})</dt>
          <dd>{d.refund.txid.slice(0, 16)}…</dd>
        </dl>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
