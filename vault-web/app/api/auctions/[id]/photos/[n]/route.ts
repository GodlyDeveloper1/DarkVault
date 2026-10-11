// One listing photo. A public auction's is a JPEG anyone may see (redrawn in
// the seller's browser, with no camera details). A private auction's or a
// deal's is encrypted with the listing's key: only a browser holding the
// invite is given it at all, and only that browser can open it.
import { maySee } from "@/lib/access";
import { bad } from "@/lib/http";
import { loadAuction, loadPhoto } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  // The same answer whether there is no such auction, no such photo, or the invite is missing.
  const auction = await loadAuction(id);
  const index = /^[0-9]$/.test(n) ? Number(n) : -1;
  if (!auction || !maySee(auction, req) || index < 0 || index >= (auction.photos ?? 0)) return bad("not found", 404);
  const bytes = await loadPhoto(id, index);
  if (!bytes) return bad("not found", 404);
  const sealed = !!auction.private;
  return new Response(bytes as BodyInit, {
    headers: {
      "Content-Type": sealed ? "application/octet-stream" : "image/jpeg",
      // A photo never changes once listed. A private one stays out of every shared cache.
      "Cache-Control": sealed ? "private, no-store" : "public, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
      "Content-Length": String(bytes.length),
    },
  });
}
