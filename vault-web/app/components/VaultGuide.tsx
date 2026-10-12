"use client";

// The Vault Guide: a button in the corner that opens a panel of prepared
// answers. Scripted, runs in the browser, sends nothing. See lib/guide.ts.
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PiSpeakerHighBold, PiSpeakerSlashBold } from "react-icons/pi";
import GuideBot from "./GuideBot";
import { greeting, match, questionText, replyFor, suggestions, type GuidePage, type Reply } from "@/lib/guide";
import { chooseSpeed, chooseVoice, hush, localVoice, localVoices, speak, speed, SPEEDS, watchVoices, type Speed } from "@/lib/speech";

const VOICE_KEY = "dv-guide-voice";

type Msg = { id: number; from: "me" | "guide"; text: string; actions?: Reply["actions"]; next?: string[]; done: boolean };

function pageOf(path: string): GuidePage {
  if (path === "/") return "home";
  if (path.startsWith("/dashboard")) return "dashboard";
  if (path.startsWith("/auctions")) return "auctions";
  if (path.startsWith("/auction/")) return "auction";
  if (path.startsWith("/sell")) return "sell";
  if (path === "/orders" || path.startsWith("/orders/new")) return "orders";
  if (path.startsWith("/orders/")) return "sale";
  if (path.startsWith("/settlement")) return "settlement";
  if (path.startsWith("/deal/")) return "deal";
  if (path.startsWith("/ledger")) return "ledger";
  return "home";
}

