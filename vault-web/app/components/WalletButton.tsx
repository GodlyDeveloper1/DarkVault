"use client";

// The "Connect wallet" button and the wallet panel.
//
// Connecting never sends anything to the server (see lib/wallet.ts). The panel
// lists the bids this browser holds and asks the server about each one with
// that bid's own token, the same request the auction page makes.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatCoins } from "vault-core";
import { loadRows, statusOf, type Row, roomPath } from "@/lib/bidStatus";
import { allTickets, backupFile, parseBackup, saveTicket, WALLET_EVENT, type Ticket } from "@/lib/tickets";
import { addressProblem, loadWallet, maskAddress, OPEN_EVENT, saveWallet, type Wallet } from "@/lib/wallet";
import { forgetPracticeWallet, makePracticeWallet, practiceWallet } from "@/lib/practiceClient";
import type { WalletView } from "@/lib/house/practice";

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
  // The practice wallet, on sites that have one to give.
  const [practiceOn, setPracticeOn] = useState(false);
  const [pw, setPw] = useState<WalletView | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
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

  // While the panel is open, show the practice wallet and keep its balance fresh.
  useEffect(() => {
    if (phase !== "open") return;
    let stop = false;
    const load = () => {
      void fetch("/api/status")
        .then((r) => r.json())
        .then((s) => !stop && setPracticeOn(!!s.practice))
        .catch(() => {});
      void practiceWallet()
        .then((w) => !stop && setPw(w))
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 8000);
    window.addEventListener(WALLET_EVENT, load);
    return () => {
      stop = true;
      clearInterval(t);
      window.removeEventListener(WALLET_EVENT, load);
    };
  }, [phase]);

  // While the panel is open, keep each bid's status fresh.
  useEffect(() => {
    if (phase !== "open" || tickets.length === 0) return;
    let stop = false;
    async function load() {
      const next = await loadRows(tickets);
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
          <aside className="drawer" id="wallet-panel" role="dialog" aria-label="Wallet" tabIndex={-1} ref={panel} data-lenis-prevent>
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

            {(practiceOn || pw) && (
              <div className="card" id="practice-wallet" style={{ marginTop: 18 }}>
                <h3 style={{ marginTop: 0 }}>Practice wallet</h3>
                {pw ? (
                  <>
                    <dl className="kv" style={{ margin: 0 }}>
                      <dt>Balance</dt>
                      <dd id="practice-balance">{formatCoins(pw.balance)} TAZ</dd>
                      {pw.locked > 0 && (
                        <>
                          <dt>In open auctions</dt>
                          <dd>{formatCoins(pw.locked)} TAZ</dd>
                        </>
                      )}
                    </dl>
                    <p className="hint">
                      Testnet coins the site holds for you. They only work in practice auctions and can&apos;t be withdrawn, and the site can tell
                      which practice bids are yours. For a real auction, use your own wallet.
                    </p>
                    <button
                      type="button"
                      className="link small"
                      onClick={() => {
                        forgetPracticeWallet();
                        setPw(null);
                      }}
                    >
                      Forget this practice wallet
                    </button>
                  </>
                ) : (
                  <>
                    <p className="small muted">
                      No testnet coins? A practice wallet gives you some to bid with in practice auctions. The site holds them, so it is for
                      practice only.
                    </p>
                    <button
                      type="button"
                      id="practice-make-panel"
                      disabled={pwBusy}
                      onClick={async () => {
                        setPwBusy(true);
                        setMessage(null);
                        try {
                          setPw(await makePracticeWallet());
                        } catch (e) {
                          setMessage(e instanceof Error ? e.message : String(e));
                        } finally {
                          setPwBusy(false);
                        }
                      }}
                    >
                      {pwBusy ? "Making it…" : "Get a practice wallet"}
                    </button>
                  </>
                )}
              </div>
            )}

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
                      <Link href={roomPath(row.auction, t.auction_id)} onClick={close}>
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
              settled. Changing browser or device?{" "}
              <Link href="/dashboard#move" onClick={close} id="wallet-move">
                Move everything in one file.
              </Link>
            </p>
          </aside>
        </div>
      )}
    </>
  );
}
