// Small helpers shared by the API routes.
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { readCappedText } from "./body";

export const noStore = { "Cache-Control": "no-store" };

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: noStore });
}

export function ok(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: noStore });
}

/** Parses a small JSON body. Returns null if it is too large or not an object. */
export async function readJson(req: Request, maxBytes = 4000): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readCappedText(req, maxBytes));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Does this secret hash to the stored hash? Compared in constant time. */
export function matches(secret: string | null, storedHash: string): boolean {
  if (!secret || secret.length > 200) return false;
  const a = Buffer.from(sha256Hex(secret), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- Rate limits: in memory, per visitor. Enough for a single-server deployment. ---

const buckets = new Map<string, number[]>();

/**
 * The visitor's address, used only as a rate-limit key in memory (never logged
 * or stored). X-Forwarded-For is trusted only when TRUST_PROXY=1, and only its
 * last entry: the one our own proxy appended.
 */
export function clientKey(req: Request): string {
  if (process.env.TRUST_PROXY === "1") {
    const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1]!.slice(0, 64);
  }
  return "direct";
}

/** Records a hit; returns the seconds to wait if over the limit, or 0. Off under `next dev`. */
export function limited(name: string, key: string, max: number, windowMs: number): number {
  if (process.env.NODE_ENV !== "production" && process.env.RATE_LIMITS !== "on") return 0;
  const id = `${name}:${key}`;
  const now = Date.now();
  const hits = (buckets.get(id) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(id, hits);
    return Math.ceil((windowMs - (now - hits[0]!)) / 1000);
  }
  hits.push(now);
  buckets.set(id, hits);
  if (buckets.size > 20000) for (const [k, v] of buckets) if (v.every((t) => now - t > windowMs)) buckets.delete(k);
  return 0;
}

export function tooMany(seconds: number, what: string) {
  return NextResponse.json(
    { error: `Too many ${what} from this connection. Try again in about ${Math.ceil(seconds / 60)} minute(s).` },
    { status: 429, headers: { ...noStore, "Retry-After": String(seconds) } },
  );
}
