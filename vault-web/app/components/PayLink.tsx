"use client";

// "Pay From Wallet": a zcash: payment link (ZIP 321). Only a Zcash wallet app
// installed on this device can answer it; with none, the browser does nothing
// and the button seems broken. So if the page still has the focus a moment
// after the click (no app took over), say what to do instead.

import { useEffect, useRef, useState } from "react";

const WAIT_MS = 2200;

export default function PayLink({ href }: { href: string }) {
  const [hint, setHint] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const left = () => {
      // An app opened (or the browser asked to open one): the link worked.
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
    window.addEventListener("blur", left);
    document.addEventListener("visibilitychange", left);
    return () => {
      window.removeEventListener("blur", left);
      document.removeEventListener("visibilitychange", left);
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  return (
    <>
      <a
        className="btn primary sm pay-link"
        href={href}
        onClick={() => {
          setHint(false);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => {
            timer.current = null;
            if (document.visibilityState === "visible" && document.hasFocus()) setHint(true);
          }, WAIT_MS);
        }}
      >
        Pay From Wallet
      </a>
      {hint && (
        <p className="hint pay-hint" role="status">
          No wallet app opened. This button only works with a Zcash wallet app on this device. Copy the address instead, or scan the code with
          your phone&apos;s Zcash wallet.
        </p>
      )}
    </>
  );
}
