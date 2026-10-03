// The operator: whoever runs this site. Their one power over an auction is to
// decide a dispute about a physical lot (release the held price to the seller,
// or return it to the winner). Set VAULT_OPERATOR_KEY to turn this on.
import "server-only";
import { timingSafeEqual } from "node:crypto";
import { sha256Hex } from "./http";

export function isOperator(req: Request): boolean {
  const configured = process.env.VAULT_OPERATOR_KEY ?? "";
  const given = req.headers.get("x-operator-key") ?? "";
  if (configured.length < 24 || given.length === 0 || given.length > 200) return false;
  return timingSafeEqual(Buffer.from(sha256Hex(given), "hex"), Buffer.from(sha256Hex(configured), "hex"));
}
