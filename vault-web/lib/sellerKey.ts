// The seller's key, as a browser comes to hold it.
//
// It arrives after the # of the seller's own link, which browsers never send
// to a server, and is kept in local storage so the seller's view opens again.
//
// A key from a link is not trusted because it is in a link. Anyone can send a
// seller a link with a made-up key after the #. So a key from the address bar
// is stored only once the site has confirmed it is this record's key, and a
// key that fails never replaces one already held. (The site is shown a token
// made from the key, never the key.)
import { manageToken } from "vault-core";

const HEX64 = /^[0-9a-f]{64}$/;
const name = (id: string) => `dv-manage-${id}`;

function stored(id: string): string | null {
  try {
    const k = localStorage.getItem(name(id));
    return k && HEX64.test(k) ? k : null;
  } catch {
    return null;
  }
}

function clearHash() {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

/**
 * The seller key this browser should use for a record, or null if it has none.
 * Reads the address bar and local storage, and settles between them.
 */
export async function sellerKeyFor(id: string): Promise<string | null> {
  const hash = window.location.hash.replace(/^#/, "");
  const offered = hash.startsWith("manage=") && HEX64.test(hash.slice(7)) ? hash.slice(7) : null;
  const held = stored(id);
  if (!offered) return held;
  if (offered === held) {
    clearHash();
    return held;
  }
  try {
    const res = await fetch(`/api/auctions/${id}/seller`, { headers: { "x-manage-key": await manageToken(offered) } });
    void res.body?.cancel(); // only the answer's status matters here
    if (res.ok) {
      try {
        localStorage.setItem(name(id), offered);
        // Out of the address bar now that this browser remembers it: a seller who
        // copies the page address to share it must not hand over their key with it.
        clearHash();
      } catch {
        /* no storage: it stays in the address bar and works for this visit */
      }
      return offered;
    }
    if (res.status === 404) {
      // Not this record's key. Drop it, and keep whatever was held.
      clearHash();
      return held;
    }
  } catch {
    /* the site could not be reached */
  }
  // Not confirmed either way: use it for this visit, store nothing.
  return offered;
}
