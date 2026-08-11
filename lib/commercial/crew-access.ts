import "server-only";

import { commercialDb } from "./db";
import type { CommercialEmployee } from "./field-ops/employees";

/**
 * Crew role — a scoped, self-service login for the people doing the work.
 *
 * Karan 2026-08: a crew member logs in and sees ONLY their own work orders,
 * schedule, hours and clock — nothing else. The team is trusted, so the PIN
 * kiosk opens to them too rather than staying admin-only.
 *
 * ── Why this is an ALLOWLIST, not a set of query filters ────────────────────
 *
 * The Commercial platform has been binary until now: if you have access, you
 * see everything. Retro-fitting "except crew" into a few hundred queries is
 * how permission systems fail OPEN — you scope the surfaces you thought of,
 * and the one you forgot silently serves a crew member the company P&L. There
 * is no error, nothing in a log, and nobody finds out.
 *
 * So the gate is inverted: a crew login can reach ONLY the paths named below,
 * and everything else redirects. A route added tomorrow is denied by default.
 * The failure mode becomes "a crew member can't reach something they should" —
 * visible, reported in minutes, and a one-line fix — instead of a silent leak.
 *
 * Scoping WITHIN the allowed pages is a second layer, not the first one. The
 * field-ops surfaces here are already per-employee by construction (a crew
 * member's schedule/hours are keyed to their employee record).
 */

/** Exact paths, or prefixes, a crew-only login may reach under /commercial.
 *
 *  The field-ops schedule/calendar/hours pages are NOT here: they're the
 *  company-wide ADMIN pages (every employee, every job, all hours) and they
 *  self-gate to admins anyway — so allowlisting them produced three tiles that
 *  bounced the crew member straight back with no message. Crew get their own
 *  scoped /commercial/crew/* versions instead.
 *
 *  `/commercial/crew` covers every child by segment-boundary match. */
const CREW_ALLOWED_PREFIXES: readonly string[] = [
  // Landing + all scoped crew views (schedule, hours, jobs, clock).
  "/commercial/crew",
  // The shared shop tablet — PIN-gated, deliberately not under /crew.
  "/commercial/field-ops/clock-station",
];

/**
 * Where a crew login lands, and where it's bounced back to. Must itself be
 * inside CREW_ALLOWED_PREFIXES or a denied request would redirect-loop.
 */
export const CREW_HOME = "/commercial/crew";

export function isCrewAllowedPath(pathname: string): boolean {
  // Strip the query/hash a caller might have passed in, then match on a
  // segment boundary so "/commercial/crewfoo" can't ride in on "/commercial/crew".
  const path = pathname.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/";
  return CREW_ALLOWED_PREFIXES.some(
    (p) => path === p || path.startsWith(`${p}/`)
  );
}

/**
 * Is this user CREW-ONLY — i.e. holds the crew role and nothing that would
 * grant wider access?
 *
 * Deliberately conservative in BOTH directions:
 *   - An admin who also happens to carry the crew role is NOT crew-only (an
 *     admin locked out of their own platform is a support call).
 *   - Any role other than crew also lifts the restriction, so adding someone
 *     to a second role can't accidentally trap them.
 *
 * On a lookup error it returns false (unrestricted). That's the safe direction
 * here only because a crew login cannot exist without an explicit crew role
 * being granted first — a DB blip must not lock a foreman out of their job.
 */
export async function isCrewOnlyUser(userId: string): Promise<boolean> {
  try {
    const sb = commercialDb();
    const { data, error } = await sb
      .from("commercial_user_roles")
      .select("role")
      .eq("user_id", userId);
    if (error) return false;
    const roles = ((data ?? []) as { role: string }[]).map((r) => r.role);
    if (roles.length === 0) return false;
    return roles.includes("crew") && roles.every((r) => r === "crew");
  } catch {
    return false;
  }
}

/** Grant/revoke the crew role. Admin-only at the callsite. */
export async function setCrewRole(
  userId: string,
  isCrew: boolean,
  actorUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { logInsert, logDelete } = await import("@/lib/commercial/audit-log");
  if (isCrew) {
    const { error } = await sb
      .from("commercial_user_roles")
      .upsert({ user_id: userId, role: "crew" }, { onConflict: "user_id,role" });
    if (error) return { ok: false, error: error.message };
    await logInsert("commercial_user_roles", userId, { user_id: userId, role: "crew" }, actorUserId).catch(() => undefined);
  } else {
    const { error } = await sb
      .from("commercial_user_roles")
      .delete()
      .eq("user_id", userId)
      .eq("role", "crew");
    if (error) return { ok: false, error: error.message };
    await logDelete("commercial_user_roles", userId, { user_id: userId, role: "crew" }, actorUserId).catch(() => undefined);
  }
  return { ok: true };
}

// ── Login → employee resolution ────────────────────────────────────────────

/**
 * The employee record a login IS, or null.
 *
 * THE single choke-point every scoped crew view calls first. Resolution is by
 * the explicit `user_id` link ONLY (migration 125) — deliberately never by
 * email. An employee email is nullable, can differ from the login address, and
 * two rows can carry the same one; matching on it would silently attach one
 * person's hours, schedule and jobs to another, which is the exact class of
 * leak this whole role exists to prevent. Email may pre-select the admin's
 * picker (a convenience); it must never resolve identity.
 *
 * Returns null for a crew login whose employee hasn't been picked yet. That's a
 * real state between "granted crew" and "linked", so callers render the
 * "ask an admin to link you" empty state — never a crash, never a redirect
 * (which would loop against the layout gate).
 */
export async function getEmployeeForUser(
  userId: string | null | undefined
): Promise<CommercialEmployee | null> {
  if (!userId) return null;
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_employees")
    .select("*")
    .eq("user_id", userId)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  return (data as CommercialEmployee | null) ?? null;
}

/**
 * Point a login at an employee (or clear it with null).
 *
 * Clears any OTHER employee currently holding this user_id first: the partial
 * unique index would otherwise 23505, and the spec is explicit that this is
 * handled here rather than by catching the error — a caught 23505 tells you
 * something failed, not which of two employees the admin meant.
 */
export async function linkEmployeeToUser(
  userId: string,
  employeeId: string | null,
  actorUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { logUpdate } = await import("@/lib/commercial/audit-log");
  // Release the previous holder so re-pointing a login is never a constraint
  // error the admin has to decipher.
  const { error: clearErr } = await sb
    .from("commercial_employees")
    .update({ user_id: null })
    .eq("user_id", userId);
  if (clearErr) return { ok: false, error: clearErr.message };
  if (!employeeId) return { ok: true };
  const { error } = await sb
    .from("commercial_employees")
    .update({ user_id: userId })
    .eq("id", employeeId);
  if (error) return { ok: false, error: error.message };
  await logUpdate(
    "commercial_employees",
    employeeId,
    { user_id: null },
    { user_id: userId },
    actorUserId
  ).catch(() => undefined);
  return { ok: true };
}
