import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess, type Profile } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";

/**
 * The single commercial-access policy: does this profile LACK access right now?
 * Denied when it has no New-Platform flag, or when it's deactivated (admins
 * exempt — they can't lock themselves out). Route handlers use this to return a
 * JSON 403; server actions go through {@link assertCommercialAccess} which
 * redirects. Keeping the rule in one predicate means a deactivated tester can't
 * slip through one surface after being cut off on another.
 */
export function commercialAccessDenied(profile: Profile | null): boolean {
  if (!platformAccess(profile).hasNewPlatform) return true;
  if (profile && profile.is_active === false && !isAdminEmail(profile.email)) return true;
  return false;
}

/**
 * Same policy for API routes that fetch a PARTIAL profile row via the
 * service-role client (they only `select("has_new_platform_access, is_active")`,
 * not the full Profile). Narrows the raw row internally so a route reduces its
 * whole auth check to `if (rawAccessDenied(row)) return 403`. Denied when the
 * New-Platform flag is missing or the account is deactivated.
 *
 * INTENTIONAL asymmetry vs commercialAccessDenied: no admin-email exemption
 * here (the partial rows don't carry email). If an admin were ever deactivated
 * they'd be 403'd on these routes while the layout/server-actions still let
 * them in — that's fail-CLOSED (safer) and a non-scenario in practice (admins
 * deactivate others, not themselves). Kept deliberately simple over selecting
 * email in every route just to re-admit a deactivated admin.
 */
export function rawAccessDenied(row: unknown): boolean {
  const p = row as { has_new_platform_access?: boolean | null; is_active?: boolean | null } | null;
  return !p?.has_new_platform_access || p?.is_active === false;
}

/**
 * Commercial-platform authorization for SERVER ACTIONS (Karan 2026-07-27 audit).
 *
 * The /commercial layout gates page RENDERS on `has_new_platform_access`, but a
 * Next.js server action POSTs to the page path and executes even when the
 * render-time redirect would have fired — so the layout does NOT protect
 * mutations. Every commercial API route already re-checks the flag; the server
 * actions did not. These helpers close that gap.
 *
 * Cheap: `getProfileByUserId` is cached ~30s, so the extra read is effectively
 * free within a request cycle.
 */

/**
 * Redirect unless `userId` holds commercial-platform access. Call this inside
 * every commercial server action, right after the `if (!user) redirect(...)`
 * gate, passing the resolved `user.id`.
 */
export async function assertCommercialAccess(
  userId: string,
  opts?: { allowCrew?: boolean }
): Promise<void> {
  // DEFAULT-DENY for crew logins.
  //
  // The crew allowlist lives in the /commercial LAYOUT, which gates page
  // RENDERS. A Next server action POSTs to the page path and executes even when
  // that render-time redirect would have fired — the docblock above says so —
  // so the allowlist never protected a single mutation. 30+ files define
  // actions on this gate (accounts, opportunities, invoices, proposals,
  // submittals, AIA, costs, change-orders, closeout, settings), and a crew
  // session could POST any of them: action ids are build-global, so the path
  // it's sent to is irrelevant.
  //
  // Denying HERE closes the whole class at once. Crew-facing surfaces opt back
  // in with `{ allowCrew: true }` — a short, visible list, which is the right
  // shape for a security boundary: new code is protected by default, and the
  // exceptions have to be written down.
  if (!opts?.allowCrew) {
    const { isCrewOnlyUser, CREW_HOME } = await import("@/lib/commercial/crew-access");
    if (await isCrewOnlyUser(userId)) redirect(CREW_HOME);
  }
  const profile = await getProfileByUserId(userId);
  // The layout redirects a deactivated / no-access user on page RENDER, but a
  // server action POSTs to the path and runs even when that render-time redirect
  // would have fired — so without this, a revoked tester could still mutate
  // commercial data. Same predicate the API routes use (2026-08 security sweep).
  if (commercialAccessDenied(profile)) {
    redirect(platformAccess(profile).hasNewPlatform ? "/?error=access_revoked" : "/dashboard");
  }
}

/**
 * Full gate for actions that don't already have the user in scope: resolves the
 * session, requires commercial access, and returns the user id. Redirects
 * otherwise (no return).
 */
