/**
 * Client-side receipt-photo shrinker (browser only).
 *
 * A phone photo is routinely 5–12 MB — over Vercel's ~4.5 MB multipart cap. So a
 * field crew member who snaps a receipt and saves the cost would 413 at the edge
 * and lose the whole entry (audit U1), which is the exact one-tap flow the field
 * walk asked for. Downscale the image to fit under the cap before it's
 * submitted, so the capture actually works instead of silently failing.
 *
 * Returns the original file unchanged when it's already small enough OR can't be
 * decoded (HEIC/HEIF isn't canvas-decodable in most browsers) — the caller then
 * applies a plain size guard for the un-shrinkable case, so nothing is ever
 * submitted over the cap.
 */
export async function shrinkImageUnder(file: File, maxBytes: number): Promise<File> {
  if (typeof document === "undefined") return file;
  if (!file.type.startsWith("image/") || file.size <= maxBytes) return file;

  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    return file; // undecodable (e.g. HEIC) — caller guards
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;

  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (!w || !h) return file;

  // Step the dimensions down until the re-encoded JPEG fits. ~0.8 linear per
  // pass ≈ 36% area, so eight passes covers even a huge original.
  for (let attempt = 0; attempt < 8; attempt++) {
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.82));
    if (!blob) return file;
    if (blob.size <= maxBytes) {
      const name = file.name.replace(/\.[a-z0-9]+$/i, "") + ".jpg";
      return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
    }
    w *= 0.8;
    h *= 0.8;
  }
  return file; // still too big after eight passes (extraordinary) — caller guards
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode_failed"));
    };
    img.src = url;
  });
}
