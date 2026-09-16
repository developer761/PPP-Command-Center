import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  JOB_GROUPS,
  JOB_SORTS,
  defaultDirFor,
  filterJobRows,
  gcOptions,
  jobAddressLine,
  jobDate,
  jobStatusGroup,
  matchesJobSearch,
  resolveGroupFilter,
  resolveSort,
  sortJobRows,
  spendByCategory,
  spendByVendor,
  spendTotal,
  summarizeJobRows,
  withinPeriod,
  type JobGroup,
  type JobsReportRow,
} from "@/lib/commercial/reports/jobs-rows";
import { OPPORTUNITY_STATUSES, SUB_STATUSES_BY_STATUS } from "@/lib/commercial/opportunities/constants";
import { REPORTS, isReportKey, reportKeyFromPath } from "@/lib/commercial/reports/registry";

/**
 * The Jobs report — the arithmetic behind "every job, and these jobs combined".
 *
 * Everything asserted here is a pure transformation, which is the only kind of
 * thing this suite can see (vitest.config.ts: no DB, no browser). What it
 * CANNOT see is stated at the bottom of this file, so nobody reads a green run
 * as "the report is right".
 */

function row(over: Partial<JobsReportRow> = {}): JobsReportRow {
  return {
    oppId: over.oppId ?? "opp-1",
    accountId: "acct-1",
    accountName: "Tomco",
    jobName: "Job",
    projectNumber: null,
    dealNumber: null,
    address: null,
    status: "in_progress",
    subStatus: "wip_on_site",
    group: "delivery",
    jobYmd: "2026-05-10",
    jobYmdIsDecided: true,
    contractCents: 0,
    hasContract: false,
    billedCents: 0,
    collectedCents: 0,
    openBalanceCents: 0,
    retainageHeldCents: 0,
    costCents: 0,
    marginCents: 0,
    marginPct: null,
    marginProvisional: false,
    laborHours: 0,
    unratedHours: 0,
    invoiceCount: 0,
    pendingCoCount: 0,
    ...over,
  };
}

// ─── Status grouping ────────────────────────────────────────────────────────

describe("jobStatusGroup", () => {
  it("puts every real (status, sub-status) pair in exactly one of the four buckets", () => {
    const seen = new Set<JobGroup>();
    for (const status of OPPORTUNITY_STATUSES) {
      const subs = (SUB_STATUSES_BY_STATUS as Record<string, readonly string[]>)[status] ?? [null];
      for (const sub of subs) {
        const g = jobStatusGroup({ status, sub_status: sub });
        expect(JOB_GROUPS.map((x) => x.key), `${status}/${sub} produced ${g}`).toContain(g);
        seen.add(g);
      }
    }
    // A partition nothing reaches is not a partition — every bucket must be
    // reachable from a real status, or a filter pill would be permanently empty.
    expect([...seen].sort()).toEqual(["closed", "delivery", "lost", "open"]);
  });

  it("calls a won-but-not-started job 'in delivery' — it is under contract", () => {
    expect(jobStatusGroup({ status: "pre_sale_closed", sub_status: "won" })).toBe("delivery");
  });

  it("separates lost from closed — a bid we didn't get is not a finished job", () => {
    expect(jobStatusGroup({ status: "pre_sale_closed", sub_status: "lost" })).toBe("lost");
    expect(jobStatusGroup({ status: "post_sale_closed", sub_status: "closed" })).toBe("closed");
    // Close-out paperwork still outstanding is still a finished job.
    expect(jobStatusGroup({ status: "post_sale_closed", sub_status: "closeout" })).toBe("closed");
  });

  it("treats a live pursuit as open", () => {
    for (const s of ["qualifying", "estimating", "proposal"]) {
      expect(jobStatusGroup({ status: s, sub_status: null })).toBe("open");
    }
  });

  it("falls back to open rather than throwing on an unknown status", () => {
    expect(jobStatusGroup({ status: "something_new", sub_status: null })).toBe("open");
    expect(jobStatusGroup({ status: null, sub_status: null })).toBe("open");
  });

  it("resolveGroupFilter only accepts the four buckets", () => {
    expect(resolveGroupFilter("delivery")).toBe("delivery");
    expect(resolveGroupFilter(["lost"])).toBe("lost");
    expect(resolveGroupFilter("nonsense")).toBe("all");
    expect(resolveGroupFilter(undefined)).toBe("all");
  });
});

