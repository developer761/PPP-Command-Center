/**
 * Report folders — the access RULE, as pure functions.
 *
 * Katie, 2026-09-15: "Report folders with ability to give access to certain
 * users to each folder. The reports live inside the folders."
 * Karan: "admins should see every report basically, but they should also have
 * their own folders and organized view."
 *
 * The rule, in full:
 *
 *   1. An admin sees every report.
 *   2. Anyone else sees exactly the reports inside SHARED folders they are an
 *      active member of (membership not removed, folder not deleted).
 *   3. A PERSONAL folder (owner_user_id set) never grants anything — it only
 *      organises reports its owner can already see. A membership row pointing
 *      at a personal folder is ignored.
 *   4. The existing role gates still apply on top: a report marked
 *      `requires: "people"` (estimator) is admin / account manager only even
 *      if it sits in a folder the viewer belongs to.
 *   5. If the lookup fails, the viewer sees NOTHING (fail closed) and the page
 *      says it couldn't check, rather than guessing.
 *
 * Kept free of I/O so the rule is tested directly (vitest is pure-logic here);
 * lib/commercial/reports/access.ts is the thin server wrapper that loads rows.
 */

import type { UserRole } from "@/lib/auth/roles";
import { REPORTS, isReportKey, type ReportDef, type ReportKey } from "./registry";

export type FolderRow = {
  id: string;
  owner_user_id: string | null;
  deleted_at: string | null;
};
export type FolderItemRow = { folder_id: string; report_key: string; sort_order?: number | null };
export type FolderMemberRow = { folder_id: string; user_id: string; removed_at: string | null };

export type AccessRows = {
  folders: FolderRow[];
  items: FolderItemRow[];
  memberships: FolderMemberRow[];
};

export type Viewer = { userId: string; role: UserRole };

/**
 * The role report access runs on.
 *
 * `normalizeRole` lets the role STRING beat the admin flag, and a real account
 * is is_admin=true with role='rep' (Karan's own commercial login). Since
 * "admins see every report" is the whole top of this rule, the flag has to win
 * here — otherwise the person who administers the platform opens Reports and
 * finds it empty.
 */
export function effectiveReportRole(input: {
  role: UserRole;
  isAdminFlag: boolean;
}): UserRole {
  return input.isAdminFlag ? "admin" : input.role;
}

/** Role gate that sits on top of folder access. */
export function roleAllowsReport(def: Pick<ReportDef, "requires">, role: UserRole): boolean {
  if (def.requires === "people") return role === "admin" || role === "account_manager";
  return true;
}

/** Can this role download the report's export? (labor's export carries pay.) */
export function roleAllowsExport(def: Pick<ReportDef, "requires" | "exportRequires">, role: UserRole): boolean {
  if (!roleAllowsReport(def, role)) return false;
  if (def.exportRequires === "people") return role === "admin" || role === "account_manager";
  return true;
}

/** Shared folders the viewer is an ACTIVE member of. */
export function memberFolderIds(viewer: Viewer, rows: Pick<AccessRows, "folders" | "memberships">): Set<string> {
  const liveShared = new Set(
    rows.folders.filter((f) => !f.deleted_at && f.owner_user_id === null).map((f) => f.id)
  );
  const out = new Set<string>();
  for (const m of rows.memberships) {
    if (m.user_id !== viewer.userId) continue;
    if (m.removed_at) continue;
    if (!liveShared.has(m.folder_id)) continue; // personal or deleted folders grant nothing
    out.add(m.folder_id);
  }
  return out;
}

/** The set of reports this viewer may open. Registry order is preserved. */
export function resolveVisibleReports(viewer: Viewer, rows: AccessRows): ReportKey[] {
  if (viewer.role === "admin") {
    return REPORTS.filter((r) => roleAllowsReport(r, viewer.role)).map((r) => r.key);
  }
  const folderIds = memberFolderIds(viewer, rows);
  const granted = new Set<ReportKey>();
  for (const it of rows.items) {
    if (!folderIds.has(it.folder_id)) continue;
    if (!isReportKey(it.report_key)) continue; // a retired key grants nothing
    granted.add(it.report_key);
  }
  return REPORTS.filter((r) => granted.has(r.key) && roleAllowsReport(r, viewer.role)).map((r) => r.key);
}

