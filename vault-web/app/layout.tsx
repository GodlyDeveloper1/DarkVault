import type { Metadata } from "next";
// Fonts are bundled with the app: no requests to font CDNs.
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./globals.css";
import Frame from "./components/Frame";
import TopLoader from "./components/TopLoader";

const SHARE_TEXT =
  "Sealed-bid auctions, sealed batch sales and escrowed deals on shielded Zcash. Nobody watching the chain can see who paid, how much or who won.";

export const metadata: Metadata = {
  title: { default: "Dark Vault — private markets on shielded Zcash", template: "%s · Dark Vault" },
  description:
    "Privacy at its peak. Three private markets on Zcash: sealed-bid auctions, sealed batch sales and escrowed deals. Every payment is shielded: nobody watching the chain can see who paid, how much, who won or what was paid.",
  referrer: "no-referrer",
  // The card a chat app or a social site shows when someone pastes a link to the
  // site: the front page, the name and one line. The picture is a screenshot of
  // the home page (public/og.jpg). Links in the card need the site's own address.
  metadataBase: new URL(process.env.SITE_URL || "https://zecdarkvault.xyz"),
  openGraph: {
    type: "website",
    siteName: "Dark Vault",
    title: "Dark Vault — private markets on shielded Zcash",
    description: SHARE_TEXT,
    url: "/",
    images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "Dark Vault: Bid in the dark. The highest sealed bid wins." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Dark Vault — private markets on shielded Zcash",
    description: SHARE_TEXT,
    images: ["/og.jpg"],
  },
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
        {/*
          The home page's preloader. The first visit has to fetch the fonts and the 3D
          objects; without it, the hero's entrance played while they were still on
          their way, and the visitor saw the objects pop in after it had finished.
          On the home page the cover goes up before the first paint and every
          animation on the page waits behind it. It comes down once the page and its
          fonts have loaded (or after 8 seconds, whatever happens), and then the
          entrance plays. Moving to the home page from another page needs none of
          this, and without JavaScript the cover is never shown.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{(function(){if(location.pathname!=='/')return;var r=document.documentElement,t=Date.now(),gone=0;r.classList.add('dv-preload');" +
              "function end(){if(gone)return;gone=1;setTimeout(function(){r.classList.add('dv-preload-out');r.classList.remove('dv-preload');setTimeout(function(){r.classList.remove('dv-preload-out')},600)},Math.max(0,700-(Date.now()-t)))}" +
              "function ready(){var f=document.fonts&&document.fonts.ready;f?f.then(end,end):end()}" +
              "if(document.readyState==='complete')ready();else addEventListener('load',ready);setTimeout(end,8000)})()}catch(e){}",
          }}
        />
        <div className="preload" aria-hidden="true">
          <div className="loader-in">
            <span className="loader-art">
              <span className="ring" />
              {/* Lazy: on other pages the cover is never shown, so its picture is never fetched. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/art/s/safe.webp" alt="" width={192} height={192} draggable={false} loading="lazy" />
            </span>
            <p className="loader-title">Opening The Vault</p>
            <span className="preload-bar">
              <i />
            </span>
            <p className="peak sm">Privacy At Its Peak.</p>
          </div>
        </div>
        <TopLoader />
        <Frame>{children}</Frame>
      </body>
    </html>
  );
}
