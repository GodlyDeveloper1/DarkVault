// The site's signing key, for receipts (vault-core receipt.ts). Made on first
// use and kept in the data folder. It signs receipts and nothing else: it
// holds no money and opens no bid.
import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";
import { newSiteKey, sitePublicKey } from "vault-core";
import { DATA_DIR } from "./datadir";

const FILE = path.join(DATA_DIR, "site-key.json");

interface SiteKey {
  secret: string;
  public: string;
}

let loading: Promise<SiteKey> | null = null;

async function load(): Promise<SiteKey> {
  const read = async () => {
    const { secret } = JSON.parse(await fs.readFile(FILE, "utf8")) as { secret: string };
    return { secret, public: sitePublicKey(secret) };
  };
  try {
    return await read();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    // "wx": never replaces a key that is already there.
    await fs.writeFile(FILE, JSON.stringify({ secret: newSiteKey(), made_at: new Date().toISOString() }, null, 1), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return read();
}

export function siteKey(): Promise<SiteKey> {
  loading ??= load().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** The public half, or null if the key can't be read. Never throws: a page must still load. */
export async function sitePublic(): Promise<string | null> {
  try {
    return (await siteKey()).public;
  } catch {
    return null;
  }
}
