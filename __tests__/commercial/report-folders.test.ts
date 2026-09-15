import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  REPORTS,
  REPORT_KEYS,
  NON_REPORT_DIRS,
  isReportKey,
  reportKeyFromPath,
} from "@/lib/commercial/reports/registry";
import {
  resolveVisibleReports,
  computeReportAccess,
  roleAllowsExport,
  pickActiveView,
  showAllView,
  diffFolderReports,
  moveInOrder,
  folderReports,
  ALL_REPORTS_VIEW,
  type AccessRows,
} from "@/lib/commercial/reports/access-rule";

/**
 * Report folders (Katie 2026-09-15). Pure logic only — the rule, the registry
 * against the real app directory, and the migration's seed against the
 * registry. What this CANNOT see: whether a page actually calls the gate, the
 * rendered index, or the live tables. Those need the dev server + DB.
 */

const REPORTS_DIR = "app/commercial/reports";
const ALEX = "11111111-1111-4111-8111-111111111111";
const MARY = "22222222-2222-4222-8222-222222222222";
const KELVI = "33333333-3333-4333-8333-333333333333";

const MANAGER = "aaaaaaaa-0000-4000-8000-000000000001";
const FINANCE = "aaaaaaaa-0000-4000-8000-000000000002";
const FIELD = "aaaaaaaa-0000-4000-8000-000000000003";
const MARY_PERSONAL = "bbbbbbbb-0000-4000-8000-000000000001";

function rows(): AccessRows {
  return {
    folders: [
      { id: MANAGER, owner_user_id: null, deleted_at: null },
      { id: FINANCE, owner_user_id: null, deleted_at: null },
      { id: FIELD, owner_user_id: null, deleted_at: null },
      { id: MARY_PERSONAL, owner_user_id: MARY, deleted_at: null },
    ],
    items: [
      ...REPORT_KEYS.map((k) => ({ folder_id: MANAGER, report_key: k })),
      { folder_id: FINANCE, report_key: "receivables" },
      { folder_id: FINANCE, report_key: "ar-aging" },
      { folder_id: FINANCE, report_key: "labor" },
      { folder_id: FIELD, report_key: "pipeline" },
      { folder_id: FIELD, report_key: "change-orders" },
      { folder_id: FIELD, report_key: "estimator" },
      { folder_id: MARY_PERSONAL, report_key: "win-loss" },
    ],
    memberships: [
      { folder_id: FINANCE, user_id: MARY, removed_at: null },
      { folder_id: FIELD, user_id: KELVI, removed_at: null },
    ],
  };
}

describe("registry ↔ app/commercial/reports", () => {
  const dirs = readdirSync(REPORTS_DIR).filter(
    (d) => statSync(join(REPORTS_DIR, d)).isDirectory() && existsSync(join(REPORTS_DIR, d, "page.tsx"))
  );

  it("every report page has a registry entry", () => {
    const missing = dirs.filter((d) => !NON_REPORT_DIRS.includes(d) && !isReportKey(d));
    expect(missing, `Add these to lib/commercial/reports/registry.ts, or they get no tab, no card, and no folder access`).toEqual([]);
  });

  it("every registry entry has a page, at the href it claims", () => {
    for (const r of REPORTS) {
      expect(existsSync(join(REPORTS_DIR, r.key, "page.tsx")), `${r.key} has no page`).toBe(true);
      expect(r.href).toBe(`/commercial/reports/${r.key}`);
      expect(reportKeyFromPath(r.href)).toBe(r.key);
    }
  });

  it("the scan actually found the report directories", () => {
    // A scan of zero directories would pass both tests above.
    expect(dirs.length).toBeGreaterThanOrEqual(REPORTS.length);
  });

  it("REPORT_KEYS and REPORTS list the same keys, once each", () => {
    expect(REPORTS.map((r) => r.key)).toEqual([...REPORT_KEYS]);
    expect(new Set(REPORT_KEYS).size).toBe(REPORT_KEYS.length);
  });

  it("the revenue redirect stub is not a report", () => {
    expect(isReportKey("revenue")).toBe(false);
    expect(reportKeyFromPath("/commercial/reports")).toBeNull();
  });
});

