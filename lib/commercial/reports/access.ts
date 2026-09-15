import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { normalizeRole, type UserRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";
import { computeReportAccess, roleAllowsExport, effectiveReportRole } from "./access-rule";
import { listViewerFolders, loadAccessRows } from "./folders-db";
import { reportDef, type ReportKey } from "./registry";

/**
 * THE server entry point for "may this person see this report?".
 *
 * Every surface a report is reachable from asks here: each report page (and
 * its server actions — a layout never guards those), every export route (via
 * guardExport), the Reports index, the tab bar, and links elsewhere in the app.
 * The rule itself is lib/commercial/reports/access-rule.ts.
 */

export type ReportAccess = {
  userId: string;
  role: UserRole;
  isAdmin: boolean;
  visible: ReadonlySet<ReportKey>;
  /** Registry-ordered list of the same set. */
  visibleList: readonly ReportKey[];
  /** The folder lookup failed and access was DENIED rather than guessed. */
  lookupFailed: boolean;
};

async function resolve(userId: string, email: string | null | undefined): Promise<ReportAccess> {
  const profile = await getProfileByUserId(userId);
  const flaggedAdmin = profile?.is_admin === true || isAdminEmail(email ?? profile?.email);
  // `normalizeRole` lets the role STRING win over the admin flag, and at least
  // one real account is is_admin=true with role='rep' (Karan's own commercial
  // login). Folders are about who sees which report, so "admins see every
  // report" has to follow the flag too — otherwise the person who administers
  // the platform opens Reports and finds it empty.
  const role = effectiveReportRole({ role: normalizeRole(profile?.role, false), isAdminFlag: flaggedAdmin });
  const res = await computeReportAccess({ userId, role }, () => loadAccessRows(userId));
  return {
    userId,
    role,
    isAdmin: role === "admin",
    visible: new Set(res.visible),
    visibleList: res.visible,
    lookupFailed: res.lookupFailed,
  };
}

/** Memoised per request, so a page + its layout + its cards share one lookup. */
export const getReportAccess = cache(resolve);

/** The viewer's folder list, memoised per request (layout tabs + index rail). */
export const getViewerFolders = cache((userId: string, isAdmin: boolean) => listViewerFolders(userId, isAdmin));

/** For callers that already hold the user. */
export async function canViewReport(userId: string, email: string | null | undefined, key: ReportKey): Promise<boolean> {
  return (await getReportAccess(userId, email)).visible.has(key);
}

/** Folder access AND the export's own role gate (labor's pay columns). */
export async function canExportReport(userId: string, email: string | null | undefined, key: ReportKey): Promise<boolean> {
  const access = await getReportAccess(userId, email);
  return access.visible.has(key) && roleAllowsExport(reportDef(key), access.role);
}

/**
 * Page / server-action gate. Redirects to the Reports index — which explains
 * what happened and who to ask — when the viewer can't see this report.
 * Call it AFTER the existing Commercial-access check.
 */
export async function requireReportAccess(userId: string, email: string | null | undefined, key: ReportKey): Promise<ReportAccess> {
  const access = await getReportAccess(userId, email);
  if (!access.visible.has(key)) redirect(`/commercial/reports?denied=${encodeURIComponent(key)}`);
  return access;
}

/** Full gate for a server action that has no user in scope yet. */
export async function requireReportActor(key: ReportKey): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const { assertCommercialAccess } = await import("@/lib/commercial/auth");
  await assertCommercialAccess(user.id);
  await requireReportAccess(user.id, user.email, key);
  return user.id;
}
