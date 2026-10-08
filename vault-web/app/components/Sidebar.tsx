"use client";

// The app's side navigation: the dashboard, the auctions, selling, and where to
// read more. On a narrow screen it folds behind a three-bar button in a top bar.
//
// The wallet panel is drawn inside this <aside> (it belongs to the wallet
// button). So the folded sidebar is moved off screen with `left`, never with a
// transform: a transformed parent would trap the panel inside it.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { IconType } from "react-icons";
import { PiEyeBold, PiGavelBold, PiHandshakeBold, PiPathBold, PiScalesBold, PiSquaresFourBold, PiStackBold, PiTagBold, PiWarningBold } from "react-icons/pi";
import ChainStatus from "./ChainStatus";
import WalletButton from "./WalletButton";

type Item = { href: string; label: string; icon: IconType; under?: string };

const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: "Vault",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: PiSquaresFourBold },
      { href: "/ledger", label: "Ledger", icon: PiScalesBold },
    ],
  },
  {
    title: "Markets",
    items: [
      { href: "/auctions", label: "Auctions", icon: PiGavelBold, under: "/auction/" },
      { href: "/sell", label: "Sell Something", icon: PiTagBold },
      { href: "/orders", label: "Order Flow", icon: PiStackBold },
      { href: "/settlement", label: "Settlement", icon: PiHandshakeBold, under: "/deal/" },
    ],
  },
  {
    title: "Learn",
    items: [
      { href: "/#story", label: "How It Works", icon: PiPathBold },
      { href: "/#privacy", label: "Who Sees What", icon: PiEyeBold },
      { href: "/#limits", label: "The Limits", icon: PiWarningBold },
    ],
  },
];

export default function Sidebar() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]); // a new page: the menu has done its job

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const on = (it: Item) => path === it.href || path.startsWith(`${it.href}/`) || (!!it.under && path.startsWith(it.under));

  const brand = (
    <Link href="/" className="brand">
      <span className="brand-mark" aria-hidden="true" />
      Dark Vault
    </Link>
  );

  return (
    <>
      <div className="topbar">
        {brand}
        <button
          type="button"
          id="menu-button"
          className={open ? "burger on" : "burger"}
          aria-label={open ? "Close the menu" : "Open the menu"}
          aria-expanded={open}
          aria-controls="side"
          onClick={() => setOpen((o) => !o)}
        >
          <i aria-hidden="true" />
          <i aria-hidden="true" />
          <i aria-hidden="true" />
        </button>
      </div>
      {open && <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
      <aside id="side" className={open ? "side open" : "side"}>
        <div className="side-brand">{brand}</div>
        <nav aria-label="App">
          {GROUPS.map((g) => (
            <div key={g.title} className="side-group">
              <p className="side-title">{g.title}</p>
              {g.items.map((it) => (
                <Link key={it.href} href={it.href} className={on(it) ? "side-link on" : "side-link"} aria-current={on(it) ? "page" : undefined}>
                  <i className="side-ico" aria-hidden="true">
                    <it.icon />
                  </i>
                  <span>{it.label}</span>
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-wallet">
          <WalletButton />
        </div>
        <div className="side-foot">
          <p className="peak sm">Privacy At Its Peak.</p>
          <ChainStatus />
          <p className="side-credit">Zcash testnet. Built for the Zecathon by Diaguren Labs.</p>
        </div>
      </aside>
    </>
  );
}