// ─── Search ─────────────────────────────────────────────────────────────────

describe("matchesJobSearch", () => {
  const r = row({
    jobName: "Altman Plaza — Roof deck",
    accountName: "Tomco Painting",
    projectNumber: "2026-0114",
    dealNumber: "ALT-0125",
    address: "42 Front St, Hempstead, NY 11550",
  });

  it("matches on job, GC, project number, deal number and address", () => {
    for (const q of ["altman", "tomco", "2026-0114", "alt-0125", "hempstead", "11550"]) {
      expect(matchesJobSearch(r, q), q).toBe(true);
    }
  });

  it("requires every token but not that they be adjacent", () => {
    expect(matchesJobSearch(r, "altman roof")).toBe(true);
    expect(matchesJobSearch(r, "roof altman")).toBe(true);
    expect(matchesJobSearch(r, "altman warehouse")).toBe(false);
  });

  it("does not match across a field boundary", () => {
    // "deck tomco" as two tokens is fine; as one adjacent string it must not be,
    // or the fields are silently concatenated into one searchable blob.
    expect(matchesJobSearch(r, "deck tomco")).toBe(true);
    expect(matchesJobSearch(r, "deck tomco painting plaza")).toBe(true);
    expect(matchesJobSearch(r, "deckTomco")).toBe(false);
  });

  it("an empty or whitespace query matches everything", () => {
    expect(matchesJobSearch(r, "")).toBe(true);
    expect(matchesJobSearch(r, "   ")).toBe(true);
  });

  it("ignores null fields instead of matching the word 'null'", () => {
    expect(matchesJobSearch(row({ projectNumber: null, address: null }), "null")).toBe(false);
  });
});

// ─── Period ─────────────────────────────────────────────────────────────────

describe("withinPeriod", () => {
  it("is inclusive at both ends", () => {
    expect(withinPeriod("2026-01-01", "2026-01-01", "2026-01-31")).toBe(true);
    expect(withinPeriod("2026-01-31", "2026-01-01", "2026-01-31")).toBe(true);
    expect(withinPeriod("2025-12-31", "2026-01-01", "2026-01-31")).toBe(false);
    expect(withinPeriod("2026-02-01", "2026-01-01", "2026-01-31")).toBe(false);
  });

  it("keeps everything, dateless rows included, when there is no window", () => {
    expect(withinPeriod(null, null, null)).toBe(true);
    expect(withinPeriod("2020-01-01", undefined, undefined)).toBe(true);
  });

  it("drops a dateless row once a window exists — it must not appear in every period", () => {
    expect(withinPeriod(null, "2026-01-01", "2026-01-31")).toBe(false);
  });
});

// ─── Filtering ──────────────────────────────────────────────────────────────

