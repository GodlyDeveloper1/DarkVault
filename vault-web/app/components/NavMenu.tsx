"use client";

// The site's navigation. On a wide screen it is a row in the header. On a
// narrow one it folds behind a three-bar button and opens as a panel.
//
// The wallet panel is drawn inside this <nav> (it belongs to the wallet
// button), and other pages can ask it to open. So a closed menu hides its
// links and buttons, never the <nav> itself: a wallet panel that is open stays
// on screen whatever the menu is doing.
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function NavMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();

  // A new page: the menu has done its job.
  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        id="menu-button"
        className={open ? "burger on" : "burger"}
        aria-label={open ? "Close the menu" : "Open the menu"}
        aria-expanded={open}
        aria-controls="site-nav"
        onClick={() => setOpen((o) => !o)}
      >
        <i aria-hidden="true" />
        <i aria-hidden="true" />
        <i aria-hidden="true" />
      </button>
      <nav
        id="site-nav"
        className={open ? "open" : ""}
        onClick={(e) => {
          // Following a link closes the menu. The wallet button does not: its panel opens over it.
          if ((e.target as HTMLElement).closest("a")) setOpen(false);
        }}
      >
        {children}
      </nav>
    </>
  );
}