export async function requireCommercialUser(opts?: { allowCrew?: boolean }): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id, opts);
  return user.id;
}

/**
 * API-route gate that ALSO denies crew-only logins.
 *
 * The crew allowlist in lib/commercial/crew-access.ts is enforced in the
 * /commercial LAYOUT — which never runs for /api/* routes, and proxy.ts only
 * matches page paths. So a crew login could call the palette search, the
 * job-costs export, the AR-aging export, account-summary, document downloads
 * … and get full company financials by pasting a URL. That is exactly the
 * fail-open the allowlist design was written to prevent; the design was right
 * and the enforcement was incomplete (persona audit 2026-08).
 *
 * This is the choke point every commercial API route already funnels through,
 * so denying here closes the whole class at once rather than route by route.
 *
 * `allowCrew` opts a route back IN — only for endpoints a crew member must be
 * able to call (the PIN clock). Keep that list tiny and obvious.
 */
export async function apiAccessDenied(
  userId: string | null | undefined,
  row: unknown,
  opts?: { allowCrew?: boolean }
): Promise<boolean> {
  if (rawAccessDenied(row)) return true;
  if (opts?.allowCrew) return false;
  if (!userId) return true;
  const { isCrewOnlyUser } = await import("@/lib/commercial/crew-access");
  return await isCrewOnlyUser(userId);
}

/**
 * Deny a crew-only login on an API route. Returns a 403 Response to return, or
 * null to continue.
 *
 * A second entry point alongside apiAccessDenied because roughly two dozen
 * commercial API routes never funnelled through that helper — they hand-rolled
 * `has_new_platform_access && is_active`, which EVERY crew login satisfies by
 * definition (the layout requires it to let them in at all). So the crew
 * allowlist, which only governs page renders, left the whole /api tree open:
 * the accounts export (the entire book of business as CSV), the opportunities
 * export, AIA workbooks with contract sums, every document and attachment
 * download, and mutations like move-status.
 *
 * Two lines at the top of a handler, no restructuring of its existing gate:
 *
 *   const denied = await denyCrewApi(userId);
 *   if (denied) return denied;
 */
/**
 * Deny anyone who is not admin or account manager on a MONEY route.
 *
 * `apiAccessDenied` answers "may this login use the commercial platform at
 * all" — which every sales rep satisfies. It was never a finance gate, and
 * three routes that write money were reading it as one.
 *
 * Accounting's own server actions get this right and say why, at length:
 * "a rep replaying the action id could record payments, edit AR rows, and cost
 * and POST a whole payroll week onto every job — while being unable to approve
 * a single hour." Every one of those actions calls `requireFinanceViewer`.
 *
 * Then the slow Deposited button was replaced with a fast checkbox posting to
 * /api/commercial/payments/deposited, and the new route gated on commercial
 * access alone. The hole that comment describes was reopened by its own
 * performance fix — the write moved out of the guarded action and into an
 * unguarded route. A rep could tick and untick bank reconciliation on any
 * payment in the book, which is the one column Mary reads AGAINST the bank
 * statement: a wrong tick there does not look wrong, it looks reconciled.
 *
 * Two lines at the top of a handler, after its access check:
 *
 *   const denied = await financeApiDenied(user.email, profile);
 *   if (denied) return denied;
 *
 * Pass the same partial profile row the route already fetched; select `role`
 * and `is_admin` alongside the access columns (the env allowlist covers an
 * admin whose row has `is_admin` null, which is why email is a parameter).
 */
export async function financeApiDenied(
  email: string | null | undefined,
  row: unknown
): Promise<Response | null> {
  const { normalizeRole } = await import("@/lib/auth/roles");
  const p = row as { role?: string | null; is_admin?: boolean | null } | null;
  const role = normalizeRole(p?.role, p?.is_admin ?? isAdminEmail(email));
  if (role === "admin" || role === "account_manager") return null;
  return new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

export async function denyCrewApi(
  userId: string | null | undefined
): Promise<Response | null> {
  if (!userId) return null; // the route's own auth gate owns the anonymous case
  const { isCrewOnlyUser } = await import("@/lib/commercial/crew-access");
  if (await isCrewOnlyUser(userId)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}
