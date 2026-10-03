// Reads a request body with a hard size cap. Route handlers have no built-in
// limit, and Content-Length can be missing or wrong, so the body is read chunk
// by chunk and abandoned the moment it goes over.
import "server-only";

export class BodyTooLarge extends Error {
  constructor() {
    super("request too large");
    this.name = "BodyTooLarge";
  }
}

export async function readCapped(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new BodyTooLarge();
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export async function readCappedText(req: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readCapped(req, maxBytes));
}
