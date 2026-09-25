/**
 * How big an upload this platform can actually accept.
 *
 * NOT server-only on purpose: the client-side picker has to enforce the same
 * number, and the previous arrangement — a server constant plus a hand-copied
 * `CLIENT_MAX_UPLOAD_BYTES` "keep in sync" mirror — is how the two drifted.
 *
 * Stephanie, 2026-09-23: "I am still having issues uploading large files. I am
 * creating an opportunity and the bid set as well as all the other bidding
 * documents are over 50MB and it wont let me add them."
 *
 * What she was hitting was not a cap that was merely too low. The Documents /
 * Files tab was BUILT for bid sets and advertises "up to 100 MB"; its bucket is
 * configured for 100 MB; the app validated at 100 MB — and Supabase rejected
 * anything over 50 MB, because a project-wide storage limit sits underneath all
 * of that and overrides it. Measured 2026-09-23 with real uploads: 45 MB lands,
 * 60 MB comes back "The object exceeded the maximum allowed size", in the very
 * bucket that claims 100. The error the user saw then said "the file is larger
 * than the 100 MB limit" — about a 60 MB file. Three layers each holding a
 * different number, and the one that wins is the one nothing in the codebase
 * mentions.
 *
 * Karan raised the project limit to 1 GB on 2026-09-23 (Storage → Settings →
 * Global file size limit), and the three buckets people upload into were moved
 * to 500 MB to match this number.
 *
 * This sits DELIBERATELY BELOW the platform's 1 GB. The gap is not waste: it
 * means an oversized file is refused by us, with a message that says how big it
 * is and what to do, instead of by Supabase with "The object exceeded the
 * maximum allowed size" after the bytes have already gone up the wire. Raising
 * this above the project ceiling would recreate exactly the bug it was written
 * for, so `npm run check:upload-limit` measures the ceiling and fails if this
 * number ever exceeds it.
 */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/** The same number as a human would say it — for labels and error copy. */
export const MAX_UPLOAD_LABEL = `${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`;

/**
 * Files at or above this size cannot go through a multipart API route: Vercel
 * caps serverless request bodies at ~4.5 MB. Above it we upload DIRECTLY to
 * Supabase Storage via a signed URL (R6b). Set well under 4.5 MB for headroom —
 * the multipart boundary and form fields add overhead.
 */
export const DIRECT_UPLOAD_THRESHOLD = 4 * 1024 * 1024;

/** "that file is 61.4 MB — too big" said the same way everywhere. */
export function tooLargeMessage(sizeBytes: number, where = "here"): string {
  return `That file is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB. The most this platform can accept ${where} is ${MAX_UPLOAD_LABEL} — it is a limit on our storage, not on the page you are using, so a different tab will not take it either. Send it to Karan and he can raise the ceiling or store it another way.`;
}