describe("filterJobRows", () => {
  const rows = [
    row({ oppId: "a", jobName: "Altman", group: "delivery", accountId: "gc1", accountName: "Tomco", jobYmd: "2026-05-10" }),
    row({ oppId: "b", jobName: "Bergen", group: "open", accountId: "gc2", accountName: "Verdi", jobYmd: "2026-01-04" }),
    row({ oppId: "c", jobName: "Carlyle", group: "lost", accountId: "gc1", accountName: "Tomco", jobYmd: "2026-05-30" }),
    row({ oppId: "d", jobName: "Dover", group: "closed", accountId: "gc3", accountName: "Ward", jobYmd: null }),
  ];

  it("no filters returns everything, including the dateless job", () => {
    expect(filterJobRows(rows, {}).map((r) => r.oppId)).toEqual(["a", "b", "c", "d"]);
  });

  it("filters by group", () => {
    expect(filterJobRows(rows, { group: "delivery" }).map((r) => r.oppId)).toEqual(["a"]);
    expect(filterJobRows(rows, { group: "all" }).length).toBe(4);
  });

  it("filters by GC, and 'all' is not treated as an account id", () => {
    expect(filterJobRows(rows, { gc: "gc1" }).map((r) => r.oppId)).toEqual(["a", "c"]);
    expect(filterJobRows(rows, { gc: "all" }).length).toBe(4);
  });

  it("combines every filter with AND", () => {
    const out = filterJobRows(rows, { gc: "gc1", fromYmd: "2026-05-01", toYmd: "2026-05-15", q: "alt" });
    expect(out.map((r) => r.oppId)).toEqual(["a"]);
  });

  it("a period excludes the job with no date", () => {
    expect(filterJobRows(rows, { fromYmd: "2020-01-01", toYmd: "2030-01-01" }).map((r) => r.oppId)).toEqual(["a", "b", "c"]);
  });
});

// ─── Sorting ────────────────────────────────────────────────────────────────

describe("sortJobRows", () => {
  it("sorts money descending by default direction and ascending when asked", () => {
    const rows = [row({ oppId: "a", contractCents: 100 }), row({ oppId: "b", contractCents: 900 }), row({ oppId: "c", contractCents: 500 })];
    expect(sortJobRows(rows, "contract", "desc").map((r) => r.oppId)).toEqual(["b", "c", "a"]);
    expect(sortJobRows(rows, "contract", "asc").map((r) => r.oppId)).toEqual(["a", "c", "b"]);
  });

  it("sinks a missing value to the bottom in BOTH directions", () => {
    // A job with nothing billed has no margin. It must not sort between a loss
    // and a profit as though it broke even, and it must not fill the first
    // screen when you ask for the worst margins either.
    const rows = [
      row({ oppId: "loss", marginPct: -20 }),
      row({ oppId: "none", marginPct: null }),
      row({ oppId: "good", marginPct: 30 }),
    ];
    expect(sortJobRows(rows, "margin", "desc").map((r) => r.oppId)).toEqual(["good", "loss", "none"]);
    expect(sortJobRows(rows, "margin", "asc").map((r) => r.oppId)).toEqual(["loss", "good", "none"]);
  });

  it("sorts names case-insensitively and numerically", () => {
    const rows = [row({ oppId: "2", jobName: "Site 10" }), row({ oppId: "1", jobName: "site 2" }), row({ oppId: "3", jobName: "Site 1" })];
    expect(sortJobRows(rows, "job", "asc").map((r) => r.jobName)).toEqual(["Site 1", "site 2", "Site 10"]);
  });

  it("breaks ties on the job name so the order is the same on every refresh", () => {
    const rows = [row({ oppId: "x", jobName: "Zed", contractCents: 100 }), row({ oppId: "y", jobName: "Ada", contractCents: 100 })];
    expect(sortJobRows(rows, "contract", "desc").map((r) => r.jobName)).toEqual(["Ada", "Zed"]);
    expect(sortJobRows([...rows].reverse(), "contract", "desc").map((r) => r.jobName)).toEqual(["Ada", "Zed"]);
  });

  it("does not mutate the input", () => {
    const rows = [row({ oppId: "a", contractCents: 1 }), row({ oppId: "b", contractCents: 9 })];
    sortJobRows(rows, "contract", "desc");
    expect(rows.map((r) => r.oppId)).toEqual(["a", "b"]);
  });

  it("sorts by every advertised column without throwing", () => {
    const rows = [row({ oppId: "a", contractCents: 1, laborHours: 3 }), row({ oppId: "b", contractCents: 2, laborHours: 1 })];
    for (const s of JOB_SORTS) {
      expect(sortJobRows(rows, s.key, "desc")).toHaveLength(2);
      expect(sortJobRows(rows, s.key, "asc")).toHaveLength(2);
    }
  });
});

