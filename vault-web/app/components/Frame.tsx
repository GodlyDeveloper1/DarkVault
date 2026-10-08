"use client";

// The frame around every page.
//
//   - The landing page ("/") is a site: a floating header, the page, a footer.
//   - Everything else is the app: a sidebar, the page beside it.
//
// The Vault Guide sits in the corner of both.
import Link from "next/link";
import { usePathname } from "next/navigation";
import ChainStatus from "./ChainStatus";
import NavMenu from "./NavMenu";
import Sidebar from "./Sidebar";
import VaultGuide from "./VaultGuide";
import WalletButton from "./WalletButton";

export default function Frame({ children }: { children: React.ReactNode }) {
  const path = usePathname();

  if (path === "/") {
    return (
      <>
        <header className="top">
          <div className="shell">
            <div className="top-in">
              <Link href="/" className="brand">
                <span className="brand-mark" aria-hidden="true" />
                Dark Vault
              </Link>
              <NavMenu>
                <div className="nav-links">
                  <Link href="/auctions">Auctions</Link>
                  <Link href="/orders">Order Flow</Link>
                  <Link href="/settlement">Settlement</Link>
                  <Link href="/#story">How It Works</Link>
                  <Link href="/#privacy">Privacy</Link>
                </div>
                <div className="nav-acts">
                  <Link href="/dashboard" className="btn primary sm" id="open-dashboard">
                    Open Dashboard
                  </Link>
                  <WalletButton />
                </div>
              </NavMenu>
            </div>
          </div>
        </header>
        {children}
        <footer className="foot">
          <div className="shell foot-in">
            <span>Dark Vault runs on the Zcash testnet. Built for the Zecathon by Diaguren Labs.</span>
            <ChainStatus />
          </div>
        </footer>
        <div className="dock">
          <VaultGuide />
        </div>
      </>
    );
  }

  return (
    <div className="app">
      <Sidebar />
      <div className="app-main">{children}</div>
      <div className="dock">
        <VaultGuide />
      </div>
    </div>
  );
}
