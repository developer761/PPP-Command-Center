import "server-only";

import { commercialDb } from "./db";
import { EMPLOYEE_COLS, type CommercialEmployee } from "./field-ops/employees";

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
 * ── On a lookup error this fails CLOSED (restricted) ────────────────────────
 *
 * It used to return false — unrestricted — reasoning that a DB blip shouldn't
 * lock a foreman out of their job. That had it backwards. This one predicate is
 * the ONLY enforcement point for the whole crew boundary (the page gate, every
 * server action, and ~25 API routes), so failing open meant a transient error
 * on this table served a painter the entire book of business — accounts export,
 * AR aging, every invoice — silently, with nothing logged. That is exactly the
 * silent leak the allowlist above exists to prevent.
 *
 * The lock-out worry is handled directly instead: a platform admin is never
 * treated as crew-only, so the failure mode is a painter briefly seeing their
 * own crew home instead of a wider surface. A support call, not a leak.
 */
export async function isCrewOnlyUser(userId: string): Promise<boolean> {
  const restrictOnError = async (): Promise<boolean> => {
    // Don't strand an admin behind a transient error on the roles table.
    try {
      const { getProfileByUserId } = await import("@/lib/auth/profile");
      const profile = await getProfileByUserId(userId);
      if (profile?.is_admin) return false;
    } catch {
      /* fall through — deny */
    }
    return true;
  };
  try {
    const sb = commercialDb();
    const { data, error } = await sb
      .from("commercial_user_roles")
      .select("role")
      .eq("user_id", userId);
    if (error) return restrictOnError();
    const roles = ((data ?? []) as { role: string }[]).map((r) => r.role);
    if (roles.length === 0) return false;
    return roles.includes("crew") && roles.every((r) => r === "crew");
  } catch {
    return restrictOnError();
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
  // NOT select("*") — commercial_employees carries `clock_pin_hash` and
  // `magic_link_token`, and every scoped crew page calls this first. Passing
  // that row to a client component (or letting it into an RSC payload) would
  // ship the crew member's own PIN hash and a login-less auth token to the
  // browser; magic_link_token resolves an employee with no other check.
  const { data, error } = await sb
    .from("commercial_employees")
    .select(EMPLOYEE_COLS)
    .eq("user_id", userId)
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (error) {
    // Migration 125 not applied yet → the column doesn't exist. Resolve to
    // "not linked", which is the truth until it runs, and let the crew page's
    // empty state say so. Failing closed here is right: the alternative is an
    // error page, and there is no safe way to guess who this login is.
    console.warn("[crew-access] employee lookup failed:", error.message);
    return null;
  }
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

  if (employeeId) {
    // Refuse to take an employee another login already holds. Without this the
    // update just overwrites user_id: the previous login silently resolves to
    // null forever ("ask an admin to link you") with nothing logged against the
    // row that lost its link, and the admin sees success. A named error is the
    // whole point — a 23505 tells you something failed, not which of two
    // people the admin meant.
    const { data: target } = await sb
      .from("commercial_employees")
      .select("id, display_name, active, user_id")
      .eq("id", employeeId)
      .maybeSingle();
    const t = target as { display_name: string; active: boolean; user_id: string | null } | null;
    if (!t) return { ok: false, error: "That crew member no longer exists." };
    if (!t.active) return { ok: false, error: `${t.display_name} is inactive — reactivate them first.` };
    if (t.user_id && t.user_id !== userId) {
      return {
        ok: false,
        error: `${t.display_name} is already linked to another login. Unlink that one first.`,
      };
    }
  }

  // Release this login's previous employee so re-pointing it is never a
  // constraint error. Audited, so the row that LOST its link is traceable.
  const { data: prior } = await sb
    .from("commercial_employees")
    .select("id")
    .eq("user_id", userId)
    .neq("id", employeeId ?? "00000000-0000-0000-0000-000000000000");
  const { error: clearErr } = await sb
    .from("commercial_employees")
    .update({ user_id: null })
    .eq("user_id", userId);
  if (clearErr) return { ok: false, error: clearErr.message };
  for (const row of ((prior ?? []) as { id: string }[])) {
    await logUpdate("commercial_employees", row.id, { user_id: userId }, { user_id: null }, actorUserId).catch(() => undefined);
  }
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
