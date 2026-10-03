"use client";

// The status line in the footer: is the signer reachable, and at which block?
import { useEffect, useState } from "react";

export default function ChainStatus() {
  const [s, setS] = useState<{ online: boolean; scanned_height?: number } | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/status")
        .then((r) => r.json())
        .then((v) => !stop && setS(v))
        .catch(() => !stop && setS({ online: false }));
    load();
    const t = setInterval(load, 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  if (!s) return <span className="chain">…</span>;
  return (
    <span className="chain">
      <i className={s.online ? "dot live" : "dot off"} />
      {s.online ? `block ${s.scanned_height?.toLocaleString("en-US")}` : "signer offline"}
    </span>
  );
}