describe("resolveSort", () => {
  it("defaults to contract, biggest first", () => {
    expect(resolveSort(undefined, undefined)).toEqual({ key: "contract", dir: "desc" });
  });

  it("gives a text column its own natural direction", () => {
    expect(resolveSort("job", undefined)).toEqual({ key: "job", dir: "asc" });
    expect(resolveSort("gc", undefined).dir).toBe("asc");
    expect(resolveSort("billed", undefined).dir).toBe("desc");
  });

  it("honours an explicit direction, and rejects junk", () => {
    expect(resolveSort("job", "desc")).toEqual({ key: "job", dir: "desc" });
    expect(resolveSort("job", "sideways").dir).toBe("asc");
    expect(resolveSort("not-a-column", undefined).key).toBe("contract");
  });

  it("defaultDirFor agrees with resolveSort for every column", () => {
    for (const s of JOB_SORTS) {
      expect(defaultDirFor(s.key)).toBe(resolveSort(s.key, undefined).dir);
    }
  });
});

// ─── Totals ─────────────────────────────────────────────────────────────────

describe("summarizeJobRows", () => {
  it("adds up the money and counts distinct GCs", () => {
    const t = summarizeJobRows([
      row({ accountId: "gc1", contractCents: 100_000, hasContract: true, billedCents: 60_000, collectedCents: 40_000, openBalanceCents: 20_000, costCents: 30_000, retainageHeldCents: 5_000 }),
      row({ accountId: "gc1", contractCents: 50_000, hasContract: true, billedCents: 40_000, collectedCents: 40_000, openBalanceCents: 0, costCents: 25_000 }),
      row({ accountId: "gc2", contractCents: 0, hasContract: false, billedCents: 0, collectedCents: 0, openBalanceCents: 0, costCents: 0 }),
    ]);
    expect(t.jobCount).toBe(3);
    expect(t.gcCount).toBe(2);
    expect(t.withContract).toBe(2);
    expect(t.contractCents).toBe(150_000);
    expect(t.billedCents).toBe(100_000);
    expect(t.collectedCents).toBe(80_000);
    expect(t.openBalanceCents).toBe(20_000);
    expect(t.retainageHeldCents).toBe(5_000);
    expect(t.costCents).toBe(55_000);
  });

  it("computes margin on the SUMS, not as an average of each job's percentage", () => {
    // A $2k job at 50% and a $200k job at 5% average to 27.5% — a number that
    // describes no money anyone has. On the sums it is 5.4%.
    const t = summarizeJobRows([
      row({ billedCents: 200_000, costCents: 100_000, marginPct: 50 }),
      row({ billedCents: 20_000_000, costCents: 19_000_000, marginPct: 5 }),
    ]);
    expect(t.billedCents).toBe(20_200_000);
    expect(t.costCents).toBe(19_100_000);
    expect(t.marginCents).toBe(1_100_000);
    expect(t.marginPct).toBe(5);
    expect(t.marginPct).not.toBe(28);
  });

  it("refuses to state a margin percentage when nothing has been billed", () => {
    const t = summarizeJobRows([row({ billedCents: 0, costCents: 40_000 })]);
    expect(t.marginPct).toBeNull();
    expect(t.marginCents).toBe(-40_000);
    expect(t.marginCaveat).toBeTruthy();
  });

  it("does not present a costless job as a 100% margin without saying why", () => {
    const t = summarizeJobRows([row({ billedCents: 100_000, costCents: 0 })]);
    expect(t.marginPct).toBe(100);
    expect(t.marginCaveat).toMatch(/no costs/i);
    expect(t.marginLabel).toMatch(/projected/i);
  });

  it("counts each group and the counts add up to the job count", () => {
    const t = summarizeJobRows([
      row({ group: "open" }), row({ group: "open" }), row({ group: "delivery" }),
      row({ group: "closed" }), row({ group: "lost" }),
    ]);
    expect(t.byGroup).toEqual({ open: 2, delivery: 1, closed: 1, lost: 1 });
    expect(Object.values(t.byGroup).reduce((a, b) => a + b, 0)).toBe(t.jobCount);
  });

  it("keeps decimal hours from drifting", () => {
    const t = summarizeJobRows([row({ laborHours: 0.1 }), row({ laborHours: 0.2 })]);
    expect(t.laborHours).toBe(0.3);
  });

  it("an empty set totals to zero, with no margin claimed", () => {
    const t = summarizeJobRows([]);
    expect(t.jobCount).toBe(0);
    expect(t.contractCents).toBe(0);
    expect(t.marginPct).toBeNull();
    expect(t.byGroup).toEqual({ open: 0, delivery: 0, closed: 0, lost: 0 });
  });
});

