"use client";

// The way into a private auction.
//
// The server sends nothing about a private auction with the page: it can't
// know whether this browser was invited, because the invite key travels in the
// link's #fragment and never reaches it. This component reads the key here,
// shows the site the access token derived from it, and only then is given the
// auction, with its listing still encrypted. AuctionRoom opens the listing.
//
// An invite is remembered only once it has opened the auction. A link with a
// wrong key therefore can't replace, or remove, an invite that works.
//
// A private deal (the Settlement market) comes in through the same gate and
// opens into DealRoom. The gate says the same thing for both, at either
// address, so a locked page doesn't tell a stranger which of the two it is.
import { useCallback, useEffect, useState } from "react";
import { inviteFromManage, inviteFromText, isInviteKey } from "vault-core";
import { headersOf, inviteFor, rememberInvite } from "@/lib/invites";
import { WALLET_EVENT } from "@/lib/tickets";
import type { PublicAuction } from "@/lib/views";
import DealRoom from "@/app/deal/[id]/DealRoom";
import AuctionRoom from "./AuctionRoom";

type State = { step: "checking" } | { step: "locked"; wrong: boolean } | { step: "open"; auction: PublicAuction; now: number };

export default function PrivateGate({ id }: { id: string }) {
  const [state, setState] = useState<State>({ step: "checking" });
  const [pasted, setPasted] = useState("");

  /** Tries invites in order: the ones just given (a link, a pasted invite), then the one this browser already holds. */
  const enter = useCallback(
    async (given: string[] = []) => {
      const held = await inviteFor(id);
      const candidates = [...new Set([...given, ...(held ? [held] : [])])];
      let refused = false;
      for (const invite of candidates) {
        try {
          const res = await fetch(`/api/auctions/${id}`, { headers: await headersOf(invite) });
          if (res.status === 404) {
            void res.body?.cancel(); // an answer nobody reads would otherwise stay open
            refused = true; // not this auction's invite: try the next, and keep whatever is stored
            continue;
          }
          if (!res.ok) throw new Error();
          const body = await res.json();
          rememberInvite(id, invite);
          setState({ step: "open", auction: body.auction, now: body.now });
          return true;
        } catch {
          /* the site could not be reached: stay locked, the visitor can try again */
        }
      }
      setState({ step: "locked", wrong: refused && given.length > 0 });
      return false;
    },
    [id],
  );

  useEffect(() => {
    void (async () => {
      const hash = window.location.hash.replace(/^#/, "");
      const given: string[] = [];
      const fromLink = hash.startsWith("invite=") && isInviteKey(hash.slice(7)) ? hash.slice(7) : null;
      if (fromLink) given.push(fromLink);
      // The seller's link. Their invite is derived from the manage key, which AuctionRoom stores and removes from the address bar.
      else if (hash.startsWith("manage=") && isInviteKey(hash.slice(7))) given.push(await inviteFromManage(hash.slice(7)));
      const opened = await enter(given);
      // The invite is a key: once this browser remembers it, take it out of the address bar.
      if (opened && fromLink) {
        try {
          if (localStorage.getItem(`dv-invite-${id}`)) window.history.replaceState(null, "", window.location.pathname + window.location.search);
        } catch {
          /* no storage: it stays in the address bar and works for this visit */
        }
      }
    })();
  }, [id, enter]);

  // A ticket restored from a file (in the wallet panel) brings its invite with it: try again when that happens.
  const locked = state.step === "locked";
  useEffect(() => {
    if (!locked) return;
    const again = () => void enter();
    window.addEventListener(WALLET_EVENT, again);
    return () => window.removeEventListener(WALLET_EVENT, again);
  }, [locked, enter]);

  if (state.step === "open") return state.auction.deal ? <DealRoom initial={state.auction} serverNow={state.now} /> : <AuctionRoom initial={state.auction} serverNow={state.now} />;

  return (
    <div className="card" id="private-gate" style={{ maxWidth: 620, margin: "8vh auto 0" }}>
      <span className="badge private-tag">Private</span>
      <h1 style={{ fontSize: "clamp(1.6rem, 4vw, 2.4rem)", marginTop: 14 }}>This Page Is Private</h1>
      {state.step === "checking" ? (
        <p className="muted">
          <span className="spinner" aria-hidden="true" /> Checking your link…
        </p>
      ) : (
        <>
          <p className="muted">
            It is listed nowhere, and what it is for was encrypted in the seller&apos;s browser, so this site can&apos;t read it either. To open it,
            use the link the seller gave you, or paste it here.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const invite = inviteFromText(pasted);
              if (!invite) return setState({ step: "locked", wrong: true });
              setState({ step: "checking" });
              void enter([invite]).then((opened) => opened && setPasted(""));
            }}
          >
            <label htmlFor="invite">Your Link</label>
            <input id="invite" className="mono" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://…#invite=…" spellCheck={false} autoComplete="off" />
            {state.wrong && (
              <p className="hint error" id="invite-wrong">
                That link does not open this page.
              </p>
            )}
            <p className="hint">
              The link is checked here in your browser. Only a token made from it is shown to the site, never its key. Been here from another
              browser? Restore your vault file on the dashboard, or a ticket file in the wallet panel, and this page opens.
            </p>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" disabled={pasted.trim() === ""}>
                Open
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
