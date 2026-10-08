"use client";

// "Check the result yourself."
//
// When an auction with time-locked bids is decided, the site publishes the
// result and a proof (see vault-core fairness.ts). This card fetches both and
// checks them here, in the browser, with nothing but public data:
//
//   - the result it was given is the one this page shows, for this board;
//   - the winning commitment really holds the price;
//   - every other bid that counted is proven to be lower, without its amount
//     being shown;
//   - the bids were locked to a round that came after bidding ended, and the
//     signature that opened them is real;
//   - and, for a bidder, that their own bid is on the board where the site's
//     signed receipt says it is, was locked to that same round, and was
//     treated as their ticket says it should have been.
//
// What the browser already holds is preferred to what the site says now: the
// public network's key and clock are constants in this code, and a bidder's
// ticket carries the round its bid was locked to and the site's key as it was
// when the bid was placed.
//
// The card is green only if nothing failed and, for a bidder, their own bid
// counted. If the proof holds but a bid of theirs was left out, it is amber:
// that is the one thing a proof about the counted bids can't settle.
import { useEffect, useRef, useState } from "react";
import {
  BATCH_MAX_ORDER,
  batchBound,
  formatCoins,
  isPublicBeacon,
  pedersenCommit,
  roundAfter,
  roundTimeMs,
  sealedFor,
  trustedChain,
  verifyBatch,
  verifyBeacon,
  verifyFairness,
  verifyReceipt,
  type BatchProof,
  type BatchStatement,
  type BeaconChain,
  type FairnessProof,
  type FairnessStatement,
} from "vault-core";
import { inviteHeaders } from "@/lib/invites";
import type { Ticket } from "@/lib/tickets";
import type { PublicAuction } from "@/lib/views";

interface Check {
  /**
   * "note" is something to know that is neither a pass nor a failure.
   * "warn" is something the viewer should look into: the proof can't settle it.
   */
  kind: "pass" | "fail" | "note" | "warn";
  text: string;
}

type TimeLock = { chain: BeaconChain; round: number; beacon?: { round: number; signature: string } } | null;

interface Published {
  statement: FairnessStatement;
  proof: FairnessProof;
  timelock: TimeLock;
}