export default function VaultGuide() {
  const path = usePathname();
  const router = useRouter();
  const page = pageOf(path);
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [typing, setTyping] = useState(false);
  const [input, setInput] = useState("");
  const [peek, setPeek] = useState<string | null>(null);
  const nextId = useRef(1);
  const list = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const greeted = useRef("");
  // Reading aloud: only with a voice that runs on this device (lib/speech.ts).
  const [canSpeak, setCanSpeak] = useState(false);
  const [aloud, setAloud] = useState(false);
  const [speaking, setSpeaking] = useState<number | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const [voiceName, setVoiceName] = useState("");
  const [rate, setRate] = useState<Speed>(1.15);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(
    () =>
      watchVoices(() => {
        const v = localVoice();
        setCanSpeak(v !== null);
        setVoices(localVoices().map((x) => x.name));
        setVoiceName(v?.name ?? "");
        setRate(speed());
      }),
    [],
  );
  useEffect(() => {
    try {
      setAloud(localStorage.getItem(VOICE_KEY) === "on");
    } catch {
      /* no storage: off */
    }
  }, []);
  // Closing the panel stops the voice.
  useEffect(() => {
    if (!open) {
      hush();
      setSpeaking(null);
    }
  }, [open]);

  function read(id: number, text: string) {
    if (speaking === id) {
      hush();
      setSpeaking(null);
      return;
    }
    if (speak(text, () => setSpeaking((s) => (s === id ? null : s)))) setSpeaking(id);
  }

  function toggleAloud() {
    const on = !aloud;
    setAloud(on);
    if (!on) {
      hush();
      setSpeaking(null);
    }
    try {
      localStorage.setItem(VOICE_KEY, on ? "on" : "off");
    } catch {
      /* fine: on for this page only */
    }
  }

  // Offer help once per visit, after the visitor has been on an app page for a while.
  useEffect(() => {
    if (open || page === "home") return;
    let shown = false;
    try {
      shown = sessionStorage.getItem("dv-guide-peeked") === "1";
    } catch {
      /* no storage: offer it anyway */
    }
    if (shown) return;
    const t = window.setTimeout(() => {
      setPeek(page === "settlement" || page === "deal" ? "New here? Ask me how a deal settles." : page === "orders" || page === "sale" ? "New here? Ask me how a batch sale works." : "New here? Ask me how a sealed bid works.");
      try {
        sessionStorage.setItem("dv-guide-peeked", "1");
      } catch {
        /* fine */
      }
    }, 9000);
    return () => clearTimeout(t);
  }, [open, page]);
  useEffect(() => {
    if (!peek) return;
    const t = window.setTimeout(() => setPeek(null), 8000);
    return () => clearTimeout(t);
  }, [peek]);

  // Greet when opened, and again when the page changes.
  useEffect(() => {
    if (!open || greeted.current === page) return;
    greeted.current = page;
    say(greeting(page), true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, page]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [msgs, typing]);

  useEffect(() => {
    if (!open) return;
    setPeek(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /** Shows a reply after a short pause, then writes it out. */
  function say(r: Reply, quick = false) {
    const id = nextId.current++;
    setTyping(true);
    const pause = quick ? 250 : 450 + Math.min(500, r.text.length * 2);
    timers.current.push(
      window.setTimeout(() => {
        setTyping(false);
        setMsgs((m) => [...m, { id, from: "guide", text: "", actions: r.actions, next: r.next, done: false }]);
        const full = r.text;
        const step = Math.max(2, Math.ceil(full.length / 60));
        let i = 0;
        const tick = () => {
          i = Math.min(full.length, i + step);
          setMsgs((m) => m.map((x) => (x.id === id ? { ...x, text: full.slice(0, i), done: i >= full.length } : x)));
          if (i < full.length) timers.current.push(window.setTimeout(tick, 16));
          else if (aloudRef.current && speak(full, () => setSpeaking((s) => (s === id ? null : s)))) setSpeaking(id);
        };
        tick();
      }, pause),
    );
  }

  // The latest setting, for the timers above (they were set up before a change).
  const aloudRef = useRef(aloud);
  aloudRef.current = aloud && canSpeak;

  function ask(text: string, reply: Reply) {
    hush();
    setSpeaking(null);
    setMsgs((m) => [...m, { id: nextId.current++, from: "me", text, done: true }]);
    say(reply);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || typing) return;
    setInput("");
    ask(text, match(text));
  }

  function act(a: NonNullable<Reply["actions"]>[number]) {
    if (a.event) window.dispatchEvent(new Event(a.event));
    if (a.href) router.push(a.href);
    // On a narrow screen the panel covers the page: get out of the way.
    if (window.innerWidth < 700 || a.event) setOpen(false);
  }

  const last = [...msgs].reverse().find((m) => m.from === "guide");
  const talking = typing || (!!last && !last.done) || speaking !== null;
  const chips = last?.done && last.next?.length ? last.next : suggestions(page);

  return (
    <div className="guide-anchor">
      {peek && !open && (
        <button type="button" className="g-peek" onClick={() => setOpen(true)}>
          {peek}
        </button>
      )}
      <button
        type="button"
        id="guide-button"
        className={open ? "guide-fab on" : "guide-fab"}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="guide"
        aria-label={open ? "Close the Vault Guide" : "Open the Vault Guide"}
      >
        <GuideBot talking={talking} size={34} />
        <span>Guide</span>
      </button>

      {open && (
        <aside id="guide" className="guide" aria-label="Vault Guide">
          <div className="g-head">
            <GuideBot talking={talking} size={46} />
            <div>
              <h3>Vault Guide</h3>
              <p>Prepared answers, not an AI. It runs in your browser and nothing you type is sent.{canSpeak && " Read aloud by your device's own voice."}</p>
            </div>
            {canSpeak && (
              <button
                type="button"
                className={aloud ? "g-voice on" : "g-voice"}
                id="guide-voice"
                onClick={toggleAloud}
                aria-pressed={aloud}
                aria-label={aloud ? "Stop reading answers aloud" : "Read answers aloud"}
                title={aloud ? "Reading answers aloud. Press to stop." : "Read answers aloud, with your device's own voice"}
              >
                {aloud ? <PiSpeakerHighBold aria-hidden="true" /> : <PiSpeakerSlashBold aria-hidden="true" />}
              </button>
            )}
            <button type="button" className="link" onClick={() => setOpen(false)} aria-label="Close">
              Close
            </button>
          </div>

          {canSpeak && aloud && (
            <div className="g-voice-bar" id="guide-voice-bar">
              <span className="g-vb-label">Speed</span>
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={rate === s ? "g-speed on" : "g-speed"}
                  aria-pressed={rate === s}
                  onClick={() => {
                    chooseSpeed(s);
                    setRate(s);
                  }}
                >
                  {s === 1 ? "Normal" : s === 1.15 ? "Faster" : "Fastest"}
                </button>
              ))}
              {voices.length > 1 && (
                <select
                  className="g-voice-pick"
                  aria-label="Voice"
                  value={voiceName}
                  onChange={(e) => {
                    chooseVoice(e.target.value);
                    setVoiceName(e.target.value);
                    hush();
                    setSpeaking(null);
                    speak("This is how I sound.");
                  }}
                >
                  {voices.map((n) => (
                    <option key={n} value={n}>
                      {n.replace(/^Microsoft /, "").replace(/ - .*$/, "")}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className="g-list" ref={list} aria-live="polite" data-lenis-prevent>
            {msgs.map((m) => (
              <div key={m.id} className={m.from === "me" ? "g-msg me" : "g-msg bot"}>
                <div className="g-bubble">
                  {m.text}
                  {m.from === "guide" && !m.done && <span className="g-caret" aria-hidden="true" />}
                  {m.from === "guide" && m.done && canSpeak && (
                    <button type="button" className={speaking === m.id ? "g-listen on" : "g-listen"} onClick={() => read(m.id, m.text)} aria-label={speaking === m.id ? "Stop" : "Listen"}>
                      {speaking === m.id ? <PiSpeakerSlashBold aria-hidden="true" /> : <PiSpeakerHighBold aria-hidden="true" />}
                      {speaking === m.id ? "Stop" : "Listen"}
                    </button>
                  )}
                  {m.done && !!m.actions?.length && (
                    <div className="g-actions">
                      {m.actions.map((a) => (
                        <button key={a.label} type="button" className="primary" onClick={() => act(a)}>
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {typing && (
              <div className="g-msg bot">
                <div className="g-bubble g-typing" aria-label="Writing">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            )}
          </div>

          {!typing && (
            <div className="g-chips">
              {chips.map((id) => (
                <button key={id} type="button" onClick={() => ask(questionText(id), replyFor(id))}>
                  {questionText(id)}
                </button>
              ))}
            </div>
          )}

          <form className="g-input" onSubmit={submit}>
            <input type="text" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask A Question…" aria-label="Ask the Vault Guide" />
            <button className="primary" disabled={!input.trim() || typing}>
              Ask
            </button>
          </form>
        </aside>
      )}
    </div>
  );
}