describe("the access rule", () => {
  it("an admin sees every report, with no folder rows at all", () => {
    const v = resolveVisibleReports({ userId: ALEX, role: "admin" }, { folders: [], items: [], memberships: [] });
    expect(v).toEqual([...REPORT_KEYS]);
  });

  it("a member sees exactly their folder's reports", () => {
    const v = resolveVisibleReports({ userId: MARY, role: "account_manager" }, rows());
    expect(new Set(v)).toEqual(new Set(["receivables", "ar-aging", "labor"]));
  });

  it("membership in several folders is the union", () => {
    const r = rows();
    r.memberships.push({ folder_id: FIELD, user_id: MARY, removed_at: null });
    const v = resolveVisibleReports({ userId: MARY, role: "account_manager" }, r);
    expect(new Set(v)).toEqual(new Set(["receivables", "ar-aging", "labor", "pipeline", "change-orders", "estimator"]));
  });

  it("someone in no folder sees nothing", () => {
    expect(resolveVisibleReports({ userId: ALEX, role: "rep" }, rows())).toEqual([]);
  });

  it("a removed membership grants nothing", () => {
    const r = rows();
    r.memberships = [{ folder_id: FINANCE, user_id: MARY, removed_at: "2026-09-15T12:00:00Z" }];
    expect(resolveVisibleReports({ userId: MARY, role: "account_manager" }, r)).toEqual([]);
  });

  it("a deleted folder grants nothing", () => {
    const r = rows();
    r.folders = r.folders.map((f) => (f.id === FINANCE ? { ...f, deleted_at: "2026-09-15T12:00:00Z" } : f));
    expect(resolveVisibleReports({ userId: MARY, role: "account_manager" }, r)).toEqual([]);
  });

  it("a personal folder never grants — even with a membership row pointing at it", () => {
    const r = rows();
    r.memberships.push({ folder_id: MARY_PERSONAL, user_id: KELVI, removed_at: null });
    r.memberships.push({ folder_id: MARY_PERSONAL, user_id: MARY, removed_at: null });
    const kelvi = resolveVisibleReports({ userId: KELVI, role: "rep" }, r);
    const mary = resolveVisibleReports({ userId: MARY, role: "account_manager" }, r);
    expect(kelvi).not.toContain("win-loss");
    expect(mary).not.toContain("win-loss");
  });

  it("someone else's membership is not yours", () => {
    expect(resolveVisibleReports({ userId: ALEX, role: "rep" }, rows())).toEqual([]);
  });

  it("role gates still apply inside a folder: a rep in Field Users does not get the estimator report", () => {
    const v = resolveVisibleReports({ userId: KELVI, role: "rep" }, rows());
    expect(new Set(v)).toEqual(new Set(["pipeline", "change-orders"]));
    const asManager = resolveVisibleReports({ userId: KELVI, role: "account_manager" }, rows());
    expect(asManager).toContain("estimator");
  });

  it("a retired report key in a folder grants nothing", () => {
    const r = rows();
    r.items.push({ folder_id: FIELD, report_key: "revenue" });
    expect(resolveVisibleReports({ userId: KELVI, role: "rep" }, r)).not.toContain("revenue" as never);
  });

  it("labor's export stays admin / account manager even when the page is shared", () => {
    const labor = REPORTS.find((r) => r.key === "labor")!;
    expect(roleAllowsExport(labor, "rep")).toBe(false);
    expect(roleAllowsExport(labor, "account_manager")).toBe(true);
    const pipeline = REPORTS.find((r) => r.key === "pipeline")!;
    expect(roleAllowsExport(pipeline, "rep")).toBe(true);
  });
});

describe("failing closed", () => {
  it("a lookup error shows a non-admin nothing, and says so", async () => {
    const res = await computeReportAccess({ userId: MARY, role: "account_manager" }, async () => {
      throw new Error("PGRST205: could not find the table");
    });
    expect(res).toEqual({ visible: [], lookupFailed: true });
  });

  it("an admin never needs the lookup, so an outage can't lock them out", async () => {
    let called = false;
    const res = await computeReportAccess({ userId: ALEX, role: "admin" }, async () => {
      called = true;
      throw new Error("down");
    });
    expect(called).toBe(false);
    expect(res.visible).toEqual([...REPORT_KEYS]);
    expect(res.lookupFailed).toBe(false);
  });

  it("a successful lookup resolves through the same rule", async () => {
    const res = await computeReportAccess({ userId: MARY, role: "account_manager" }, async () => rows());
    expect(res.lookupFailed).toBe(false);
    expect(new Set(res.visible)).toEqual(new Set(["receivables", "ar-aging", "labor"]));
  });
});

