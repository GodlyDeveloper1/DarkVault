import type { Metadata } from "next";
// Fonts are bundled with the app: no requests to font CDNs.
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import Frame from "./components/Frame";
import TopLoader from "./components/TopLoader";

export const metadata: Metadata = {
  title: { default: "Dark Vault — private markets on shielded Zcash", template: "%s · Dark Vault" },
  description:
    "Privacy at its peak. Three private markets on Zcash: sealed-bid auctions, sealed batch sales and escrowed deals. Every payment is shielded: nobody watching the chain can see who paid, how much, who won or what was paid.",
  referrer: "no-referrer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The script below adds a class to <html> before React starts, so React is told not to mind the difference.
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Switches the home page's scroll story on before the first paint, unless the visitor has asked for reduced motion. Without it the page is a plain, complete document. It lives here, not in the page, because the layout is only ever drawn by the server. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(!matchMedia('(prefers-reduced-motion: reduce)').matches)document.documentElement.classList.add('dv-motion')}catch(e){}",
          }}
        />
        <TopLoader />
        <Frame>{children}</Frame>
      </body>
    </html>
  );
}
