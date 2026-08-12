/**
 * Read a flash message out of a searchParam.
 *
 * Next.js has ALREADY decoded `searchParams` by the time a page sees them, so
 * calling `decodeURIComponent` on the value is a second decode. That is
 * harmless right up until the message contains a literal `%` — "50% over
 * budget", "100% complete", a percentage in any error text — at which point
 * `decodeURIComponent` throws `URIError: URI malformed` and takes the whole
 * page down. An error message crashing the page that was trying to show it is
 * a bad failure mode for the one screen someone is on because something
 * already went wrong.
 *
 * Kept as a decode-if-it-looks-encoded rather than dropping the call outright:
 * a few callers build these strings by hand and may still double-encode, and
 * showing `%20` in a banner is a cosmetic bug where crashing is not.
 */
export function flashMessage(raw: string | string[] | undefined | null): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  // No percent-escapes left to undo — Next already decoded it.
  if (!/%[0-9a-f]{2}/i.test(v)) return v;
  try {
    return decodeURIComponent(v);
  } catch {
    // Malformed escapes (a bare `%`) — show what we have rather than crash.
    return v;
  }
}
