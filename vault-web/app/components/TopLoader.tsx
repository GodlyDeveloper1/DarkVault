"use client";

// The bar across the top of the window while the next page loads.
//
// It starts the moment a link to another page of this site is clicked,
// creeps forward while the page is put together, and fills and fades once the
// new page is on screen (the address has changed and the "Opening The Vault"
// screen, if one was shown, has gone). Links to the same page, to a #section,
// to another site, or opened in a new tab don't start it. It gives up quietly
// after 12 seconds, so it can never hang there.
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "loading" | "done";

export default function TopLoader() {
  const path = usePathname();
  const [phase, setPhase] = useState<Phase>("idle");
  const [width, setWidth] = useState(0);
  const from = useRef<string | null>(null);
  const timers = useRef<number[]>([]);

  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  const finish = () => {
    clear();
    from.current = null;
    setWidth(100);
    setPhase("done");
    timers.current.push(window.setTimeout(() => {
      setPhase("idle");
      setWidth(0);
    }, 420));
  };

  // Start on a click on a link to another page here.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href || a.target === "_blank" || a.hasAttribute("download")) return;
      let to: URL;
      try {
        to = new URL(a.href);
      } catch {
        return;
      }
      if (to.origin !== location.origin) return;
      if (to.pathname === location.pathname && to.search === location.search) return; // the same page, or a #section of it
      clear();
      from.current = location.pathname + location.search;
      setPhase("loading");
      setWidth(12);
      // Creep towards the end, slower and slower, never reaching it on its own.
      let w = 12;
      const creep = () => {
        w = w + (90 - w) * 0.12;
        setWidth(w);
        timers.current.push(window.setTimeout(creep, 260));
      };
      timers.current.push(window.setTimeout(creep, 160));
      timers.current.push(window.setTimeout(finish, 12000));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Finish when the new page is on screen.
  useEffect(() => {
    if (phase !== "loading" || from.current === null) return;
    if (path + location.search === from.current) return;
    // A page that shows "Opening The Vault" first is not there yet: wait for it to go.
    const check = () => {
      if (document.querySelector("main.loader")) timers.current.push(window.setTimeout(check, 120));
      else finish();
    };
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, phase]);

  useEffect(() => () => clear(), []);

  return (
    <div className={`top-loader ${phase}`} aria-hidden="true">
      <span style={{ width: `${width}%` }} />
    </div>
  );
}
