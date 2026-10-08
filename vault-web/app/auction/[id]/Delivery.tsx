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
  listingKey,
  lotKeyHash,
  open,
  openText,
  seal,
  sealText,
  sellerKeys,
  unitLotKey,
  type LotHeader,
} from "vault-core";
import { inviteFor } from "@/lib/invites";
import { tokenOf, type Ticket } from "@/lib/tickets";
import type { BidView, PublicAuction, SellerView } from "@/lib/views";

const when = (t: number | null) =>
  t ? new Date(t).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "the time limit";

/**
 * A deal (the Settlement market) is not an auction: it has a buyer, not a
 * winner, and an item, not a lot. The handover is the same, so the same two
 * components serve both, with these words swapped in.
 */
interface Words {
  winner: string;
  lot: string;
  sale: string;
  auction: string;
  /** What the buyer's ticket is for: a bid, or (in a deal) a payment. */
  bid: string;
  /** When the ticket was saved. */
  bidding: string;
}
const wordsFor = (auction: PublicAuction): Words =>
  auction.deal
    ? { winner: "buyer", lot: "item", sale: "deal", auction: "deal", bid: "payment", bidding: "when you accepted the deal" }
    : auction.batch
      ? // Order Flow: a batch sale has buyers, each of one unit, and orders in place of bids.
        { winner: "buyer", lot: "unit", sale: "sale", auction: "sale", bid: "order", bidding: "when you placed your order" }
      : { winner: "winner", lot: "lot", sale: "sale", auction: "auction", bid: "bid", bidding: "when you bid" };

/** Why the delivery ended the way it did, said to the winner and to the seller. */
const whyWinner = (t: Words): Record<string, string> => ({
  confirmed: `You confirmed you have the ${t.lot}.`,
  "as-described": `You confirmed the ${t.lot} is what was described.`,
  "no-complaint": "You did not complain within the time limit.",
  "not-delivered": "The seller did not hand it over in time.",
  "no-shipping-details": "No shipping details were sent in time.",
  "wrong-key": `The key that was delivered does not open the ${t.lot}.`,
  "key-was-right": `The check showed the delivered key opens the ${t.lot}.`,
  operator: "The operator decided the dispute.",
});
const whySeller = (t: Words): Record<string, string> => ({
  confirmed: `The ${t.winner} confirmed they have the ${t.lot}.`,
  "as-described": `The ${t.winner} confirmed the ${t.lot} is what was described.`,
  "no-complaint": `The ${t.winner} did not complain within the time limit.`,
  "not-delivered": `The ${t.lot} was not handed over in time.`,
  "no-shipping-details": `The ${t.winner} did not send shipping details in time.`,
  "wrong-key": `The key that was delivered does not open the ${t.lot}.`,
  "key-was-right": `A dispute was opened, and the check showed the delivered key opens the ${t.lot}.`,
  operator: "The operator decided the dispute.",
});

type Resolution = { decision: string; reason: string; fault: string };

/** What the outcome means for the winner's money, bonds included. */
function winnerOutcome(r: Resolution, bonds: boolean): string {
  if (r.decision === "release") {
    if (!bonds) return "Your payment went to the seller.";
    return r.fault === "winner" ? "Your payment went to the seller, and so did your bond." : "Your payment went to the seller. Your bond comes back to you.";
  }
  if (!bonds) return "Your payment is coming back to you.";
  if (r.fault === "seller") return "Your payment and your bond are coming back to you, with the seller's bond on top.";
  if (r.fault === "winner") return "Your payment is coming back to you, but your bond went to the seller.";
  return "Your payment and your bond are coming back to you.";
}

