"use client";

// The "Connect wallet" button and the wallet panel.
//
// Connecting never sends anything to the server (see lib/wallet.ts). The panel
// lists the bids this browser holds and asks the server about each one with
// that bid's own token, the same request the auction page makes.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { bidToken, formatCoins } from "vault-core";
import { allTickets, backupFile, parseBackup, saveTicket, WALLET_EVENT, type Ticket } from "@/lib/tickets";
import { addressProblem, loadWallet, maskAddress, OPEN_EVENT, saveWallet, type Wallet } from "@/lib/wallet";
import type { BidView, PublicAuction } from "@/lib/views";

interface Row {
  ticket: Ticket;
  auction?: PublicAuction;
  view?: BidView;
}

function statusOf(row: Row): { text: string; cls: string } {
  const { auction, view, ticket } = row;
  if (!auction) return { text: "Checking…", cls: "" };
  const funded = (view?.deposit?.total ?? 0) > 0;
  if (auction.state === "open") {
    if (!funded) return { text: "Waiting for your deposit", cls: "amber" };
    const d = view!.deposit!;
    return d.counted >= ticket.amount
      ? { text: `Funded and sealed · ${Math.min(d.confirmations, d.needed)}/${d.needed} confirmations`, cls: "lime" }
      : { text: "Deposit is smaller than the bid", cls: "red" };
  }
  if (auction.state === "revealing") return { text: view?.revealed ? "Revealed, waiting for the result" : "Open the auction to reveal this bid", cls: "amber" };
  const refund = view?.payments.find((p) => p.kind !== "seller");
  if (view?.standing === "won") {
    const stage = view.delivery?.stage;
    if (stage === "refunded") return { text: "Won, but not delivered · payment returned", cls: "" };
    if (stage === "awaiting-address") return { text: "Won · send your shipping details", cls: "amber" };
    if (stage === "awaiting-handover") return { text: "Won · waiting for the seller to hand over", cls: "amber" };
    if (stage === "awaiting-confirmation") return { text: "Won · confirm you have the lot", cls: "amber" };
    if (stage === "disputed") return { text: "Won · dispute open", cls: "amber" };
    return { text: `Won · you pay ${formatCoins(auction.outcome?.price ?? ticket.amount)} TAZ`, cls: "lime" };
  }
  if (view?.standing === "no-deposit") return { text: "Did not count: no deposit", cls: "" };
  if (refund) return { text: refund.status === "mined" ? `Refunded ${formatCoins(refund.paid)} TAZ` : "Refund on its way", cls: refund.status === "mined" ? "" : "amber" };
  return { text: funded ? "Refund is being prepared" : "Closed", cls: funded ? "amber" : "" };
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function WalletButton() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // "closing" keeps the panel on screen while it fades out.
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  const sync = useCallback(() => {
    setWallet(loadWallet());
    setTickets(allTickets());
  }, []);

  const close = useCallback(() => {
    setPhase((p) => (p === "open" ? "closing" : p));
    setTimeout(() => setPhase((p) => (p === "closing" ? "closed" : p)), 240);
  }, []);
  const open = useCallback(() => {
    setMessage(null);
    setPhase("open");
  }, []);

  useEffect(() => {
    sync();
    window.addEventListener(WALLET_EVENT, sync);
    window.addEventListener("storage", sync); // another tab changed something
    window.addEventListener(OPEN_EVENT, open);
    return () => {
      window.removeEventListener(WALLET_EVENT, sync);
      window.removeEventListener("storage", sync);
      window.removeEventListener(OPEN_EVENT, open);
    };
  }, [sync, open]);

  useEffect(() => {
    if (phase !== "open") return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, close]);

  // While the panel is open, keep each bid's status fresh.
  useEffect(() => {
    if (phase !== "open" || tickets.length === 0) return;
    let stop = false;
    async function load() {
      const auctions = new Map<string, PublicAuction>();
      await Promise.all(
        [...new Set(tickets.map((t) => t.auction_id))].map(async (id) => {
          try {
            const res = await fetch(`/api/auctions/${id}`);
            if (res.ok) auctions.set(id, (await res.json()).auction);
          } catch {
            /* next round */
          }
        }),
      );
      const next: Record<string, Row> = {};
      await Promise.all(
        tickets.map(async (ticket) => {
          const row: Row = { ticket, auction: auctions.get(ticket.auction_id) };
          try {
            const res = await fetch(`/api/auctions/${ticket.auction_id}/bids/${ticket.bid_id}`, { headers: { "x-bid-token": await bidToken(ticket.nonce) } });
            if (res.ok) row.view = (await res.json()).bid;
          } catch {
            /* next round */
          }
          next[ticket.bid_id] = row;
        }),
      );
      if (!stop) setRows(next);
    }
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [phase, tickets]);

  const problem = addressProblem(address);

  function connect(e: React.FormEvent) {
    e.preventDefault();
    if (problem) return;
    saveWallet({ kind: "own", refund_address: address.trim() || null, connected_at: wallet?.connected_at ?? Date.now() });
    setAddress("");
    setEditing(false);
  }

  const showForm = !wallet || editing;

  return (
    <>
      <button type="button" id="wallet-button" className={wallet ? "wallet-btn on" : "wallet-btn"} onClick={() => (phase === "open" ? close() : open())} aria-haspopup="dialog" aria-expanded={phase === "open"}>
        {wallet ? (
          <>
            <i className="dot live" aria-hidden="true" /> Wallet
            {tickets.length > 0 && <b className="count">{tickets.length}</b>}
          </>
        ) : (
          "Connect wallet"
        )}
      </button>

      {phase !== "closed" && (
        <div className={`drawer-wrap ${phase}`}>
          <div className="drawer-catch" onClick={close} aria-hidden="true" />
          <aside className="drawer" id="wallet-panel" role="dialog" aria-label="Wallet" tabIndex={-1} ref={panel}>
            <div className="row spread">
              <h2 style={{ margin: 0 }}>{wallet ? "Your wallet" : "Connect a wallet"}</h2>
              <button type="button" className="link" onClick={close} aria-label="Close">
                Close
              </button>
            </div>

            {!wallet && (
              <ul className="ticks">
                <li>
                  <b>No address is handed over.</b> A Zcash wallet does not give sites a permanent address, and Dark Vault does not want one.
                </li>
                <li>
                  <b>You pay from your own wallet app.</b> Each deposit is a payment request that opens your wallet with the address and amount
                  filled in.
                </li>
                <li>
                  <b>Connecting stays in this browser.</b> Nothing is sent to the site when you press Connect.
                </li>
              </ul>
            )}

            {wallet && !editing && (
              <div className="card" style={{ marginTop: 18 }}>
                <dl className="kv" style={{ margin: 0 }}>
                  <dt>Wallet</dt>
                  <dd>Your own Zcash wallet app</dd>
                  <dt>Refunds go to</dt>
                  <dd id="wallet-refund">{wallet.refund_address ? maskAddress(wallet.refund_address) : "a fresh address you paste for each bid"}</dd>
                </dl>
                <div className="row" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="link small"
                    onClick={() => {
                      setAddress(wallet.refund_address ?? "");
                      setEditing(true);
                    }}
                  >
                    {wallet.refund_address ? "Change address" : "Save an address"}
                  </button>
                  <button
                    type="button"
                    className="link small"
                    id="wallet-disconnect"
                    onClick={() => {
                      saveWallet(null);
                      setMessage("Disconnected. Your bid tickets are still in this browser.");
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            )}

            {showForm && (
              <form onSubmit={connect} id="wallet-form">
                <label htmlFor="wallet-address">Shielded address for refunds (optional)</label>
                <input id="wallet-address" className="mono" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="utest1…" spellCheck={false} autoComplete="off" />
                <p className={problem ? "hint error" : "hint"}>
                  {problem ??
                    "Saved in this browser and filled in when you bid. Leave it empty to paste a fresh address for each bid: that is the most private choice, because one saved address lets this site tell that your bids belong together."}
                </p>
                <div className="row" style={{ marginTop: 16 }}>
                  <button className="primary" disabled={!!problem}>
                    {wallet ? "Save" : "Connect"}
                  </button>
                  {editing && (
                    <button type="button" onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            )}

            {message && <p className="small ok" style={{ marginTop: 14 }}>{message}</p>}

            <h3 style={{ marginTop: 28 }}>Your bids</h3>
            {tickets.length === 0 ? (
              <p className="muted small">No bids from this browser yet.</p>
            ) : (
              <ul className="wallet-bids" id="wallet-bids">
                {tickets.map((t) => {
                  const row = rows[t.bid_id] ?? { ticket: t };
                  const s = statusOf(row);
                  return (
                    <li key={t.bid_id}>
                      <Link href={`/auction/${t.auction_id}`} onClick={close}>
                        <span className="wb-title">{row.auction?.title ?? "Auction"}</span>
                        <span className="mono wb-amount">{formatCoins(t.amount)} TAZ</span>
                        <span className={`wb-status ${s.cls}`}>{s.text}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="row" style={{ marginTop: 14 }}>
              {tickets.length > 0 && (
                <button type="button" className="link small" id="wallet-backup" onClick={() => download("dark-vault-tickets.txt", backupFile(tickets))}>
                  Save a backup of all tickets
                </button>
              )}
              <label className="link small" style={{ display: "inline", margin: 0, fontWeight: 500, color: "var(--lime)", cursor: "pointer" }}>
                Restore from a file
                <input
                  type="file"
                  accept=".txt,text/plain"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    // Read here in the browser; the file is not uploaded.
                    const found = parseBackup(await file.text());
                    found.forEach((t) => saveTicket(t));
                    setMessage(found.length ? `Restored ${found.length} ${found.length === 1 ? "ticket" : "tickets"}.` : "No tickets found in that file.");
                  }}
                />
              </label>
            </div>
            <p className="hint" style={{ marginTop: 18 }}>
              Tickets live in this browser only. A sealed bid can&apos;t be opened without its ticket, so keep a backup until the auction has
              settled.
            </p>
          </aside>
        </div>
      )}
    </>
  );
}
