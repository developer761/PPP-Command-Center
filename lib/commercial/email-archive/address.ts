import "server-only";

import { createHmac, timingSafeEqual } from "crypto";

/**
 * BCC archive address scheme + HMAC verification.
 *
 * Address shape (built by buildArchiveAddress):
 *
 *   <local>+archive-<kind>-<shortId>-<hmac6>@<archive-domain>
 *
 *   - <local> = COMMERCIAL_ARCHIVE_LOCAL or "orders" (defaults to the
 *     existing PPP inbound local-part so Stage 2 ships without DNS work)
 *   - <kind> = "opp" | "acc"
 *   - <shortId> = first 8 chars of the source UUID (uuid v4 → 8 chars
 *     gives ~10^9 collision space, plenty for a single tenant)
 *   - <hmac6> = first 10 chars of HMAC-SHA256("kind|shortId|fullSourceId",
 *     COMMERCIAL_ARCHIVE_HMAC_SECRET).digest("hex")
 *   - <archive-domain> = COMMERCIAL_ARCHIVE_DOMAIN env (defaults to
 *     "orders.precisionpaintingplus.net" so Stage 2 works on the existing
 *     inbound). Karan can flip to "archive.precisionpaintingplus.net"
 *     once DNS is ready.
 *
 * Why HMAC instead of UUID-only? Without it any GC who can guess an opp
 * UUID prefix (or who's been emailed by Alex and CAN see the suffix in
 * his BCC) could BCC `<local>+archive-opp-<otherShortId>@...` and inject
 * fake "internal" emails into a different opp's archive. The HMAC tie
 * makes the address unforgeable without the server secret.
 *
 * Why first 10 hex chars of the HMAC and not the full 64? Length: an
 * 8-char id + 64-char hmac = 73-char local-part, which some email
 * clients refuse to render. 10 hex chars = 40 bits of entropy ≈ 1 in
 * 1 trillion guess attempts for a known shortId — infeasible to brute-
 * force even without rate limiting. The 4 extra chars over the audit's
 * original 6-char design close the brute-force window completely.
 */

const DEFAULT_LOCAL = "orders";
const DEFAULT_DOMAIN = "orders.precisionpaintingplus.net";

export type ArchiveKind = "opp" | "acc";

function getSecret(): string | null {
  const s = process.env.COMMERCIAL_ARCHIVE_HMAC_SECRET?.trim();
  return s && s.length >= 16 ? s : null;
}

function getLocal(): string {
  return process.env.COMMERCIAL_ARCHIVE_LOCAL?.trim() || DEFAULT_LOCAL;
}

function getDomain(): string {
  return process.env.COMMERCIAL_ARCHIVE_DOMAIN?.trim() || DEFAULT_DOMAIN;
}

/** True when the archive feature is fully configured (HMAC secret set).
 *  UI uses this to gate the "Copy archive address" button — without the
 *  secret, generated addresses can't be verified on inbound, so we'd
 *  silently drop every archived email. Refuse to ship a broken address. */
export function isArchiveConfigured(): boolean {
  return getSecret() !== null;
}

function shortIdOf(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toLowerCase();
}

/** Truncation length (hex chars) for the HMAC tag. 10 = 40 bits of
 *  entropy — well above the audit-recommended floor. Changing this
 *  invalidates every previously-issued address; defaults to bump only
 *  on a fresh deployment. */
const HMAC_HEX_LEN = 10;

/** Build the BCC address for a given record. Returns null if the
 *  HMAC secret is unconfigured (caller should hide the copy button). */
export function buildArchiveAddress(
  kind: ArchiveKind,
  fullSourceId: string
): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const shortId = shortIdOf(fullSourceId);
  // Bind the HMAC to the FULL UUID, not just the shortId, so a collision
  // on the 8-char prefix between two opps still produces distinct hashes.
  const payload = `${kind}|${shortId}|${fullSourceId.toLowerCase()}`;
  const hmacN = createHmac("sha256", secret)
    .update(payload)
    .digest("hex")
    .slice(0, HMAC_HEX_LEN);
  return `${getLocal()}+archive-${kind}-${shortId}-${hmacN}@${getDomain()}`;
}

/**
 * Parse a recipient address — returns the kind + shortId if the address
 * matches the archive shape and the HMAC verifies, null otherwise. Uses
 * timing-safe HMAC compare so a malicious sender can't side-channel
 * which bytes of the hash they got right.
 *
 * Caller (inbound webhook) MUST also look up the full sourceId by
 * shortId before storing — the address itself doesn't carry the full
 * UUID. We need the lookup anyway to recompute the HMAC over the full
 * UUID for verification.
 */
export type ParsedArchiveAddress = {
  kind: ArchiveKind;
  shortId: string;
  /** The HMAC tag pulled from the address, ready for timing-safe
   *  comparison in verifyArchiveHmac. Saves a re-parse + keeps the
   *  parsing logic in one place. */
  providedHmac: string;
};

/** Strip RFC 5322 display-name wrappers + angle brackets + whitespace
 *  from a recipient header value so the parser only sees the bare
 *  address. Handles:
 *    "Alex Archive" <a@b>  →  a@b
 *    <a@b>                 →  a@b
 *    a@b                   →  a@b
 *  Always returns lowercase. */
export function extractEmail(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  const angle = trimmed.match(/<([^>]+)>/);
  return (angle?.[1] ?? trimmed).trim().toLowerCase();
}

export function parseArchiveRecipient(
  recipient: string
): ParsedArchiveAddress | null {
  if (!recipient) return null;
  const lower = extractEmail(recipient);
  const at = lower.indexOf("@");
  if (at <= 0) return null;
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (domain !== getDomain().toLowerCase()) return null;
  // Match "<local>+archive-<kind>-<shortId>-<hmacN>" where kind is opp|acc,
  // shortId is 8 hex chars, hmacN is HMAC_HEX_LEN hex chars. The local-part
  // prefix is configurable (defaults to "orders") so we use it as the gate.
  const expectedLocalPrefix = getLocal().toLowerCase();
  if (!local.startsWith(`${expectedLocalPrefix}+archive-`)) return null;
  const tail = local.slice(`${expectedLocalPrefix}+archive-`.length);
  // Build the regex from HMAC_HEX_LEN so the parser stays in sync if the
  // length is ever changed at the top of the file.
  const re = new RegExp(`^(opp|acc)-([0-9a-f]{8})-([0-9a-f]{${HMAC_HEX_LEN}})$`);
  const m = tail.match(re);
  if (!m) return null;
  return { kind: m[1] as ArchiveKind, shortId: m[2], providedHmac: m[3] };
}

/**
 * Verify the HMAC in the parsed address against the full source UUID
 * looked up by shortId. Returns true on match. Timing-safe compare.
 */
export function verifyArchiveHmac(
  recipient: string,
  fullSourceId: string
): boolean {
  const secret = getSecret();
  if (!secret) return false;
  const parsed = parseArchiveRecipient(recipient);
  if (!parsed) return false;
  if (shortIdOf(fullSourceId) !== parsed.shortId) return false;
  const payload = `${parsed.kind}|${parsed.shortId}|${fullSourceId.toLowerCase()}`;
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("hex")
    .slice(0, HMAC_HEX_LEN);
  // timingSafeEqual requires equal-length buffers. Both `expected` and
  // `parsed.providedHmac` are HMAC_HEX_LEN chars by construction.
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(parsed.providedHmac);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