// ─── GC picker ──────────────────────────────────────────────────────────────

describe("gcOptions", () => {
  it("lists each GC once, alphabetically, with its job count", () => {
    const opts = gcOptions([
      row({ accountId: "gc2", accountName: "Verdi" }),
      row({ accountId: "gc1", accountName: "Tomco" }),
      row({ accountId: "gc1", accountName: "Tomco" }),
    ]);
    expect(opts).toEqual([
      { id: "gc1", name: "Tomco", count: 2 },
      { id: "gc2", name: "Verdi", count: 1 },
    ]);
  });

  it("names an unnamed account rather than showing a blank row", () => {
    expect(gcOptions([row({ accountId: "gc9", accountName: "" })])[0].name).toBe("Unassigned account");
  });
});

// ─── Job identity ───────────────────────────────────────────────────────────

describe("jobAddressLine", () => {
  it("builds one line, skipping the parts that aren't set", () => {
    expect(jobAddressLine({ property_street: "42 Front St", property_city: "Hempstead", property_state: "NY", property_zip: "11550" }))
      .toBe("42 Front St, Hempstead, NY 11550");
    expect(jobAddressLine({ property_street: "42 Front St", property_city: null, property_state: null, property_zip: null }))
      .toBe("42 Front St");
    expect(jobAddressLine({ property_street: null, property_city: "Hempstead", property_state: "NY", property_zip: null }))
      .toBe("Hempstead, NY");
  });

  it("returns null — not an empty string or a lone comma — when there is no address", () => {
    expect(jobAddressLine({ property_street: null, property_city: null, property_state: null, property_zip: null })).toBeNull();
    expect(jobAddressLine({ property_street: "  ", property_city: "", property_state: null, property_zip: " " })).toBeNull();
  });
});

describe("jobDate", () => {
  it("prefers the day the job was decided", () => {
    expect(jobDate({ decided_at: "2026-05-10T14:00:00Z", created_at: "2026-01-02T00:00:00Z" }))
      .toEqual({ ymd: "2026-05-10", isDecided: true });
  });

  it("falls back to the created day, and says that is what it did", () => {
    expect(jobDate({ decided_at: null, created_at: "2026-01-02T00:00:00Z" }))
      .toEqual({ ymd: "2026-01-02", isDecided: false });
  });

  it("returns null rather than an empty string when there is no date at all", () => {
    expect(jobDate({ decided_at: null, created_at: "" })).toEqual({ ymd: null, isDecided: false });
  });
});

// ─── Cost roll-ups ──────────────────────────────────────────────────────────