describe("which folder opens", () => {
  const ids = [FINANCE, FIELD, MARY_PERSONAL];
  it("an explicit ?folder= wins", () => {
    expect(pickActiveView({ requested: FIELD, remembered: FINANCE, folderIds: ids, showAll: true })).toBe(FIELD);
  });
  it("then the remembered folder", () => {
    expect(pickActiveView({ requested: null, remembered: FINANCE, folderIds: ids, showAll: true })).toBe(FINANCE);
  });
  it("a remembered folder the viewer lost falls through to the default", () => {
    expect(pickActiveView({ requested: null, remembered: MANAGER, folderIds: ids, showAll: false })).toBe(FINANCE);
    expect(pickActiveView({ requested: "junk", remembered: null, folderIds: ids, showAll: true })).toBe(ALL_REPORTS_VIEW);
  });
  it("'all' is only honoured when the viewer gets that view", () => {
    expect(pickActiveView({ requested: ALL_REPORTS_VIEW, remembered: null, folderIds: ids, showAll: false })).toBe(FINANCE);
    expect(showAllView(true, 0)).toBe(true);
    expect(showAllView(false, 1)).toBe(false);
    expect(showAllView(false, 2)).toBe(true);
  });
  it("no folders and no all view → nothing to open", () => {
    expect(pickActiveView({ requested: null, remembered: null, folderIds: [], showAll: false })).toBeNull();
  });
});

describe("ordering helpers", () => {
  it("a checklist keeps existing order and appends new reports in registry order", () => {
    const d = diffFolderReports(["ar-aging", "pipeline", "gone"], ["pipeline", "ar-aging", "cash-flow", "geography"]);
    expect(d.order).toEqual(["ar-aging", "pipeline", "geography", "cash-flow"]);
    expect(d.add).toEqual(["geography", "cash-flow"]);
    expect(d.remove).toEqual(["gone"]);
  });
  it("moves swap neighbours and refuse to fall off either end", () => {
    expect(moveInOrder(["a", "b", "c"], "b", "up")).toEqual(["b", "a", "c"]);
    expect(moveInOrder(["a", "b", "c"], "a", "up")).toBeNull();
    expect(moveInOrder(["a", "b", "c"], "c", "down")).toBeNull();
  });
  it("a folder's cards are in folder order and limited to what the viewer can see", () => {
    const items = [
      { folder_id: FIELD, report_key: "change-orders", sort_order: 10 },
      { folder_id: FIELD, report_key: "estimator", sort_order: 20 },
      { folder_id: FIELD, report_key: "pipeline", sort_order: 30 },
    ];
    expect(folderReports(FIELD, items, new Set(["pipeline", "change-orders"] as const))).toEqual(["change-orders", "pipeline"]);
  });
});

describe("the migration seed", () => {
  const sql = readFileSync("supabase/migrations/20260915190000_commercial_report_folders.sql", "utf8").replace(/--[^\n]*/g, "");
  const seeds = [...sql.matchAll(/'(Manager|Finance|Field Users)'[\s\S]*?array\[([^\]]*)\]/g)].map((m) => ({
    name: m[1],
    keys: [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]),
  }));

  it("parses all three folders (a zero-folder parse would pass the rest)", () => {
    expect(seeds.map((s) => s.name)).toEqual(["Manager", "Finance", "Field Users"]);
    for (const s of seeds) expect(s.keys.length).toBeGreaterThan(0);
  });

  it("seeds only real report keys", () => {
    for (const s of seeds) expect(s.keys.filter((k) => !isReportKey(k)), s.name).toEqual([]);
  });

  it("Manager starts with every report", () => {
    expect(new Set(seeds.find((s) => s.name === "Manager")!.keys)).toEqual(new Set(REPORT_KEYS));
  });
});
