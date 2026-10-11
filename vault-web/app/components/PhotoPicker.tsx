"use client";

// Up to three photos for a listing, picked on the sell, sale and deal forms.
// Each is redrawn here before it is sent (lib/photoClient.ts), which removes
// the camera's hidden details; a private listing's are encrypted too.
import { useRef, useState } from "react";
import { PiImageBold, PiXBold } from "react-icons/pi";
import { MAX_PHOTOS } from "vault-core";
import { redrawPhoto, type PickedPhoto } from "@/lib/photoClient";

export default function PhotoPicker({
  photos,
  onChange,
  sealed,
}: {
  photos: PickedPhoto[];
  onChange: (next: PickedPhoto[]) => void;
  /** The listing is private: say the photos are encrypted. */
  sealed: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setProblem(null);
    const next = [...photos];
    try {
      for (const file of Array.from(files)) {
        if (next.length >= MAX_PHOTOS) {
          setProblem(`A listing can have ${MAX_PHOTOS} photos.`);
          break;
        }
        next.push(await redrawPhoto(file));
      }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      onChange(next);
      setBusy(false);
    }
  }

  function remove(i: number) {
    URL.revokeObjectURL(photos[i]!.url);
    onChange(photos.filter((_, k) => k !== i));
    setProblem(null);
  }

  return (
    <div className="photo-pick" id="photo-pick">
      <label style={{ marginBottom: 8 }}>Photos (Optional, Up To {MAX_PHOTOS})</label>
      <div className="photo-row">
        {photos.map((p, i) => (
          <figure className="photo-thumb" key={p.url}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of a photo not yet sent */}
            <img src={p.url} alt={`Photo ${i + 1}`} />
            <button type="button" className="photo-remove" aria-label={`Remove photo ${i + 1}`} onClick={() => remove(i)}>
              <PiXBold aria-hidden="true" />
            </button>
          </figure>
        ))}
        {photos.length < MAX_PHOTOS && (
          <button type="button" className="photo-add" id="photo-add" disabled={busy} onClick={() => input.current?.click()}>
            <PiImageBold aria-hidden="true" />
            <span>{busy ? "Cleaning…" : "Add A Photo"}</span>
          </button>
        )}
      </div>
      <input
        ref={input}
        id="photo-file"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = e.target.files;
          void add(files).finally(() => {
            e.target.value = "";
          });
        }}
      />
      <p className="hint" id="photo-hint">
        Each photo is redrawn in your browser before it is sent, which removes what phones hide in a photo: where it was taken, the phone, the time.
        {sealed ? " In a private listing the photos are encrypted too, so only people with the invite can see them." : ""} Check nothing in the
        picture itself shows where you live.
      </p>
      {problem && (
        <p className="error small" id="photo-problem">
          {problem}
        </p>
      )}
    </div>
  );
}