/** What the outcome means for the seller's money, bonds included. */
function sellerOutcome(r: Resolution, bonds: boolean, t: Words): string {
  if (r.decision === "release") {
    if (!bonds) return "The price is released to you.";
    return r.fault === "winner" ? `The price is released to you, with your bond and the ${t.winner}'s bond.` : "The price is released to you, with your bond.";
  }
  if (!bonds) return `The price went back to the ${t.winner}.`;
  if (r.fault === "seller") return `The price went back to the ${t.winner}, and so did your bond.`;
  if (r.fault === "winner") return `The price went back to the ${t.winner}. You keep your bond and receive theirs.`;
  return `The price went back to the ${t.winner}. Your bond comes back to you.`;
}

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

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
  unit,
}: {
  auction: PublicAuction;
  seller: SellerView;
  /** The raw manage key from the link. It stays in this browser: the seller's keys are derived from it. */
  manageKey: string;
  /** What the site is shown instead. */
  token: string;
  refresh: () => void;
  /**
   * Order Flow: this is the handover of one unit of a batch sale. Each unit
   * has its own buyer, its own escrow and its own key; the seller's requests
   * say which unit they are about.
   */
  unit?: { number: number; delivery: SellerView["delivery"] };
}) {
  const d = unit ? unit.delivery : seller.delivery;
  /** Sent with every request about a unit. */
  const which = unit ? { unit: unit.number } : {};
  const t = wordsFor(auction);
  const kind = auction.delivery?.kind;
  const promise = kind === "promise";
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [reply, setReply] = useState("");
  const sending = useRef(false);
  const url = `/api/auctions/${auction.id}/seller/delivery`;

  // Digital: hand the lot key over as soon as there is a winner, with no click.
  useEffect(() => {
    if (!d || d.kind !== "digital" || d.stage !== "awaiting-handover" || !d.winner_pub || sending.current) return;
    sending.current = true;
    void (async () => {
      try {
        // A unit of a batch sale is encrypted with a key of its own.
        const lotKey = unit ? await unitLotKey(manageKey, unit.number - 1) : (await sellerKeys(manageKey)).lotKey;
        const envelope = await seal(d.winner_pub!, lotKey, deliveryContext(auction.id, "lot-key"));
        await post(url, { "x-manage-key": token }, { envelope, ...which });
        setError(null);
        refresh();
      } catch (e) {
        setError(message(e));
        sending.current = false; // the next poll tries again
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, auction.id, manageKey, token, url, refresh, unit?.number]);

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
      await post(url, { "x-manage-key": token }, envelope ? { envelope, ...which } : { ...which });
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function answer() {
    setBusy(true);
    setError(null);
    try {
      await post(url, { "x-manage-key": token }, { reply, ...which });
      setReply("");
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  if (!d) {
    if (unit || !kind || auction.state === "settled" || auction.state === "funding") return null;
    return (
      <p className="small muted" style={{ margin: "12px 0 0" }} id="seller-delivery">
        {kind === "digital"
          ? `When the ${t.lot} sells, the price is held. Keep this link: open it after the ${t.sale} and your browser sends the ${t.winner} the key. You are paid once they have it.`
          : promise
            ? `When the ${t.lot} sells, the price is held. Open this link after the ${t.sale} to read what the ${t.winner} wants. You are paid once it is done and they confirm.`
            : `When the ${t.lot} sells, the price is held. Open this link after the ${t.sale} to see where to send it. You are paid once the ${t.winner} has it.`}
      </p>
    );
  }

  return (
    <div id={unit ? undefined : "seller-delivery"} className={unit ? "unit-delivery" : undefined} data-unit={unit?.number} data-stage={d.stage} style={{ marginTop: unit ? 8 : 14 }}>
      {!unit && <h3>Delivery</h3>}
      {d.held != null && !d.resolution && (
        <p className="small">
          <strong>{formatCoins(d.held)} TAZ is held</strong> until {promise ? "the promise is kept" : `the ${t.lot} is handed over`}.
        </p>
      )}

      {d.stage === "awaiting-handover" && d.kind === "digital" && (
        <p className="small">
          <span className="spinner" aria-hidden="true" /> Sending the {t.lot} key to the {t.winner}, sealed so only they can open it…
        </p>
      )}

      {d.stage === "awaiting-address" && (
        <p className="small">
          Waiting for the {t.winner} to say {promise ? "what they want" : "where to send it"}. They have until {when(d.address_by)}; if they don&apos;t,
          the {t.sale} is undone and they are refunded.
        </p>
      )}

      {d.kind !== "digital" && address && (
        <>
          <p className="small" style={{ marginBottom: 6 }}>
            <strong>{promise ? `The ${t.winner} asks for:` : "Send it to:"}</strong> <span className="muted">(only your browser can read this)</span>
          </p>
          <pre className="sealed-text" id="shipping-details">
            {address}
          </pre>
        </>
      )}

      {d.stage === "awaiting-handover" && d.kind !== "digital" && (
        <>
          <p className="small">
            {promise ? "Do it" : "Ship it"} by {when(d.deliver_by)}, then say so here. If you don&apos;t, the {t.winner} is refunded.
          </p>
          <label htmlFor="ship-note">{promise ? `A note or proof for the ${t.winner} (optional)` : `Tracking number or a note for the ${t.winner} (optional)`}</label>
          <input id="ship-note" value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} placeholder={`Sealed so only the ${t.winner} can read it`} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" id="mark-shipped" disabled={busy} onClick={() => void shipped()}>
              {busy ? "Saving…" : promise ? "It is done" : "I have shipped it"}
            </button>
          </div>
        </>
      )}

      {d.stage === "awaiting-confirmation" && (
        <p className="small seller-waiting" id={unit ? undefined : "seller-waiting"}>
          {d.kind === "digital" ? `The key has been delivered. The ${t.winner} can now open the ${t.lot} and check it.` : promise ? "Marked as done." : "Marked as shipped."} You are paid
          as soon as the {t.winner} confirms, or on {when(d.dispute_by)} if they don&apos;t complain.
        </p>
      )}

      {d.stage === "disputed" && d.dispute && (
        <div className="card warn seller-dispute" style={{ marginBottom: 0 }} id={unit ? undefined : "seller-dispute"}>
          <strong>{d.dispute.kind === "not-as-described" ? `The ${t.winner} says the ${t.lot} is not what was described.` : `The ${t.winner} opened a dispute.`}</strong>
          {d.dispute.reason && (
            <p className="small" style={{ margin: "8px 0 0", whiteSpace: "pre-wrap" }}>
              &ldquo;{d.dispute.reason}&rdquo;
            </p>
          )}
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            The price stays held until the operator decides.
            {d.dispute.kind === "not-as-described" && ` The operator can open the ${t.lot} you delivered and compare it with your description.`}
            {d.seller_bond > 0 && " Whoever loses the dispute also loses their bond to the other side."}
          </p>
          {d.dispute.seller_reply ? (
            <p className="small seller-reply-sent" style={{ margin: "10px 0 0", whiteSpace: "pre-wrap" }} id={unit ? undefined : "seller-reply-sent"}>
              <strong>Your answer:</strong> &ldquo;{d.dispute.seller_reply}&rdquo;
            </p>
          ) : (
            <>
              <label htmlFor={unit ? `reply-u${unit.number}` : "reply"}>Your answer, for the operator</label>
              <textarea id={unit ? `reply-u${unit.number}` : "reply"} className="reply-text" value={reply} maxLength={600} onChange={(e) => setReply(e.target.value)} placeholder="What you sent, and why it matches the description." />
              <div className="row" style={{ marginTop: 10 }}>
                <button className="primary send-reply" id={unit ? undefined : "send-reply"} disabled={busy || reply.trim().length < 10} onClick={() => void answer()}>
                  {busy ? "Sending…" : "Send my answer"}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {d.resolution && (
        <p className="small seller-resolution" id={unit ? undefined : "seller-resolution"}>
          <strong className={d.resolution.decision === "release" ? "ok" : "error"}>{sellerOutcome(d.resolution, d.seller_bond + d.buyer_bond > 0, t)}</strong>{" "}
          {d.kind === "digital" && d.resolution.reason === "no-complaint"
            ? `The ${t.winner} unlocked nothing or said nothing within the time limit.`
            : promise && d.resolution.reason === "no-shipping-details"
              ? `The ${t.winner} did not say what they wanted in time.`
              : promise && d.resolution.reason === "confirmed"
                ? `The ${t.winner} confirmed it was done.`
                : promise && d.resolution.reason === "not-delivered"
                  ? "It was not marked as done in time."
                  : whySeller(t)[d.resolution.reason]}
        </p>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Winner
// ---------------------------------------------------------------------------

type Unlocked =
  | { state: "working" }
  | { state: "open"; header: LotHeader; content: Uint8Array; lotKey: string }
  | { state: "bad"; why: string }
  | { state: "no-key" };

export function WinnerDelivery({ auction, ticket, view, refresh }: { auction: PublicAuction; ticket: Ticket; view: BidView; refresh: () => void }) {
  const d = view.delivery!;
  const t = wordsFor(auction);
  const promise = d.kind === "promise";
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

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await post(url, { "x-bid-token": await tokenOf(ticket) }, body);
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
        if ((await lotKeyHash(lotKey)) !== d.lot!.key_hash) throw new Error(auction.deal ? "it is not the key the deal promised" : "it is not the key the listing promised");
        const res = await fetch(`/api/auctions/${auction.id}/bids/${ticket.bid_id}/lot`, { headers: { "x-bid-token": await tokenOf(ticket) } });
        if (!res.ok) throw new Error(`the encrypted ${t.lot} could not be downloaded`);
        const lot = await decryptLot(lotKey, new Uint8Array(await res.arrayBuffer()));
        if (!stop) setUnlocked({ state: "open", ...lot, lotKey: toHex(lotKey) });
      } catch (e) {
        if (!stop) setUnlocked({ state: "bad", why: e instanceof DOMException ? `it does not decrypt the ${t.lot}` : message(e) });
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envelope, ticket.delivery_key, auction.id, ticket.bid_id]);

  // Physical: the seller's note (a tracking number, say), sealed to this bid.
  const sealedNote = d.kind !== "digital" ? d.envelope : null;
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

  /**
   * A private auction's description is encrypted, and the operator has to read
   * it to decide a dispute. The complaint carries the key to the listing (to
   * that text and nothing else), handed over by this browser.
   */
  async function listingForOperator(): Promise<Record<string, string>> {
    if (!auction.private) return {};
    const invite = (await inviteFor(auction.id)) ?? ticket.invite;
    return invite ? { listing_key: await listingKey(invite) } : {};
  }

  /** What the winner stands to lose by opening a dispute and losing it, and what the seller does. Said before either is asked to act. */
  const stakes =
    d.buyer_bond > 0 || d.seller_bond > 0 ? (
      <p className="small muted" id="winner-stakes">
        {d.buyer_bond > 0 && <>Your bond of {formatCoins(d.buyer_bond)} TAZ comes back with a completed {t.sale}. You lose it to the seller only if you open a dispute and lose it. </>}
        {d.seller_bond > 0 && <>The seller has {formatCoins(d.seller_bond)} TAZ of their own at stake, which goes to you if they are found at fault.</>}
      </p>
    ) : null;

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

  const showAddressForm = d.kind !== "digital" && (d.stage === "awaiting-address" || (editing && d.stage === "awaiting-handover"));

  return (
    <div id="winner-delivery" data-stage={d.stage} style={{ marginTop: 14 }}>
      <h3>Delivery</h3>
      {!d.resolution && <p className="small">Your payment is held until the handover is complete.</p>}

      {/* Digital */}
      {d.kind === "digital" && d.stage === "awaiting-handover" && (
        <p className="small">
          Waiting for the seller to send the key. If they don&apos;t by {when(d.deliver_by)}, your payment comes back.
        </p>
      )}
      {unlocked?.state === "working" && (
        <p className="small">
          <span className="spinner" aria-hidden="true" /> Unlocking the {t.lot} in your browser…
        </p>
      )}
      {unlocked?.state === "open" && (
        <div className="card accent" id="lot" style={{ marginBottom: 12 }}>
          <strong>Your {t.lot}</strong>{" "}
          <span className="muted small">{auction.practice ? "(unlocked in this browser)" : "(unlocked in this browser; the site can't read it)"}</span>

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
      {unlocked?.state === "open" && d.stage === "awaiting-confirmation" && !complaining && (
        <div id="review">
          <p className="small" id="review-deadline">
            <strong>Check it.</strong> You have until {when(d.dispute_by)} to open a dispute if it is not what was described. After that the {t.sale}{" "}
            is final.
          </p>
          {stakes}
          <div className="row">
            <button className="primary" id="confirm-described" disabled={busy} onClick={() => void act({ action: "confirm" })}>
              It is what was described
            </button>
            <button type="button" id="complain" onClick={() => setComplaining(true)}>
              This is not what was described
            </button>
          </div>
        </div>
      )}
      {unlocked?.state === "open" && complaining && d.stage === "awaiting-confirmation" && (
        <form
          id="dispute-form"
          onSubmit={(e) => {
            e.preventDefault();
            void listingForOperator()
              .then((listing) => act({ action: "dispute", lot_key: unlocked.lotKey, reason, ...listing }))
              .then((done) => done && setComplaining(false));
          }}
        >
          <label htmlFor="reason">What is wrong with it?</label>
          <textarea id="reason" value={reason} maxLength={600} onChange={(e) => setReason(e.target.value)} placeholder="How it differs from the description." />
          <p className="hint">
            Your browser hands the operator the key to this one {t.lot}, so they can open exactly what was delivered and compare it with the
            description.{auction.private && ` This ${t.auction} is private, so your browser also hands over the key to its description (to that text and nothing else).`} The
            seller and the operator can read what you write. Your payment stays held until the operator decides.
            {d.buyer_bond > 0 && <> If the operator finds the {t.lot} is as described, your bond of {formatCoins(d.buyer_bond)} TAZ goes to the seller.</>}
          </p>
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
      {unlocked?.state === "bad" && !d.resolution && (
        <div className="card bad" id="lot-bad" style={{ marginBottom: 12 }}>
          <strong>The key the seller sent does not open the {t.lot}:</strong> {unlocked.why}.
          <p className="small" style={{ margin: "8px 0 12px" }}>
            Ask for your payment back. Your browser hands this {t.bid}&apos;s delivery key to the site, which repeats the check and refunds you if
            it fails. You have until {when(d.dispute_by)}.
          </p>
          <button className="primary" id="open-dispute" disabled={busy} onClick={() => void act({ action: "dispute", delivery_key: ticket.delivery_key })}>
            {busy ? "Checking…" : d.seller_bond > 0 ? "Get my payment back, with the seller's bond" : "Get my payment back"}
          </button>
        </div>
      )}
      {unlocked?.state === "no-key" && (
        <p className="error small">
          This browser doesn&apos;t hold this {t.bid}&apos;s delivery key, so it can&apos;t unlock the {t.lot}. Restore the ticket you saved {t.bidding}.
        </p>
      )}

      {/* Physical */}
      {showAddressForm && (
        <form onSubmit={sendAddress} id="shipping-form">
          <label htmlFor="shipping">{promise ? "What should the seller do for you?" : "Where should the seller send it?"}</label>
          <textarea
            id="shipping"
            value={address}
            maxLength={1000}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={promise ? "The name you choose, or exactly what you want done." : "Name\nStreet and number\nPostcode, town\nCountry"}
          />
          <p className="hint">
            Sealed in your browser so only the seller can read it; the site can&apos;t.
            {d.stage === "awaiting-address" && <> Send it by {when(d.address_by)}, or the {t.sale} is undone and your payment comes back.</>}
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
      {d.kind !== "digital" && d.stage === "awaiting-handover" && !editing && (
        <p className="small" id="shipping-sent">
          {promise ? "Your request is" : "Your shipping details are"} with the seller. They have until {when(d.deliver_by)} to{" "}
          {promise ? "do it" : "ship"}; if they don&apos;t, your payment comes back.{" "}
          <button type="button" className="link small" onClick={() => setEditing(true)}>
            {promise ? "Correct my request" : "Correct the details"}
          </button>
        </p>
      )}
      {d.kind !== "digital" && d.stage === "awaiting-confirmation" && (
        <>
          <p className="small">
            <strong>{promise ? "The seller says it is done." : "The seller has shipped it."}</strong>{" "}
            {promise ? "Confirm once you have seen it." : "Confirm when it arrives."} You have until {when(d.dispute_by)} to open a dispute if
            something is wrong. After that the {t.sale} is final.
          </p>
          {stakes}
          {note && (
            <pre className="sealed-text" id="seller-note">
              {note}
            </pre>
          )}
        </>
      )}
      {d.kind !== "digital" && (d.stage === "awaiting-handover" || d.stage === "awaiting-confirmation") && !complaining && !editing && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" id="confirm-received" disabled={busy} onClick={() => void act({ action: "confirm" })}>
            {promise ? "It has been done" : "I have received it"}
          </button>
          {d.stage === "awaiting-confirmation" && (
            <button type="button" id="complain" onClick={() => setComplaining(true)}>
              Something is wrong
            </button>
          )}
        </div>
      )}
      {d.kind !== "digital" && complaining && d.stage === "awaiting-confirmation" && (
        <form
          id="dispute-form"
          onSubmit={(e) => {
            e.preventDefault();
            void listingForOperator()
              .then((listing) => act({ action: "dispute", reason, ...listing }))
              .then((done) => done && setComplaining(false));
          }}
        >
          <label htmlFor="reason">What is wrong?</label>
          <textarea id="reason" value={reason} maxLength={600} onChange={(e) => setReason(e.target.value)} placeholder={promise ? "It was not done, or not as promised." : "It has not arrived, or it is not what was described."} />
          <p className="hint">
            The seller and the operator of this site can read this.{auction.private && ` This ${t.auction} is private, so your browser also hands the operator the key to its description (to that text and nothing else), so they can see what was promised.`} Your
            payment stays held until the operator decides.
            {d.buyer_bond > 0 && <> If the operator decides against you, your bond of {formatCoins(d.buyer_bond)} TAZ goes to the seller.</>}
          </p>
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
        <div id="dispute-open">
          <p className="small">
            <strong>Your dispute is open.</strong> Your payment stays held until the operator decides.
          </p>
          {d.dispute?.seller_reply && (
            <p className="small" style={{ whiteSpace: "pre-wrap" }} id="seller-reply">
              <strong>The seller answered:</strong> &ldquo;{d.dispute.seller_reply}&rdquo;
            </p>
          )}
        </div>
      )}

      {d.resolution && (
        <p className="small" id="winner-resolution">
          <strong className={d.resolution.decision === "refund" ? "ok" : undefined}>{winnerOutcome(d.resolution, d.seller_bond + d.buyer_bond > 0)}</strong>{" "}
          {promise && d.resolution.reason === "no-shipping-details"
            ? "You did not say what you wanted in time."
            : promise && d.resolution.reason === "confirmed"
              ? "You confirmed it was done."
              : promise && d.resolution.reason === "not-delivered"
                ? "The seller did not do it in time."
                : whyWinner(t)[d.resolution.reason]}
        </p>
      )}
      {d.refund && (
        <dl className="kv" id="winner-payout">
          <dt>Sent to you</dt>
          <dd>
            {formatCoins(d.refund.paid)} TAZ{" "}
            {d.refund.owed > d.refund.paid && <span className="muted">(after {formatCoins(d.refund.owed - d.refund.paid)} network fee)</span>}
          </dd>
          <dt>Transaction ({d.refund.status})</dt>
          <dd>{d.refund.txid.slice(0, 16)}…</dd>
        </dl>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
