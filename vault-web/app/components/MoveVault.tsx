"use client";

// "Move To Another Browser": save everything this browser holds to one file,
// and read such a file back. See lib/portable.ts. Nothing is uploaded.
import { useCallback, useEffect, useRef, useState } from "react";
import { PiBroomBold, PiDownloadSimpleBold, PiSuitcaseSimpleBold, PiUploadSimpleBold } from "react-icons/pi";
import { applyVault, clearAll, collect, countsOf, describe, isEmpty, MIN_PASSPHRASE, openVault, packVault, type Counts } from "@/lib/portable";
import { WALLET_EVENT } from "@/lib/tickets";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function MoveVault() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  // A locked file waiting for its passphrase.
  const [locked, setLocked] = useState<string | null>(null);
  const [unlock, setUnlock] = useState("");
  const picker = useRef<HTMLInputElement>(null);
  // Clearing: a file saved during this visit, and the second click that confirms.
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const sync = useCallback(() => setCounts(countsOf(collect())), []);
  useEffect(() => {
    sync();
    window.addEventListener(WALLET_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(WALLET_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [sync]);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const bundle = collect();
      const day = new Date().toISOString().slice(0, 10);
      download(`dark-vault-${day}.txt`, await packVault(bundle, pass));
      setMessage({
        text: `Saved ${describe(countsOf(bundle))}. ${pass ? "The file is locked with your passphrase: keep both." : "The file is not locked: keep it somewhere private."}`,
        tone: "ok",
      });
      setPass("");
      setSaved(true);
    } catch {
      setMessage({ text: "The file could not be made in this browser.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  async function restore(text: string, passphrase = "") {
    setBusy(true);
    setMessage(null);
    try {
      const opened = await openVault(text, passphrase);
      if (opened.kind === "locked") {
        setLocked(text);
        return;
      }
      if (opened.kind === "wrong-passphrase") {
        setMessage({ text: "That passphrase does not open this file.", tone: "bad" });
        return;
      }
      if (opened.kind === "not-a-vault-file") {
        setLocked(null);
        setMessage({ text: "That is not a Dark Vault file.", tone: "bad" });
        return;
      }
      const inFile = countsOf(opened.bundle);
      const added = applyVault(opened.bundle);
      setLocked(null);
      setUnlock("");
      setMessage(
        isEmpty(added)
          ? { text: isEmpty(inFile) ? "That file is empty." : "This browser already holds everything in that file.", tone: "ok" }
          : {
              text: `Restored ${describe(added)}. They are in this browser now.${added.refundAddress ? ` The refund address is ${added.refundAddress}: check it is yours before you use it.` : ""}`,
              tone: "ok",
            },
      );
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    const gone = clearAll();
    setConfirming(false);
    setSaved(false);
    sync();
    setMessage({
      text: isEmpty(gone)
        ? "This browser held nothing of Dark Vault's."
        : `Cleared ${describe(gone)} from this browser. ${saved ? "Restore your vault file here, or in another browser, to bring them back." : "Nothing was saved to a file."}`,
      tone: "ok",
    });
  }

  const holds = counts ? (isEmpty(counts) ? "Nothing yet." : `${describe(counts)}.`) : "…";

  return (
    <section className="card move" id="move">
      <div className="move-head">
        <i className="move-ico" aria-hidden="true">
          <PiSuitcaseSimpleBold />
        </i>
        <div>
          <h2>Move To Another Browser</h2>
          <p>
            Dark Vault has no accounts: there is no login that puts a name to what you do here. So your bids, payments, seller keys and invites
            live in this browser only. Save them to one file to carry them to another browser or device, or to keep a backup.
          </p>
        </div>
      </div>

      <div className="move-cols">
        <div className="move-box">
          <h3>Save</h3>
          <p className="small">
            This browser holds: <b id="move-holds">{holds}</b>
          </p>
          <label htmlFor="move-pass">Passphrase (Optional, {MIN_PASSPHRASE} Characters Or More)</label>
          <input id="move-pass" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Locks The File" />
          <p className="hint">
            With a passphrase the file is encrypted here, in your browser, and is useless without it. Without one, anyone who gets the file can read
            your bids.
          </p>
          <button
            type="button"
            className="primary"
            id="move-save"
            disabled={busy || !counts || isEmpty(counts) || (pass.length > 0 && pass.length < MIN_PASSPHRASE)}
            onClick={() => void save()}
          >
            <PiDownloadSimpleBold aria-hidden="true" /> Save My Vault File
          </button>
        </div>

        <div className="move-box">
          <h3>Restore</h3>
          <p className="small">
            Pick a vault file, or an older ticket file. It is read here and is not uploaded. Nothing you already hold is replaced. Only restore a
            file you saved yourself.
          </p>
          <input
            ref={picker}
            id="move-file"
            type="file"
            accept=".txt,.json,text/plain,application/json"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) await restore(await file.text());
            }}
          />
          {locked === null ? (
            <button type="button" id="move-restore" disabled={busy} onClick={() => picker.current?.click()}>
              <PiUploadSimpleBold aria-hidden="true" /> Restore From A File
            </button>
          ) : (
            <form
              className="move-unlock"
              onSubmit={(e) => {
                e.preventDefault();
                if (unlock) void restore(locked, unlock);
              }}
            >
              <label htmlFor="move-unlock-pass">This File Is Locked. Type Its Passphrase.</label>
              <input id="move-unlock-pass" type="password" autoComplete="off" autoFocus value={unlock} onChange={(e) => setUnlock(e.target.value)} />
              <div className="row">
                <button className="primary" id="move-unlock" disabled={busy || !unlock}>
                  Unlock And Restore
                </button>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setLocked(null);
                    setUnlock("");
                    setMessage(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>

      <div className="move-box move-clear" id="move-clear">
        <h3>Clear This Browser</h3>
        <p className="small">
          Removes everything Dark Vault keeps here: your bids, seller keys, invites, saved refund address and practice wallet. Money is never kept in
          the browser, so nothing you paid is touched: refunds and payouts still go to the addresses you gave.
        </p>
        <p className="small">
          What goes is the key to them. Without it this browser can&apos;t open your bids, unlock what you won, confirm or dispute a handover, or
          hand over and manage what you sell. Save a vault file first if you may want them back (it uses the passphrase under Save, if you typed
          one). It is optional.
        </p>
        {!confirming ? (
          <div className="row">
            <button
              type="button"
              id="clear-save-first"
              disabled={busy || !counts || isEmpty(counts) || (pass.length > 0 && pass.length < MIN_PASSPHRASE)}
              onClick={() => void save()}
            >
              <PiDownloadSimpleBold aria-hidden="true" /> {saved ? "Saved. Save Again" : "Save A Vault File First"}
            </button>
            <button type="button" className="danger" id="clear-start" disabled={busy || !counts || isEmpty(counts)} onClick={() => setConfirming(true)}>
              <PiBroomBold aria-hidden="true" /> Clear Everything From This Browser
            </button>
          </div>
        ) : (
          <div className="clear-confirm" id="clear-confirm" role="alert">
            <p className="small">
              <b>
                Clear {counts ? describe(counts) : "everything"} from this browser?
              </b>{" "}
              {saved
                ? "You saved a vault file in this visit: keep it, it is the only way back."
                : "You have not saved a vault file in this visit. Once cleared, this cannot be undone."}
            </p>
            <div className="row">
              <button type="button" className="danger" id="clear-confirm-yes" onClick={clear}>
                Yes, Clear Everything
              </button>
              <button type="button" id="clear-confirm-no" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {message && (
        <p className={message.tone === "bad" ? "error small" : "move-ok small"} id="move-message" role="status">
          {message.text}
        </p>
      )}
    </section>
  );
}
