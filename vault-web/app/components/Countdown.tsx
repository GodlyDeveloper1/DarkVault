"use client";

// Counts down to a moment, using the server's clock (the offset is passed in),
// so a visitor whose own clock is wrong still sees the right time left.
import { useEffect, useState } from "react";

export function parts(ms: number): { d: number; h: number; m: number; s: number } {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { d: Math.floor(total / 86400), h: Math.floor((total % 86400) / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

export default function Countdown({ to, offset = 0, onDone }: { to: number; offset?: number; onDone?: () => void }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now() + offset);
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [offset]);
  const left = now === null ? null : to - now;
  useEffect(() => {
    if (left !== null && left <= 0) onDone?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left !== null && left <= 0]);
  if (left === null) return <span className="count">&nbsp;</span>;
  const p = parts(left);
  const cells: [number, string][] = p.d > 0 ? [[p.d, "d"], [p.h, "h"], [p.m, "m"]] : [[p.h, "h"], [p.m, "m"], [p.s, "s"]];
  return (
    <span className="count" role="timer" aria-live="off">
      {cells.map(([v, unit]) => (
        <span key={unit} className="count-cell">
          <b key={v}>{String(v).padStart(2, "0")}</b>
          <i>{unit}</i>
        </span>
      ))}
    </span>
  );
}
