// A stand-in for the Dark Vault signer, for developing and testing the web app
// without a wallet, a chain or testnet coins. It answers the same routes, keeps
// vaults in memory, and has a pretend chain that mines a block every few seconds.
//
// It enforces the same settlement rules as the real signer (exact sums, every
// deposit confirmed, one settlement at a time), so the web app's plans are
// checked the same way. It builds no transactions.
//
//   node scripts/mock-signer.mjs
//
// Test-only routes:
//   POST /__deposit {address, zatoshis}   pretend someone paid a deposit address
//   GET  /__log                           everything this stand-in has been sent
import http from "node:http";

const PORT = Number(process.env.MOCK_SIGNER_PORT ?? 8082);
const BLOCK_MS = Number(process.env.MOCK_BLOCK_MS ?? 5000);
const MIN_CONF = Number(process.env.VAULT_MIN_CONFIRMATIONS ?? 2);

let height = 5_000_000;
setInterval(() => (height += 1), BLOCK_MS).unref();

const vaults = new Map(); // id -> { birthday, addresses: Set, deposits: [], settlements: [] }
const log = [];
const hex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

const status = (s) => (s.mined_height <= height ? "mined" : "pending");
const confirmations = (d) => (d.mined_height <= height ? height - d.mined_height + 1 : 0);

function info(id, v) {
  const mined = v.deposits.filter((d) => d.mined_height <= height);
  const unspent = mined.filter((d) => !d.spent);
  const settlements = v.settlements.map((s) => ({ txid: s.txid, status: status(s), mined_height: status(s) === "mined" ? s.mined_height : null, fee_zatoshis: s.fee, payments: s.payments }));
  return {
    vault_id: id,
    birthday_height: v.birthday,
    chain_tip: height,
    scanned_height: height,
    min_confirmations: MIN_CONF,
    balance_total_zatoshis: unspent.reduce((s, d) => s + d.value, 0),
    balance_spendable_zatoshis: unspent.filter((d) => confirmations(d) >= MIN_CONF).reduce((s, d) => s + d.value, 0),
    deposits: mined.filter((d) => !d.internal).map((d) => ({ txid: d.txid, mined_height: d.mined_height, confirmations: confirmations(d), pool: "ironwood", value_zatoshis: d.value, to_address: d.address })),
    settlement: settlements[settlements.length - 1] ?? null,
    settlements,
  };
}

function settle(v, payments) {
  const last = v.settlements[v.settlements.length - 1];
  if (last && status(last) === "pending") return [400, "this vault has a settlement waiting to be mined; it can't settle again yet"];
  if (!Array.isArray(payments) || payments.length === 0) return [400, "a settlement needs at least one payment"];
  for (const [i, p] of payments.entries()) {
    if (typeof p.to !== "string" || !p.to.startsWith("utest1")) return [400, `payment ${i}: please use a shielded unified address`];
    if (!Number.isSafeInteger(p.zatoshis) || p.zatoshis <= 0) return [400, `payment ${i} is for nothing`];
  }
  const unspent = v.deposits.filter((d) => d.mined_height <= height && !d.spent);
  const total = unspent.reduce((s, d) => s + d.value, 0);
  const asked = payments.reduce((s, p) => s + p.zatoshis, 0);
  if (asked !== total) return [400, `the payments add up to ${asked} zat but the vault holds ${total} zat; a settlement must pay out exactly what was deposited`];
  if (unspent.some((d) => confirmations(d) < MIN_CONF)) return [400, "not every deposit is confirmed enough to spend"];

  // 5000 zat per action, at least two, plus one action of padding, as seen on testnet.
  const fee = 5000 * (Math.max(2, unspent.length, payments.length) + 1);
  const payers = payments.map((p, i) => (p.pays_fee ? i : -1)).filter((i) => i >= 0);
  if (payers.length === 0) return [400, "no payment is marked to pay the network fee"];
  const share = Math.floor(fee / payers.length);
  const amounts = payments.map((p) => p.zatoshis);
  payers.forEach((i, n) => (amounts[i] -= share + (n === 0 ? fee % payers.length : 0)));
  if (amounts.some((a) => a <= 0)) return [400, "a payment is too small to pay its share of the network fee"];

  for (const d of unspent) d.spent = true;
  const s = { txid: hex(32), fee, mined_height: height + 1, payments: payments.map((p, i) => ({ to: p.to, zatoshis: amounts[i] })) };
  v.settlements.push(s);
  // A payment to an address of another vault here (an auction's escrow vault)
  // arrives there when the transaction is mined. Like the real signer, the
  // receiving vault counts it in its balance but does not list it as a deposit
  // from outside.
  for (const p of s.payments) {
    for (const other of vaults.values()) {
      if (other.addresses.has(p.to)) other.deposits.push({ txid: s.txid, address: p.to, value: p.zatoshis, mined_height: s.mined_height, spent: false, internal: true });
    }
  }
  return [200, { txid: s.txid, status: "pending", mined_height: null, fee_zatoshis: fee, payments: s.payments }];
}

http
  .createServer(async (req, res) => {
    const json = (code, value) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const text = (code, value) => {
      res.writeHead(code, { "content-type": "text/plain" });
      res.end(value);
    };
    const { method, url: path } = req;
    if (method === "GET" && path === "/__log") return json(200, log);
    if (method === "GET" && path === "/health") return text(200, "ok");

    const raw = method === "POST" ? await readBody(req) : "";
    if (!path.startsWith("/__")) log.push({ method, path, body: raw });
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return text(400, "bad json");
    }

    if (method === "GET" && path === "/status") return json(200, { chain_tip: height, scanned_height: height, sync_error: null });

    if (method === "POST" && path === "/addresses/check") {
      const a = String(body.address ?? "");
      return json(200, a.startsWith("utest1") && a.length >= 24 ? { ok: true, reason: null } : { ok: false, reason: "please use a shielded unified address (it starts with utest1)" });
    }

    if (method === "POST" && path === "/vaults") {
      const id = hex(8);
      vaults.set(id, { birthday: height, addresses: new Set(), deposits: [], settlements: [] });
      return json(200, { vault_id: id, birthday_height: height });
    }

    if (method === "POST" && path === "/__deposit") {
      for (const v of vaults.values()) {
        if (v.addresses.has(body.address)) {
          v.deposits.push({ txid: hex(32), address: body.address, value: body.zatoshis, mined_height: height + 1, spent: false });
          return json(200, { mined_height: height + 1 });
        }
      }
      return text(404, "no vault has that address");
    }

    const m = path.match(/^\/vaults\/([0-9a-f]{16})(\/addresses|\/settle)?$/);
    if (m) {
      const v = vaults.get(m[1]);
      if (!v) return text(400, `unknown vault ${m[1]}`);
      if (method === "GET" && !m[2]) return json(200, info(m[1], v));
      if (method === "POST" && m[2] === "/addresses") {
        if (v.settlements.length) return text(400, "this vault has been settled; it takes no new deposits");
        const address = "utest1standin" + hex(24);
        v.addresses.add(address);
        return json(200, { address });
      }
      if (method === "POST" && m[2] === "/settle") {
        const [code, value] = settle(v, body.payments);
        return code === 200 ? json(200, value) : text(code, value);
      }
    }
    text(404, "not found");
  })
  .listen(PORT, "127.0.0.1", () => console.log(`stand-in vault signer on 127.0.0.1:${PORT} (a block every ${BLOCK_MS} ms, ${MIN_CONF} confirmations to spend)`));
