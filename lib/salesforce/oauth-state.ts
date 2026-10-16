import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The OAuth `state` for the PRODUCTION Salesforce sign-in.
 *
 * Without it the callback stored whatever `?code=` reached it, so a link that
 * walked a signed-in admin's browser through someone else's Salesforce consent
 * would bind the org-wide integration (snapshot reads AND Tomco write-backs) to
 * that account. The login route mints a nonce into an httpOnly cookie and into
 * `state`; the callback stores nothing unless the two agree.
 *
 * The prefix keeps it apart from the payments sandbox's "payments-sandbox."
 * state, which the same callback URL routes elsewhere.
 */
export const PROD_STATE_PREFIX = "production.";
export const PROD_STATE_COOKIE = "ppp_sf_prod_state";

export function mintOAuthNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** One cookie's value out of a raw Cookie header, or null. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * True only when `state` is `<prefix><nonce>` and the nonce equals the cookie.
 * Compared in constant time; a missing cookie, a missing state, or a state
 * with another prefix is a mismatch.
 */
export function oauthStateMatches(
  state: string | null | undefined,
  prefix: string,
  cookieNonce: string | null | undefined,
): boolean {
  if (!state || !cookieNonce || !state.startsWith(prefix)) return false;
  const a = Buffer.from(state.slice(prefix.length));
  const b = Buffer.from(cookieNonce);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
