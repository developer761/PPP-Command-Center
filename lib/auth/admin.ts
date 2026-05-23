/**
 * Admin-list utilities. Reads `PPP_ADMIN_EMAILS` from env, falls back to a
 * bootstrap list so the platform can't accidentally lock everyone out if
 * the env var is missing.
 *
 * The bootstrap list is the LAST RESORT only; production should always set
 * the env var so admin changes don't require code redeploys.
 */

// PPP uses both `.net` and `.com` inconsistently per user — we list both
// variants for everyone so whichever someone signs in with works. Source of
// truth is the `PPP_ADMIN_EMAILS` env var in Vercel; this is the fallback.
const BOOTSTRAP_ADMIN_EMAILS = [
  "malhotrak038@gmail.com",                       // Karan (contractor)
  // PPP-owned dev identity (Google Workspace)
  "developer@precisionpaintingplus.net",
  "developer@precisionpaintingplus.com",
  // Alex Z (CEO)
  "alex@precisionpaintingplus.com",
  "alex@precisionpaintingplus.net",
  // Kate Sutton (AI ops / Hatch audit)
  "k.sutton@precisionpaintingplus.net",
  "k.sutton@precisionpaintingplus.com",
  // Katie Batilla (admin / IT / Salesforce org owner)
  "katie@precisionpaintingplus.com",
  "katie@precisionpaintingplus.net",
  "katie.batilla@precisionpaintingplus.com",
  "katie.batilla@precisionpaintingplus.net",
  "kbatilla@precisionpaintingplus.com",
  "kbatilla@precisionpaintingplus.net",
];

/** Normalize an email for comparison: lowercase + trim. */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").toLowerCase().trim();
}

/** Parse the env var to a list of normalized admin emails. */
function getAdminList(): string[] {
  const raw = process.env.PPP_ADMIN_EMAILS;
  if (!raw || !raw.trim()) {
    // Env var unset — fall back to bootstrap. Log a warning so this is visible.
    if (typeof process !== "undefined" && process.env.NODE_ENV !== "test") {
      console.warn("[auth] PPP_ADMIN_EMAILS env var not set — using bootstrap admin list");
    }
    return BOOTSTRAP_ADMIN_EMAILS.map(normalizeEmail);
  }
  return raw
    .split(",")
    .map((e) => normalizeEmail(e))
    .filter((e) => e.length > 0); // filter() with Boolean keeps "   " — explicit length check is safer
}

/** True if the email is in the admin allow-list. */
export function isAdminEmail(email: string | null | undefined): boolean {
  const target = normalizeEmail(email);
  if (!target) return false;
  return getAdminList().includes(target);
}

/**
 * PPP-domain check — accepts both .net and .com workspaces, plus any email in
 * the admin allow-list (catches Karan's gmail).
 */
export function isAllowedToSignIn(email: string | null | undefined): boolean {
  const e = normalizeEmail(email);
  if (!e) return false;
  if (e.endsWith("@precisionpaintingplus.net")) return true;
  if (e.endsWith("@precisionpaintingplus.com")) return true;
  if (isAdminEmail(e)) return true;
  return false;
}

/**
 * Generate the cross-domain variant of a PPP email for fallback lookups.
 * `kate@ppp.net` → `kate@ppp.com` and vice versa. Returns null if the email
 * isn't a PPP domain (so we don't try silly transformations on gmail).
 */
export function crossDomainEmailVariant(email: string): string | null {
  const e = normalizeEmail(email);
  if (e.endsWith("@precisionpaintingplus.net")) {
    return e.replace("@precisionpaintingplus.net", "@precisionpaintingplus.com");
  }
  if (e.endsWith("@precisionpaintingplus.com")) {
    return e.replace("@precisionpaintingplus.com", "@precisionpaintingplus.net");
  }
  return null;
}
