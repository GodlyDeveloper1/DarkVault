// A stand-in for the drand network, for developing and testing without the
// real one. It has its own key and signs any round once that round's time has
// come, exactly as the real network does, so the whole time-lock path runs:
// seal in the browser, wait for the close, fetch the signature, open.
//
// It is NOT a time lock. Whoever runs it holds its key and could sign any
// round early. Every auction page that uses it says "TEST BEACON" in a banner.
//
//   node scripts/mock-beacon.mjs
//   VAULT_TEST_BEACON_URL=http://127.0.0.1:8090 npm run dev     (in vault-web)
//
// Routes, like a drand relay:
//   GET /info              the chain: its key, when it began, how often it signs
//   GET /public/<round>    that round's signature; 425 if its time has not come
// Test-only:
//   POST /__down, /__up    pretend the network can't be reached, and bring it back
import http from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// The signing library lives with vault-core; this script has no packages of its own.
const require = createRequire(new URL("../vault-core/package.json", import.meta.url));
const { bls12_381: bls } = require("@noble/curves/bls12-381");

const PORT = Number(process.env.MOCK_BEACON_PORT ?? 8090);
const SECRET = Buffer.from(process.env.MOCK_BEACON_SECRET ?? "1f".repeat(32), "hex");
const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

const chain = {
  public_key: Buffer.from(bls.getPublicKeyForShortSignatures(SECRET)).toString("hex"),
  period: 3,
  genesis_time: 1_746_111_111,
  scheme: "bls-unchained-g1-rfc9380",
  group_hash: "bb".repeat(32),
  name: "dark-vault-test",
};
// A chain id of its own, so nothing sealed here can be mistaken for the public network's.
chain.hash = sha256(Buffer.from(`dark-vault-test-beacon|${chain.public_key}|${chain.genesis_time}|${chain.period}`)).toString("hex");

let down = false;

const send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname === "/__down") return (down = true), send(res, 200, { down });
    if (req.method === "POST" && url.pathname === "/__up") return (down = false), send(res, 200, { down });
    if (down) return send(res, 503, { error: "the test beacon is switched off" });
    if (req.method !== "GET") return send(res, 405, { error: "GET only" });
    if (url.pathname === "/info") return send(res, 200, chain);
    const m = /^\/public\/(\d{1,15})$/.exec(url.pathname);
    if (!m) return send(res, 404, { error: "not found" });
    const round = Number(m[1]);
    const due = (chain.genesis_time + (round - 1) * chain.period) * 1000;
    if (round < 1 || Date.now() < due) return send(res, 425, { error: "that round has not been signed yet" });
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(round));
    const signature = Buffer.from(bls.signShortSignature(sha256(message), SECRET, { DST })).toString("hex");
    send(res, 200, { round, signature, randomness: sha256(Buffer.from(signature, "hex")).toString("hex") });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`TEST beacon on http://127.0.0.1:${PORT}  (chain ${chain.hash.slice(0, 12)}…, a round every ${chain.period}s). It locks nothing: for tests only.`);
  });