/** Order Flow: what a batch sale publishes. Several orders win; the proof is of another shape (vault-core batch.ts). */
interface PublishedBatch {
  statement: BatchStatement;
  proof: BatchProof;
  timelock: TimeLock;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

async function check(auction: PublicAuction, tickets: Ticket[], onProgress: (done: number, of: number) => void): Promise<Check[]> {
  const res = await fetch(`/api/auctions/${auction.id}/proof`, { headers: await inviteHeaders(auction.id) });
  if (!res.ok) throw new Error("the site did not provide the proof");
  const published = (await res.json()) as Published | PublishedBatch;
  if (auction.batch) return checkBatch(auction, tickets, published as PublishedBatch, onProgress);
  const { statement, proof, timelock } = published as Published;
  const out: Check[] = [];
  const pass = (text: string) => out.push({ kind: "pass", text });
  const fail = (text: string) => out.push({ kind: "fail", text });
  const note = (text: string) => out.push({ kind: "note", text });
  const warn = (text: string) => out.push({ kind: "warn", text });

  // 1. The proof is about this auction, this board and the result this page shows.
  const o = auction.outcome;
  const matches =
    statement?.auction_id === auction.id &&
    statement.reserve === auction.reserve &&
    // An auction without a ceiling states the price (unsold: the reserve) as the bound of its proof.
    statement.ceiling === (auction.ceiling ?? (o?.sold ? o.price : auction.reserve)) &&
    Array.isArray(statement.bids) &&
    same(statement.bids.map((b) => b.commitment), auction.commitments) &&
    // The page's board says how each bid fared. That must be what was proven, not just the same bids.
    same(statement.bids.map((b) => b.status), auction.board ?? []) &&
    !!o &&
    statement.sold === o.sold &&
    (statement.price ?? null) === (o.price ?? null) &&
    (statement.winner === null ? null : statement.winner + 1) === (o.winner_position ?? null);
  if (matches) pass(`The published result is for this auction and this board of ${statement.bids.length} ${statement.bids.length === 1 ? "bid" : "bids"}.`);
  else {
    fail("The published result does not match what this page shows. Do not rely on it.");
    return out;
  }

  // 2. The proof itself.
  const verdict = await verifyFairness(statement, proof, onProgress);
  const others = verdict.counted - (statement.sold ? 1 : 0);
  if (verdict.ok) {
    if (statement.sold) {
      pass(`Bid #${statement.winner! + 1} opens to exactly ${formatCoins(statement.price!)} TAZ: the winner pays what they sealed.`);
      if (others > 0) pass(`${others === 1 ? "The other bid that counted is" : `Each of the ${others} other bids that counted is`} proven to be lower. ${others === 1 ? "Its amount is" : "Their amounts are"} not shown.`);
      else note("No other bid counted, so there was nothing to compare the winner with.");
    } else if (verdict.counted > 0) pass(`${verdict.counted === 1 ? "The bid that counted is" : `Each of the ${verdict.counted} bids that counted is`} proven to be below the reserve, so the lot rightly did not sell.`);
    else note("No bid counted, so the lot did not sell.");
  } else for (const p of verdict.problems) fail(`The proof fails: ${p}.`);

  const skipped = statement.bids.filter((b) => b.status !== "counted").length;
  if (skipped > 0) {
    const n = (s: string) => statement.bids.filter((b) => b.status === s).length;
    const parts = [
      n("no-deposit") && `${n("no-deposit")} had no deposit`,
      n("underfunded") && `${n("underfunded")} deposited too little`,
      n("unopened") && `${n("unopened")} could not be opened or held no valid bid`,
    ].filter(Boolean);
    note(`${skipped} of the ${statement.bids.length} bids did not count: ${parts.join(", ")}. The proof can't cover these; each bidder can check their own below.`);
  }

  // 3. The time lock: the round must come after bidding ended, and the signature must be that round's.
  const chain = timelock ? trustedChain(timelock.chain) : null;
  const real = !!timelock && isPublicBeacon(timelock.chain);
  if (!timelock || !chain) fail("The published result does not say what the bids were locked to.");
  else if (timelock.round !== auction.timelock?.round || timelock.chain.hash !== auction.timelock?.chain.hash) fail("The published result names a different time lock from the one this auction was run with.");
  else if (timelock.round < roundAfter(chain, auction.ends_at)) fail(`The bids were locked to a round signed at ${new Date(roundTimeMs(chain, timelock.round)).toLocaleString()}, before bidding ended. They could have been opened early.`);
  else if (timelock.beacon) {
    if (timelock.beacon.round === timelock.round && verifyBeacon(chain, timelock.beacon))
      (real ? pass : note)(
        real
          ? `Bids were locked to round ${timelock.round} of the public drand network, which was signed after bidding ended. The signature that opened them is genuine.`
          : `Bids were locked to round ${timelock.round} of a TEST beacon, which locks nothing. The signature matches that test beacon.`,
      );
    else fail("The signature the site says opened the bids is not the time lock's.");
  } else note(`Bids were locked to round ${timelock.round}${real ? " of the public drand network" : " of a TEST beacon"}. The site did not fetch its signature, so bidders opened their own bids from their tickets.`);

  // 4. This browser's own bids.
  for (const t of tickets) {
    let commitment: string;
    try {
      commitment = pedersenCommit(auction.id, t.amount, t.nonce);
    } catch {
      continue; // not a ticket for this kind of auction
    }
    const at = statement.bids.findIndex((b) => b.commitment === commitment);
    const mine = `Your bid of ${formatCoins(t.amount)} TAZ`;
    if (at < 0) {
      fail(`${mine} is missing from the board. ${t.receipt ? "Keep your ticket: its receipt is the site's own signature that it accepted the bid." : ""}`);
      continue;
    }
    // The ticket's own copy of the locked bid says which round it was really locked to.
    const own = t.sealed ? sealedFor(t.sealed) : null;
    if (own && timelock && (own.round !== timelock.round || own.chain_hash !== timelock.chain.hash)) fail(`Your bid #${at + 1} was locked to round ${own.round}, not the round the result names.`);
    const r = t.receipt;
    // The site's key as this browser saw it when the bid was placed, if the ticket has it.
    const key = t.site_key ?? auction.site_key;
    if (r) {
      const signed = !!key && verifyReceipt(key, r) && r.commitment === commitment && r.auction_id === auction.id;
      if (!signed) warn(`The receipt in your ticket for bid #${at + 1} is not a valid signature by this site.`);
      else if (r.position !== at + 1) fail(`The site's receipt says your bid is #${r.position} on the board, but the result has it at #${at + 1}.`);
      else pass(`${mine} is #${at + 1} on the board, exactly where the site's signed receipt says.`);
      if (signed && t.site_key && auction.site_key && t.site_key !== auction.site_key) note("The site's signing key has changed since you placed this bid. Your receipt was checked with the key from then.");
    } else {
      pass(`${mine} is #${at + 1} on the board.`);
      note(`Your ticket holds no signed receipt for bid #${at + 1}, so its place on the board can't be checked against one.`);
    }
    const status = statement.bids[at]!.status;
    if (status === "unopened") {
      if (auction.ceiling != null && t.amount > auction.ceiling) note(`Bid #${at + 1} was above the highest bid allowed, so it did not count.`);
      else if (timelock?.beacon) fail(`The site says bid #${at + 1} could not be opened, but your ticket opens it. Keep your ticket: it holds the locked bid and the site's signed receipt for it, which together show the bid was valid.`);
      else warn(`Bid #${at + 1} did not count. The site says it could not open the time lock, and the bid was not opened from this ticket within the backup window. If this page was open during that window, that should not have happened: keep your ticket.`);
    } else if (status === "counted") {
      if (statement.sold && at !== statement.winner && t.amount > statement.price! - (at < statement.winner! ? 1 : 0)) fail(`Your bid #${at + 1} is higher than the published result allows.`);
      else pass(`Bid #${at + 1} was counted.`);
    } else
      warn(
        `Bid #${at + 1} did not count: the site says ${status === "no-deposit" ? "no deposit arrived before the close" : auction.deposit_required != null ? "its deposit was smaller than every bid must deposit" : "its deposit did not cover the bid and the bond"}. Deposits are shielded, so no proof can show this either way. If you sent ${formatCoins(auction.deposit_required ?? t.amount + (auction.delivery?.buyer_bond ?? 0))} TAZ or more in time, keep your wallet's record of the payment and your ticket.`,
      );
  }
  return out;
}

/**
 * Order Flow: the same checks for a batch sale. Several orders win a unit
 * each. The proof opens one of them, the lowest that won, and shows that
 * every other winner offered at least that and every other counted order no
 * more, without showing what any of them offered.
 */
async function checkBatch(auction: PublicAuction, tickets: Ticket[], { statement, proof, timelock }: PublishedBatch, onProgress: (done: number, of: number) => void): Promise<Check[]> {
  const out: Check[] = [];
  const pass = (text: string) => out.push({ kind: "pass", text });
  const fail = (text: string) => out.push({ kind: "fail", text });
  const note = (text: string) => out.push({ kind: "note", text });
  const warn = (text: string) => out.push({ kind: "warn", text });
  const bond = auction.delivery?.buyer_bond ?? 0;

  // 1. The proof is about this sale, this board and the result this page shows.
  const o = auction.outcome;
  const matches =
    statement?.v === 3 &&
    statement.auction_id === auction.id &&
    statement.reserve === auction.reserve &&
    statement.units === auction.batch!.units &&
    Array.isArray(statement.bids) &&
    same(statement.bids.map((b) => b.commitment), auction.commitments) &&
    // The page's board says how each order fared. That must be what was proven, not just the same orders.
    same(statement.bids.map((b) => b.status), auction.board ?? []) &&
    Array.isArray(statement.winners) &&
    !!o &&
    o.sold === statement.winners.length > 0 &&
    (statement.price ?? null) === (o.price ?? null) &&
    same(statement.winners.map((w) => String(w + 1)), (o.winner_positions ?? []).map(String));
  if (matches) pass(`The published result is for this sale of ${statement.units} units and this board of ${statement.bids.length} ${statement.bids.length === 1 ? "order" : "orders"}.`);
  else {
    fail("The published result does not match what this page shows. Do not rely on it.");
    return out;
  }

  // 2. The proof itself.
  const verdict = await verifyBatch(statement, proof, onProgress);
  const won = statement.winners.length;
  const lost = verdict.counted - won;
  if (verdict.ok) {
    if (won > 0) {
      pass(`Order #${statement.marginal! + 1} opens to exactly ${formatCoins(statement.price!)} TAZ: it is the lowest order that won a unit.`);
      if (won > 1) pass(`${won - 1 === 1 ? "The other winning order is" : `Each of the ${won - 1} other winning orders is`} proven to have offered at least that. What ${won - 1 === 1 ? "it" : "each"} offered, and pays, is not shown.`);
      if (lost > 0)
        pass(
          won < statement.units
            ? `${lost === 1 ? "The other order that counted is" : `Each of the ${lost} other orders that counted is`} proven to be below the lowest price, so ${statement.units - won} ${statement.units - won === 1 ? "unit was" : "units were"} rightly left unsold.`
            : `${lost === 1 ? "The other order that counted is" : `Each of the ${lost} other orders that counted is`} proven to have offered no more than the lowest winner. ${lost === 1 ? "Its amount is" : "Their amounts are"} not shown.`,
        );
      else if (won < statement.units) note(`Only ${won} ${won === 1 ? "order" : "orders"} counted, so ${statement.units - won} ${statement.units - won === 1 ? "unit was" : "units were"} left unsold.`);
      else note("No other order counted, so there was nothing to compare the winners with.");
    } else if (verdict.counted > 0) pass(`${verdict.counted === 1 ? "The order that counted is" : `Each of the ${verdict.counted} orders that counted is`} proven to be below the lowest price, so nothing rightly sold.`);
    else note("No order counted, so nothing sold.");
  } else for (const p of verdict.problems) fail(`The proof fails: ${p}.`);

  const skipped = statement.bids.filter((b) => b.status !== "counted").length;
  if (skipped > 0) {
    const n = (x: string) => statement.bids.filter((b) => b.status === x).length;
    const parts = [
      n("no-deposit") && `${n("no-deposit")} had no deposit`,
      n("underfunded") && `${n("underfunded")} deposited too little`,
      n("unopened") && `${n("unopened")} could not be opened or held no valid order`,
    ].filter(Boolean);
    note(`${skipped} of the ${statement.bids.length} orders did not count: ${parts.join(", ")}. The proof can't cover these; each buyer can check their own below.`);
  }

  // 3. The time lock: the round must come after ordering ended, and the signature must be that round's.
  const chain = timelock ? trustedChain(timelock.chain) : null;
  const real = !!timelock && isPublicBeacon(timelock.chain);
  if (!timelock || !chain) fail("The published result does not say what the orders were locked to.");
  else if (timelock.round !== auction.timelock?.round || timelock.chain.hash !== auction.timelock?.chain.hash) fail("The published result names a different time lock from the one this sale was run with.");
  else if (timelock.round < roundAfter(chain, auction.ends_at)) fail(`The orders were locked to a round signed at ${new Date(roundTimeMs(chain, timelock.round)).toLocaleString()}, before the sale closed. They could have been opened early.`);
  else if (timelock.beacon) {
    if (timelock.beacon.round === timelock.round && verifyBeacon(chain, timelock.beacon))
      (real ? pass : note)(
        real
          ? `Orders were locked to round ${timelock.round} of the public drand network, which was signed after the sale closed. The signature that opened them is genuine.`
          : `Orders were locked to round ${timelock.round} of a TEST beacon, which locks nothing. The signature matches that test beacon.`,
      );
    else fail("The signature the site says opened the orders is not the time lock's.");
  } else note(`Orders were locked to round ${timelock.round}${real ? " of the public drand network" : " of a TEST beacon"}. The site did not fetch its signature, so buyers opened their own orders from their tickets.`);

  // 4. This browser's own orders.
  for (const t of tickets) {
    let commitment: string;
    try {
      commitment = pedersenCommit(auction.id, t.amount, t.nonce);
    } catch {
      continue; // not a ticket for this kind of sale
    }
    const at = statement.bids.findIndex((b) => b.commitment === commitment);
    const mine = `Your order of ${formatCoins(t.amount)} TAZ`;
    if (at < 0) {
      fail(`${mine} is missing from the board. ${t.receipt ? "Keep your ticket: its receipt is the site's own signature that it accepted the order." : ""}`);
      continue;
    }
    const own = t.sealed ? sealedFor(t.sealed) : null;
    if (own && timelock && (own.round !== timelock.round || own.chain_hash !== timelock.chain.hash)) fail(`Your order #${at + 1} was locked to round ${own.round}, not the round the result names.`);
    const r = t.receipt;
    const key = t.site_key ?? auction.site_key;
    if (r) {
      const signed = !!key && verifyReceipt(key, r) && r.commitment === commitment && r.auction_id === auction.id;
      if (!signed) warn(`The receipt in your ticket for order #${at + 1} is not a valid signature by this site.`);
      else if (r.position !== at + 1) fail(`The site's receipt says your order is #${r.position} on the board, but the result has it at #${at + 1}.`);
      else pass(`${mine} is #${at + 1} on the board, exactly where the site's signed receipt says.`);
      if (signed && t.site_key && auction.site_key && t.site_key !== auction.site_key) note("The site's signing key has changed since you placed this order. Your receipt was checked with the key from then.");
    } else {
      pass(`${mine} is #${at + 1} on the board.`);
      note(`Your ticket holds no signed receipt for order #${at + 1}, so its place on the board can't be checked against one.`);
    }
    const status = statement.bids[at]!.status;
    const isWinner = statement.winners.includes(at);
    if (status === "unopened") {
      if (t.amount > BATCH_MAX_ORDER) note(`Order #${at + 1} was larger than a sale can take, so it did not count.`);
      else if (timelock?.beacon) fail(`The site says order #${at + 1} could not be opened, but your ticket opens it. Keep your ticket: it holds the locked order and the site's signed receipt for it, which together show the order was valid.`);
      else warn(`Order #${at + 1} did not count. The site says it could not open the time lock, and the order was not opened from this ticket within the backup window. If this page was open during that window, that should not have happened: keep your ticket.`);
    } else if (status === "counted") {
      // The ticket says what this order offered. It must sit on the side of the result the proof puts it on.
      const fits = at === statement.marginal ? t.amount === statement.price : won === 0 ? t.amount < statement.reserve : (() => {
        const { side, bound } = batchBound(statement, at);
        return side === "at-least" ? t.amount >= bound : t.amount <= bound;
      })();
      if (!fits) fail(isWinner ? `Your order #${at + 1} is said to have won, but it offered less than the published result needs.` : `Your order #${at + 1} offered more than the published result allows for an order that did not win.`);
      else pass(isWinner ? `Order #${at + 1} was counted, and won a unit at ${formatCoins(t.amount)} TAZ, what it offered.` : `Order #${at + 1} was counted. It did not win a unit.`);
    } else
      warn(
        `Order #${at + 1} did not count: the site says ${status === "no-deposit" ? "no deposit arrived before the close" : "its deposit did not cover the order and the bond"}. Deposits are shielded, so no proof can show this either way. If you sent ${formatCoins(t.amount + bond)} TAZ or more in time, keep your wallet's record of the payment and your ticket.`,
      );
  }
  return out;
}

export default function VerifyResult({ auction, tickets }: { auction: PublicAuction; tickets: Ticket[] }) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [running, setRunning] = useState(false);
  const ran = useRef<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      setChecks(await check(auction, tickets, (done, of) => setProgress([done, of])));
    } catch (e) {
      setChecks(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  // Check once by itself as soon as the proof is out, and again if this browser's tickets change.
  const key = auction.proof ? `${auction.id}:${tickets.map((t) => t.bid_id).join(",")}` : null;
  useEffect(() => {
    if (!key || ran.current === key) return;
    ran.current = key;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!auction.proof) return null;
  const failed = checks?.some((c) => c.kind === "fail") ?? false;
  const warned = !failed && (checks?.some((c) => c.kind === "warn") ?? false);
  const tone = failed ? "fail" : warned ? "warn" : "pass";

  return (
    <div className={`card ${checks ? (failed ? "bad" : warned ? "warn" : "accent") : ""}`} id="verify-card">
      <h3>Check the result yourself</h3>
      <p className="muted small">
        {auction.batch
          ? "The site published a proof that the highest orders won the units. Your browser checks it here, using only public data. What each order offered stays hidden, except the lowest that won."
          : "The site published a proof that the highest bid won. Your browser checks it here, using only public data. The losing bids stay hidden."}
      </p>
      {running && (
        <>
          <p className="small" style={{ margin: 0 }}>
            <span className="spinner" aria-hidden="true" /> Checking{progress ? ` ${auction.batch ? "order" : "bid"} ${progress[0]} of ${progress[1]}` : ""}…
          </p>
          <div className="meter" aria-hidden="true">
            <span style={{ width: `${progress ? Math.round((progress[0] / Math.max(1, progress[1])) * 100) : 5}%` }} />
          </div>
        </>
      )}
      {error && (
        <p className="error small" id="verify-error">
          Couldn&apos;t check: {error}.
        </p>
      )}
      {checks && !running && (
        <>
          <p className={`verdict ${tone}`} id="verify-verdict" data-ok={failed ? "no" : warned ? "warn" : "yes"}>
            {failed ? "✕ The result does not check out." : warned ? `! The proof holds, but look at your own ${auction.batch ? "order" : "bid"}.` : "✓ Verified in your browser."}
          </p>
          <ul className="checks" id="verify-checks">
            {checks.map((c, i) => (
              <li key={i} className={c.kind} style={{ animationDelay: `${i * 70}ms` }}>
                <i aria-hidden="true">{c.kind === "pass" ? "✓" : c.kind === "fail" ? "✕" : c.kind === "warn" ? "!" : "•"}</i>
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="row" style={{ marginTop: 14 }}>
        <button type="button" className="link small" id="verify-again" disabled={running} onClick={() => void run()}>
          Check again
        </button>
        {auction.private ? (
          // A private auction's proof is served only with the invite's token, which a plain link can't send: fetch it and save it.
          <button
            type="button"
            className="link small"
            id="proof-save"
            onClick={async () => {
              const res = await fetch(`/api/auctions/${auction.id}/proof`, { headers: await inviteHeaders(auction.id) });
              if (!res.ok) return;
              const a = document.createElement("a");
              a.href = URL.createObjectURL(new Blob([await res.text()], { type: "application/json" }));
              a.download = `dark-vault-proof-${auction.id.slice(0, 8)}.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 1000);
            }}
          >
            Save the proof ({Math.max(1, Math.round(auction.proof.bytes / 1024))} KB)
          </button>
        ) : (
          <a className="link small" href={`/api/auctions/${auction.id}/proof`} target="_blank" rel="noreferrer">
            See the proof ({Math.max(1, Math.round(auction.proof.bytes / 1024))} KB)
          </a>
        )}
      </div>
    </div>
  );
}
