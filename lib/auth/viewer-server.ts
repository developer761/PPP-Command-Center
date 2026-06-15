import "server-only";

import { getProfileByUserId, logViewAs } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { getCurrentUser } from "@/lib/auth/session";
import type { Viewer, ViewerScope } from "@/lib/auth/viewer";

/**
 * Resolve the current viewer from the request context (cookies + URL params).
 *
 * The `searchParams` here are the dashboard layout's URL params:
 *   ?view_as=005xxxx — admin impersonates a specific rep
 *   ?scope=my|all    — admin toggles their own view
 *
 * Non-admin URL tampering is stripped here: a rep can put ?view_as=...
 * in the URL but this function ignores it.
 */
export async function resolveViewer(
  searchParams: Record<string, string | string[] | undefined>,
  requestMeta?: { path?: string; userAgent?: string; ipAddress?: string }
): Promise<Viewer | null> {
  // Per-request cached — same call inside the dashboard layout shares
  // this React-cache entry, so the JWT only verifies once per request.
  const user = await getCurrentUser();
  if (!user) return null;

  const profile = await getProfileByUserId(user.id);

  // First-login race condition: a user might hit a dashboard page before
  // /auth/callback finishes upserting their profile. Build a minimal viewer
  // from auth session so the page still renders (chrome doesn't 500).
  const email = user.email?.toLowerCase() ?? "";
  if (!profile) {
    return {
      supabaseUserId: user.id,
      email,
      displayName: email.split("@")[0] ?? "Signed in",
      sfUserId: null,
      sfUserName: null,
      isAdmin: false,
      viewAsUserId: null,
      viewAsName: null,
      scope: "my",
      effectiveUserId: null,
    };
  }

  // Belt-and-suspenders: even if the profile row somehow has is_admin=false
  // for a person on the env allow-list, trust the allow-list. Stops a stale
  // profile from locking an admin out of impersonation.
  const isAdmin = profile.is_admin || isAdminEmail(profile.email);

  // Parse URL params for view_as + scope. Single-value only.
  const viewAsRaw = pickFirst(searchParams.view_as);
  const scopeRaw = pickFirst(searchParams.scope);

  // Only honor view_as for admins. Validate format (SF User Ids start with 005).
  let viewAsUserId: string | null = null;
  if (isAdmin && viewAsRaw && /^005[A-Za-z0-9]{12,15}$/.test(viewAsRaw)) {
    viewAsUserId = viewAsRaw;
  }

  // Compute effective scope:
  //   non-admin → always "my"
  //   admin + view_as → "my" (scoped to impersonated rep)
  //   admin + ?scope=my → "my"
  //   admin (default) → "all"
  let scope: ViewerScope;
  if (!isAdmin) {
    scope = "my";
  } else if (viewAsUserId) {
    scope = "my";
  } else if (scopeRaw === "my") {
    scope = "my";
  } else {
    scope = "all";
  }

  const effectiveUserId =
    scope === "all"
      ? null
      : viewAsUserId ?? profile.sf_user_id ?? null;

  // Fire audit log when admin is actively impersonating. Best-effort —
  // doesn't block the page render. Deduped per (admin, target) for one hour
  // so that clicking through 20 pages while impersonating doesn't write 20
  // identical audit rows. Cache is in-process — fine for our scale; if we
  // ever go multi-instance we'll move it to Redis.
  if (viewAsUserId && isAdmin) {
    const seenKey = `${user.id}:${viewAsUserId}`;
    const now = Date.now();
    pruneAuditDedupe(now);
    const last = auditDedupe.get(seenKey) ?? 0;
    if (now - last > AUDIT_DEDUPE_WINDOW_MS) {
      auditDedupe.set(seenKey, now);
      void logViewAs({
        admin_user_id: user.id,
        admin_email: profile.email,
        target_sf_user_id: viewAsUserId,
        target_label: null, // backfilled from snapshot.reps in a follow-up
        path: requestMeta?.path ?? null,
        user_agent: requestMeta?.userAgent ?? null,
        ip_address: requestMeta?.ipAddress ?? null,
      });
    }
  }

  return {
    supabaseUserId: user.id,
    email: profile.email,
    displayName: profile.sf_user_name ?? profile.email.split("@")[0] ?? "Signed in",
    sfUserId: profile.sf_user_id,
    sfUserName: profile.sf_user_name,
    isAdmin,
    viewAsUserId,
    viewAsName: null, // resolved in client from snapshot.reps for live display
    scope,
    effectiveUserId,
  };
}

function pickFirst(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}

// In-memory audit log dedupe — admin × target → last-write timestamp.
// One hour window matches our policy: every distinct impersonation window
// produces at least one audit row, even if the admin stays on it longer.
// TTL eviction prevents the Map from growing unbounded over the lifetime of
// a Vercel function instance — without it, weeks of impersonation activity
// would slowly leak memory.
const auditDedupe = new Map<string, number>();
const AUDIT_DEDUPE_WINDOW_MS = 60 * 60 * 1000;

// Sweep entries older than 2x the window every time the map grows past 500.
// Cheap O(n) walk over a tiny map; runs only when needed.
function pruneAuditDedupe(now: number) {
  if (auditDedupe.size < 500) return;
  const cutoff = now - AUDIT_DEDUPE_WINDOW_MS * 2;
  for (const [key, ts] of auditDedupe) {
    if (ts < cutoff) auditDedupe.delete(key);
  }
}
