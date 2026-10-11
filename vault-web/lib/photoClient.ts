// Listing photos, in the browser. Every photo is redrawn on a canvas and saved
// again as a JPEG before it leaves the page: what a camera or phone writes
// into a file (where it was taken, the device, the time) does not survive the
// redraw. It is also turned the right way up and made smaller.
import { cleanJpeg, PHOTO_MAX_BYTES, PHOTO_MAX_EDGE } from "vault-core";

export interface PickedPhoto {
  bytes: Uint8Array;
  /** An object URL of the redrawn photo, for the preview. */
  url: string;
}

async function decode(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
  try {
    // Turned by the camera's orientation tag, so it is the right way up.
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("could not save the photo"))), "image/jpeg", quality));
}

/** Redraws a photo the seller picked. Throws a plain message if it can't be read. */
export async function redrawPhoto(file: File): Promise<PickedPhoto> {
  if (file.size > 40_000_000) throw new Error("That photo is too large to read. Pick one under 40 MB.");
  let image: CanvasImageSource & { width: number; height: number };
  try {
    image = await decode(file);
  } catch {
    throw new Error("This browser can't read that photo. Use a JPEG, PNG or WebP photo.");
  }
  let edge = PHOTO_MAX_EDGE;
  for (let attempt = 0; attempt < 8; attempt++) {
    const scale = Math.min(1, edge / Math.max(image.width, image.height));
    const w = Math.max(1, Math.round(image.width * scale));
    const h = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't redraw photos.");
    ctx.fillStyle = "#ffffff"; // a transparent PNG gets a white background, as a JPEG has none
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0, w, h);
    const quality = attempt < 3 ? 0.86 - attempt * 0.1 : 0.66;
    const blob = await toJpeg(canvas, quality);
    if (blob.size <= PHOTO_MAX_BYTES) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!cleanJpeg(bytes)) throw new Error("That photo could not be cleaned. Try another one.");
      return { bytes, url: URL.createObjectURL(blob) };
    }
    if (attempt >= 2) edge = Math.round(edge * 0.8);
  }
  throw new Error("That photo could not be made small enough. Try another one.");
}
