"use client";

// A listing's photos on its page. A public listing's are plain JPEGs served by
// the site. A private auction's or a deal's arrive encrypted and are opened
// here with the invite this browser holds; the site never sees them.
import { useEffect, useState } from "react";
import { decryptPhoto } from "vault-core";
import { headersOf, inviteFor } from "@/lib/invites";

export default function PhotoGallery({ auctionId, count, sealed, title }: { auctionId: string; count: number; sealed: boolean; title: string }) {
  const [urls, setUrls] = useState<(string | null)[]>(() => Array.from({ length: count }, (_, i) => (sealed ? null : `/api/auctions/${auctionId}/photos/${i}`)));
  const [shown, setShown] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!sealed || count === 0) return;
    let live = true;
    const made: string[] = [];
    void (async () => {
      const invite = await inviteFor(auctionId);
      if (!invite) return setFailed(true);
      const headers = await headersOf(invite);
      const out: (string | null)[] = [];
      for (let i = 0; i < count; i++) {
        try {
          const res = await fetch(`/api/auctions/${auctionId}/photos/${i}`, { headers, cache: "no-store" });
          if (!res.ok) throw new Error("not found");
          const jpeg = await decryptPhoto(invite, i, new Uint8Array(await res.arrayBuffer()));
          const url = URL.createObjectURL(new Blob([jpeg as BlobPart], { type: "image/jpeg" }));
          made.push(url);
          out.push(url);
        } catch {
          out.push(null);
          if (live) setFailed(true);
        }
      }
      if (live) setUrls(out);
    })();
    return () => {
      live = false;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [auctionId, count, sealed]);

  if (count === 0) return null;
  const main = urls[shown];
  return (
    <section className="gallery" id="gallery" aria-label="Photos">
      <div className="gallery-main">
        {main ? (
          // eslint-disable-next-line @next/next/no-img-element -- photos come from this site's own route, or are opened in the browser
          <img src={main} alt={`${title}: photo ${shown + 1} of ${count}`} id="gallery-main" />
        ) : (
          <span className="gallery-wait">{failed ? "This photo can't be opened in this browser." : sealed ? "Opening The Photo…" : ""}</span>
        )}
      </div>
      {count > 1 && (
        <div className="gallery-thumbs">
          {urls.map((u, i) => (
            <button type="button" key={i} className={i === shown ? "on" : undefined} onClick={() => setShown(i)} aria-label={`Show photo ${i + 1}`}>
              {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
              {u ? <img src={u} alt="" /> : <span />}
            </button>
          ))}
        </div>
      )}
      <p className="gallery-note" id="gallery-note">
        {sealed
          ? "These photos were encrypted in the seller's browser and opened in yours. The site stores them but can't see them. They were cleaned first: no location, device or time is left in them."
          : "These photos were cleaned in the seller's browser before they were sent: no location, GPS, device or time is left in them."}
      </p>
    </section>
  );
}
