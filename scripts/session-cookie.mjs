/**
 * The signed-in cookie a probe script sends, built the way the app reads it.
 *
 * Three scripts sign a throwaway user in and then fetch pages as that user:
 * smoke-pages, smoke-accounting-tabs and check-tour-targets. Each had its own
 * copy of this, hand-rolled as
 *
 *   `sb-${ref}-auth-token=base64-` + Buffer.from(json).toString("base64")
 *
 * which is three copies of a thing that has to agree exactly with a library.
 *
 * It is built with the library's OWN functions now — `stringToBase64URL` for
 * the payload, which is what `stringFromBase64URL` on the server side expects
 * (base64URL: no `+`, no `/`, no `=`), and `createChunks` for the 3180-byte
 * split a long session needs. One file, so a change in @supabase/ssr is one
 * place to follow rather than three to remember.
 *
 * Honest note, because the commit that created this file first claimed
 * otherwise: this was NOT why those scripts were failing on 2026-10-06. They
 * were pointed at another project's dev server on port 3000 — see
 * scripts/assert-this-app.mjs. The encoding was wrong on its own merits and is
 * now right; it had not yet broken anything.
 */
import { createChunks, stringToBase64URL } from "@supabase/ssr";

/**
 * @param {string} supabaseUrl  NEXT_PUBLIC_SUPABASE_URL
 * @param {object} session      the `session` from signInWithPassword
 * @returns {string}            a Cookie header value
 */
export function sessionCookie(supabaseUrl, session) {
  const ref = new URL(supabaseUrl).hostname.split(".")[0];
  const payload = JSON.stringify({
    access_token: session.access_token,
    token_type: "bearer",
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    refresh_token: session.refresh_token,
    user: session.user,
  });
  const name = `sb-${ref}-auth-token`;
  const value = "base64-" + stringToBase64URL(payload);
  // Chunked exactly as the browser would hold it, so a session that grows past
  // one cookie does not quietly start failing again.
  return createChunks(name, value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
