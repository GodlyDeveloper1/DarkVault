// The Vault Guide reads its answers aloud, with the browser's own speech.
//
// Only voices that run on this device are used (`localService`). Some
// browsers also offer voices that are spoken by a server: the text would
// leave the browser, so those are never chosen. With no on-device voice,
// reading aloud is simply not offered. There is no microphone: speech
// recognition in Chrome and Edge sends the recording to a server.
//
// To sound less like a machine: the most natural voice on the device is
// chosen (or the one the visitor picked), it speaks a little faster than the
// default, and an answer is read one sentence at a time, with a short breath
// between sentences and a longer one between paragraphs. Symbols and short
// forms are said the way a person would say them.

const VOICE_KEY = "dv-guide-voice-name";
const SPEED_KEY = "dv-guide-voice-speed";

export const SPEEDS = [1, 1.15, 1.3] as const;
export type Speed = (typeof SPEEDS)[number];

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* fine: for this page only */
  }
};

/**
 * How human a voice is likely to sound, from its name. Newer neural voices
 * name themselves; the old robotic ones (Windows' "Desktop" voices, eSpeak)
 * come last.
 */
function naturalness(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase();
  let score = 0;
  if (/natural|neural|enhanced|premium|siri/.test(n)) score += 40;
  if (/aria|jenny|guy|sonia|ryan|libby|natasha|william|ava|samantha|daniel|karen|moira|tessa|serena|alex/.test(n)) score += 15;
  if (/google/.test(n)) score += 5;
  if (/desktop|espeak|compact|robot/.test(n)) score -= 20;
  if (v.default) score += 2;
  return score;
}

/** Every on-device voice in the page's language (or English), most natural first. */
export function localVoices(): SpeechSynthesisVoice[] {
  if (!speechAvailable()) return [];
  const all = window.speechSynthesis.getVoices().filter((v) => v.localService);
  const want = (navigator.language || "en").toLowerCase().split(/[-_@]/)[0]!;
  const mine = all.filter((v) => v.lang.toLowerCase().startsWith(want));
  const pool = mine.length ? mine : all.filter((v) => v.lang.toLowerCase().startsWith("en"));
  return (pool.length ? pool : all).slice().sort((a, b) => naturalness(b) - naturalness(a));
}

/** The voice to speak with: the visitor's choice if it is still here, else the most natural one. */
export function localVoice(): SpeechSynthesisVoice | null {
  const voices = localVoices();
  if (voices.length === 0) return null;
  const chosen = read(VOICE_KEY);
  return voices.find((v) => v.name === chosen) ?? voices[0]!;
}

export function chooseVoice(name: string): void {
  write(VOICE_KEY, name);
}

export function speed(): Speed {
  const s = Number(read(SPEED_KEY));
  return (SPEEDS as readonly number[]).includes(s) ? (s as Speed) : 1.15;
}

export function chooseSpeed(s: Speed): void {
  write(SPEED_KEY, String(s));
}

/** Calls `change` now and whenever the browser's list of voices changes (it loads late in Chrome). */
export function watchVoices(change: () => void): () => void {
  if (!speechAvailable()) return () => {};
  change();
  window.speechSynthesis.addEventListener("voiceschanged", change);
  return () => window.speechSynthesis.removeEventListener("voiceschanged", change);
}

/** Says the text the way a person reads it aloud. */
function spoken(text: string): string {
  return text
    .replace(/•\s*/g, "")
    .replace(/\bTAZ\b/g, "taz")
    .replace(/\bZEC\b/g, "zec")
    .replace(/\be\.g\./gi, "for example")
    .replace(/\bi\.e\./gi, "that is")
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/\bvs\.?\b/gi, "versus")
    .replace(/#/g, "")
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences, each marked with whether a paragraph ends after it (for a longer pause). */
function sentences(text: string): { text: string; para: boolean }[] {
  const out: { text: string; para: boolean }[] = [];
  // Short forms first, so their full stops don't end a sentence.
  text = text.replace(/\be\.g\./gi, "for example").replace(/\bi\.e\./gi, "that is");
  for (const para of text.split(/\n\s*\n|\n(?=•)/)) {
    // A sentence ends at . ! or ? followed by a space, so "0.0005" stays whole.
    const parts = para.split(/(?<=[.!?])\s+/);
    const clean = parts.map((p) => spoken(p)).filter((p) => p.length > 1);
    clean.forEach((p, i) => out.push({ text: p, para: i === clean.length - 1 }));
  }
  return out;
}

let run = 0;

/**
 * Reads `text` with an on-device voice, a sentence at a time. Returns false
 * (and says nothing) if there is none. `done` is called once, when it has
 * finished or been stopped.
 */
export function speak(text: string, done?: () => void): boolean {
  const voice = localVoice();
  if (!voice) return false;
  const synth = window.speechSynthesis;
  synth.cancel();
  const mine = ++run;
  const parts = sentences(text);
  const rate = speed();
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    done?.();
  };
  const next = (i: number) => {
    if (mine !== run) return finish();
    if (i >= parts.length) return finish();
    const u = new SpeechSynthesisUtterance(parts[i]!.text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = rate;
    u.pitch = 1;
    u.onend = () => {
      if (mine !== run) return finish();
      // A short breath after a sentence, a longer one after a paragraph.
      window.setTimeout(() => next(i + 1), parts[i]!.para ? 260 : 90);
    };
    u.onerror = () => finish();
    synth.speak(u);
  };
  next(0);
  return true;
}

export function hush(): void {
  run++;
  if (speechAvailable()) window.speechSynthesis.cancel();
}
