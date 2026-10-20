// A deal's optional code: something the seller tells the buyer apart from the
// link (by phone, say). Paying for the deal then needs both, so a link that
// is forwarded or seen over someone's shoulder is not enough to take the deal.
//
// The code never reaches the site. The browser sends a hash of it made with
// the deal's invite key, which the site never sees either, so even the stored
// hash can't be used to guess the code without the link.
import { sha256Hex } from "vault-core";

/** Spaces, dashes and case don't matter: "ab-12 cd" is "AB12CD". */
export const normalCode = (code: string) => code.toUpperCase().replace(/[\s-]+/g, "");

export const CODE_MIN = 4;
export const CODE_MAX = 32;

export function codeProblem(code: string): string | null {
  const c = normalCode(code);
  if (c.length === 0) return null;
  if (c.length < CODE_MIN) return `at least ${CODE_MIN} letters or numbers`;
  if (c.length > CODE_MAX) return `at most ${CODE_MAX} letters or numbers`;
  return null;
}

export function dealCodeHash(invite: string, code: string): Promise<string> {
  return sha256Hex(`dark-vault/deal-code:${invite}:${normalCode(code)}`);
}