describe("spendByCategory / spendByVendor", () => {
  const purchases = [
    { category: "materials", vendor: "Sherwin", amount_cents: 50_000 },
    { category: "materials", vendor: "Sherwin", amount_cents: 25_000 },
    { category: "equipment", vendor: "  ", amount_cents: 10_000 },
    { category: "labor", vendor: "Day Crew", amount_cents: 90_000 },
  ];

  it("groups by category, biggest first, with labels people recognise", () => {
    const out = spendByCategory(purchases);
    // Written out in the order the function must produce — biggest first — not
    // sorted by the test, which would assert nothing about the ordering.
    expect(out.map((c) => [c.key, c.cents, c.count])).toEqual([
      ["labor", 90_000, 1],
      ["materials", 75_000, 2],
      ["equipment", 10_000, 1],
    ]);
    // "labor" is shown as Subcontract labor — the crew's own hours are a
    // different pot and must not read as the same thing.
    expect(out.find((c) => c.key === "labor")?.label).toBe("Subcontract labor");
  });

  it("gathers vendor-less purchases under an honest label instead of dropping them", () => {
    const out = spendByVendor(purchases);
    expect(out.find((v) => v.vendor === "No vendor recorded")?.cents).toBe(10_000);
    expect(spendTotal(out)).toBe(175_000);
  });

  it("category and vendor roll-ups total to the same money", () => {
    expect(spendTotal(spendByCategory(purchases))).toBe(spendTotal(spendByVendor(purchases)));
  });

  it("an unknown category still appears, labelled Other rather than vanishing", () => {
    const out = spendByCategory([{ category: "wormholes", vendor: null, amount_cents: 700 }]);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Other");
    expect(spendTotal(out)).toBe(700);
  });
});

// ─── The routes exist where the registry says ───────────────────────────────

describe("the jobs report's routes", () => {
  const REPORTS_DIR = "app/commercial/reports";

  it("is in the registry at the href its pages live at", () => {
    const def = REPORTS.find((r) => r.key === "jobs");
    expect(def, "the jobs report is missing from the registry").toBeTruthy();
    expect(def!.href).toBe("/commercial/reports/jobs");
    expect(existsSync(join(REPORTS_DIR, "jobs", "page.tsx"))).toBe(true);
  });

  it("has a per-job page, and the tab bar still resolves it to the jobs report", () => {
    expect(existsSync(join(REPORTS_DIR, "jobs", "[oppId]", "page.tsx"))).toBe(true);
    // The tab bar keys off the FIRST path segment, so a drill-in keeps the tab
    // lit and the folder scoping intact.
    expect(reportKeyFromPath("/commercial/reports/jobs/2f1a0000-0000-4000-8000-000000000000")).toBe("jobs");
  });

  it("keeps the per-job page out of the registry's own directory scan", () => {
    // report-folders.test.ts scans only the direct children of the reports dir
    // and demands a registry entry for each. A nested [oppId] must therefore be
    // invisible to it — if this ever changes, that suite goes red for a
    // directory that is not a report.
    const topLevel = readdirSync(REPORTS_DIR).filter(
      (d) => statSync(join(REPORTS_DIR, d)).isDirectory() && existsSync(join(REPORTS_DIR, d, "page.tsx"))
    );
    expect(topLevel).toContain("jobs");
    expect(topLevel).not.toContain("[oppId]");
    expect(isReportKey("[oppId]")).toBe(false);
  });

  it("has both export routes, and they are the only way the CSVs are reachable", () => {
    expect(existsSync(join("app/api/commercial/reports/jobs/export", "route.ts"))).toBe(true);
    expect(existsSync(join("app/api/commercial/reports/jobs/[oppId]/export", "route.ts"))).toBe(true);
  });
});

/**
 * WHAT THIS FILE CANNOT SEE
 *
 * — Whether the pages actually call `requireReportAccess`, or the export routes
 *   `guardExport`. Nothing here renders a page or fetches a route.
 * — Whether the money a row carries is right: every cents figure comes from
 *   `listProjects` / `getProjectFinancials`, which need a database.
 * — Whether the per-job page agrees with the deal page. It does by construction
 *   (same two helpers, no second implementation), and that is an argument, not
 *   a measurement.
 * — Anything about layout, mobile width, or the print stylesheet.
 */
