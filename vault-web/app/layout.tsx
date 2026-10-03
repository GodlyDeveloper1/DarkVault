import type { Metadata } from "next";
import Link from "next/link";
// Fonts are bundled with the app: no requests to font CDNs.
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import ChainStatus from "./components/ChainStatus";
import WalletButton from "./components/WalletButton";

export const metadata: Metadata = {
  title: { default: "Dark Vault — sealed-bid auctions on shielded Zcash", template: "%s · Dark Vault" },
  description:
    "A sealed-bid auction house on Zcash. Bids are shielded deposits: nobody watching the chain can see who bid, how much, who won or what was paid.",
  referrer: "no-referrer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="shell top-in">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true" />
              Dark Vault
            </Link>
            <nav>
              <Link href="/#auctions">Auctions</Link>
              <Link href="/sell" className="btn primary sm">
                Sell something
              </Link>
              <WalletButton />
            </nav>
          </div>
        </header>
        {children}
        <footer className="foot">
          <div className="shell foot-in">
            <span>Dark Vault · Zcash testnet · built for the Zecathon by Diaguren Labs</span>
            <ChainStatus />
          </div>
        </footer>
      </body>
    </html>
  );
}
