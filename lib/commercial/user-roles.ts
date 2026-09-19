import "server-only";

import { commercialDb } from "./db";

/**
 * The one read of `commercial_user_roles`, cached.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `assertCommercialAccess` runs at the top of every commercial server action
 * and every page render — 66 files gate through it. It did two lookups back to
 * back: the profile, which has had a 30-second cache since the 2026-06-14 speed
 * pass, and the crew role, which had none. So every button in the platform paid
 * an uncached round trip to this table before it did any work, measured at 78ms
 * median / 139ms at the tail from a laptop.
 *
 * `lib/commercial/rbac.ts` then issued the SAME query again for the same user
 * in the same render, so a page that asked both questions paid it twice.
 *
 * ── Why caching this is safe, and where the line is ────────────────────────
 *
 * The cached value decides a security boundary, so the direction of staleness
 * is the whole argument:
 *
 *   · Stale "crew"     → someone briefly MORE restricted than they should be.
 *                        Harmless; they see their own crew home for <30s.
 *   · Stale "not crew" → someone briefly LESS restricted. This is the one that
 *                        matters, and it is closed by invalidating at the write
 *                        path: `setCrewRole` is the ONLY place the application
 *                        writes this table (verified by grep across app/, lib/
 *                        and scripts/), so a grant or revoke takes effect on the
 *                        very next request rather than up to 30s later.
 *
 * A role changed by hand in the SQL editor is not seen for up to 30 seconds.
 * That is the identical trade already accepted for `profiles.is_admin`, which
 * is a strictly LARGER privilege than the crew role this gates.
 *
 * ── A failed read is never cached ──────────────────────────────────────────
 *
 * Returning null means "could not tell", and callers fold that to restricted.
 * Caching it would freeze one transient blip into 30 seconds of every gate in
 * the platform answering "unknown" — turning a single dropped packet into a
 * platform-wide outage, which is far worse than the query it was meant to
 * save. So the entry is dropped as soon as it resolves null, and the next
 * caller retries.
 *
 * The cache is per-instance and in-memory; a serverless instance that never
 * warms simply behaves as it did before. It is a latency optimisation, never a
 * correctness dependency.
 */

type Entry = { promise: Promise<string[] | null>; expiresAt: number };

const cache = new Map<string, Entry>();
const TTL_MS = 30_000;

/** Drop a user's cached roles. Called by every write to the table. */
export function invalidateRolesCache(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

/**
 * Every role row for a user, or `null` when the table could not be read.
 *
 * `null` is deliberately distinct from `[]`: no rows is a real answer ("this
 * person has no roles"), an unreadable table is not, and collapsing the two is
 * what made a blip on this table indistinguishable from a deliberate state
 * elsewhere in the notification stack.
 */
export async function readUserRoles(userId: string): Promise<string[] | null> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > now) return hit.promise;

  const promise = (async (): Promise<string[] | null> => {
    try {
      const sb = commercialDb();
      const { data, error } = await sb
        .from("commercial_user_roles")
        .select("role")
        .eq("user_id", userId);
      if (error) {
        console.warn("[commercial/user-roles] read failed:", error.message);
        return null;
      }
      return ((data ?? []) as { role: string }[]).map((r) => r.role);
    } catch (err) {
      console.warn("[commercial/user-roles] read threw:", (err as Error)?.message);
      return null;
    }
  })();

  cache.set(userId, { promise, expiresAt: now + TTL_MS });
  // Never let a failure stick — see the docblock. Compare against the entry we
  // just set so a concurrent invalidate + refill isn't clobbered.
  void promise
    .then((roles) => {
      if (roles === null && cache.get(userId)?.promise === promise) cache.delete(userId);
    })
    .catch(() => {
      if (cache.get(userId)?.promise === promise) cache.delete(userId);
    });

  return promise;
}
