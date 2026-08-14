/**
 * Client-side upload guard for surfaces that still POST a file as multipart
 * through a Vercel route (invoice attachments, change-order attachments, lien
 * waivers). A file over Vercel's ~4.5 MB serverless request-body cap 413s at the
 * EDGE, before the route runs — so the attach silently fails with a confusing
 * error and no clear next step (audit U1). Reject it in the browser instead,
 * with a message that points at the direct-to-Storage path.
 *
 * Surfaces that upload direct-to-Storage (documents, opportunity + submittal
 * attachments via sign→PUT→finalize) are NOT bound by this cap and must NOT use
 * this guard — they genuinely support up to 50 MB.
 *
 * Browser-safe: no server-only imports.
 */
export const SAFE_MULTIPART_BYTES = 4 * 1024 * 1024;

/** A user-facing reason string when `file` is too large to post multipart, or
 *  null when it's within the cap. `where` completes "too large to attach …". */
export function multipartOversizeError(file: File, where = "here"): string | null {
  if (file.size <= SAFE_MULTIPART_BYTES) return null;
  return `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB — too large to attach ${where} (4 MB limit). Upload it from the opportunity's Documents / Files tab instead (up to 50 MB).`;
}