export type ReportAccessResult = {
  visible: ReportKey[];
  /** True when the rows could not be loaded — `visible` is then empty. */
  lookupFailed: boolean;
};

/**
 * Load + resolve, failing CLOSED. An admin never needs the rows (rule 1), so an
 * outage can't lock the people who'd fix it out of their own reports.
 */
export async function computeReportAccess(
  viewer: Viewer,
  load: () => Promise<AccessRows>
): Promise<ReportAccessResult> {
  if (viewer.role === "admin") {
    return { visible: resolveVisibleReports(viewer, { folders: [], items: [], memberships: [] }), lookupFailed: false };
  }
  try {
    const rows = await load();
    return { visible: resolveVisibleReports(viewer, rows), lookupFailed: false };
  } catch (err) {
    console.error("[reports/access] folder lookup failed — denying", err instanceof Error ? err.message : err);
    return { visible: [], lookupFailed: true };
  }
}

/** A folder's reports, in folder order, limited to what the viewer can see. */
export function folderReports(
  folderId: string,
  items: FolderItemRow[],
  visible: ReadonlySet<ReportKey>
): ReportKey[] {
  return items
    .filter((i) => i.folder_id === folderId && isReportKey(i.report_key) && visible.has(i.report_key))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((i) => i.report_key as ReportKey)
    .filter((k, idx, arr) => arr.indexOf(k) === idx);
}

// ─── Which folder is open ───────────────────────────────────────────────────

export const ALL_REPORTS_VIEW = "all";
export const FOLDER_COOKIE = "cc_report_folder";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pick the view to render: an explicit ?folder= wins, then the remembered
 * cookie, then the default. Anything that no longer resolves (a deleted
 * folder, one the viewer was removed from, junk) falls through rather than
 * rendering an empty page for a stale value.
 *
 * Default: admins open on "All reports". A non-admin in exactly one folder
 * opens on it; in several, on the union ("All my reports").
 */
export function pickActiveView(opts: {
  requested: string | null | undefined;
  remembered: string | null | undefined;
  folderIds: string[];
  showAll: boolean;
}): string | null {
  const ok = (v: string | null | undefined): v is string => {
    if (!v) return false;
    if (v === ALL_REPORTS_VIEW) return opts.showAll;
    return UUID_SHAPE.test(v) && opts.folderIds.includes(v);
  };
  if (ok(opts.requested)) return opts.requested;
  if (ok(opts.remembered)) return opts.remembered;
  if (opts.showAll) return ALL_REPORTS_VIEW;
  return opts.folderIds[0] ?? null;
}

/** Whether a viewer gets the "All reports" entry: admins always; others only
 *  when it would differ from a single folder. */
export function showAllView(isAdmin: boolean, sharedFolderCount: number): boolean {
  return isAdmin || sharedFolderCount >= 2;
}

// ─── Ordering helpers (pure, used by the DB layer) ──────────────────────────

/** Swap an id with its neighbour. Returns the new id order, or null for a no-op. */
export function moveInOrder<T extends string>(ids: T[], id: T, dir: "up" | "down"): T[] | null {
  const i = ids.indexOf(id);
  if (i === -1) return null;
  const j = dir === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return null;
  const next = ids.slice();
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * Diff a checklist against a folder's current items. Kept reports keep their
 * place; newly ticked ones append in registry order; unknown keys are dropped.
 */
export function diffFolderReports(current: string[], wanted: string[]): {
  add: ReportKey[];
  remove: string[];
  order: ReportKey[];
} {
  const want = new Set(wanted.filter(isReportKey));
  const kept = current.filter((k): k is ReportKey => isReportKey(k) && want.has(k));
  const add = REPORTS.map((r) => r.key).filter((k) => want.has(k) && !kept.includes(k));
  const remove = current.filter((k) => !isReportKey(k) || !want.has(k));
  return { add, remove, order: [...kept, ...add] };
}
