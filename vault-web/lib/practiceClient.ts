// The practice wallet, as this browser holds it: one token in local storage.
//
// A practice wallet is custodial. The site holds its coins, it only works in
// practice auctions, and the site can tell which practice bids are its. It is
// for trying the site; real auctions are bid on with the visitor's own wallet.
import { announce } from "./tickets";
import type { WalletView } from "./house/practice";

const KEY = "dv-practice";

export function practiceToken(): string | null {
  try {
    const t = localStorage.getItem(KEY);
    return t && /^[0-9a-f]{24}\.[0-9a-f]{48}$/.test(t) ? t : null;
  } catch {
    return null;
  }
}

function keep(token: string | null) {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the wallet lasts for this page only */
  }
  announce();
}

export const forgetPracticeWallet = () => keep(null);

/** This browser's practice wallet as the site sees it, or null if there is none (or the site no longer knows it). */
export async function practiceWallet(): Promise<WalletView | null> {
  const token = practiceToken();
  if (!token) return null;
  const res = await fetch("/api/practice/wallet", { headers: { "x-practice-token": token } });
  if (res.status === 404) {
    keep(null); // the site has no such wallet (its data was reset): forget it
    return null;
  }
  return res.ok ? ((await res.json()).wallet as WalletView) : null;
}

/** Asks the site for a new practice wallet and remembers it. Throws with the site's reason if it says no. */
export async function makePracticeWallet(): Promise<WalletView> {
  const res = await fetch("/api/practice/wallet", { method: "POST" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? "a practice wallet could not be made");
  keep(body.token);
  return body.wallet as WalletView;
}
