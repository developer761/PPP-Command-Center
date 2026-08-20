import { describe, it, expect } from "vitest";
import { summarizeReceivables, type ReceivableRow } from "@/lib/commercial/reports/receivables";
import {
  parseReceivableQuery, filtersFor, receivableQueryString, describeReceivableQuery,
} from "@/lib/commercial/reports/receivables-filters";
import { activityRange, weekStartOf, ACTIVITY_PRESETS, laborRange, LABOR_PRESETS } from "@/lib/commercial/reports/presets";

function row(over: Partial<ReceivableRow> = {}): ReceivableRow {
  return {
    kind: "invoice", key: "invoice:1", sourceId: "1",
    accountId: "a1", accountName: "Big Builder", opportunityId: "o1",
    jobName: "Job A", openCents: 100_00, reference: "INV-1", note: null,
    issuedIso: "2026-08-10T16:00:00Z", daysOut: null,
    href: "/x", billingHref: "/y", ...over,
  };
}

describe("summarizeReceivables — filtering", () => {
  it("is a no-op with no filters, and says so", () => {
    const r = summarizeReceivables([row(), row({ key: "invoice:2" })]);
    expect(r.rows).toHaveLength(2);
    expect(r.filtered).toBe(false);
    expect(r.unfilteredCount).toBe(2);
  });

  it("totals the FILTERED set, so tiles can't contradict the list below them", () => {
    const rows = [
      row({ key: "invoice:1", accountId: "a1", openCents: 300_00 }),
      row({ key: "invoice:2", accountId: "a2", openCents: 700_00 }),
    ];
    const r = summarizeReceivables(rows, { accountId: "a2" });
    expect(r.rows).toHaveLength(1);
    expect(r.totalOpenCents).toBe(700_00);
    expect(r.unfilteredCount).toBe(2);
  });

  it("filters by kind", () => {
    const rows = [row(), row({ key: "aia:1", kind: "aia" }), row({ key: "ret:1", kind: "retainage" })];
    expect(summarizeReceivables(rows, { kind: "aia" }).rows).toHaveLength(1);
    expect(summarizeReceivables(rows, { kind: "retainage" }).rows[0].kind).toBe("retainage");
  });

  it("overdue-only drops retention, because retention is never late", () => {
    const rows = [
      row({ key: "invoice:1", daysOut: 12 }),
      row({ key: "invoice:2", daysOut: 0 }),
      row({ key: "ret:1", kind: "retainage", daysOut: null, openCents: 999_00 }),
    ];
    const r = summarizeReceivables(rows, { overdueOnly: true });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].daysOut).toBe(12);
    expect(r.retainageCents).toBe(0);
  });

  it("filters on the ET billing date, inclusive at both ends", () => {
    const rows = [
      row({ key: "a", issuedIso: "2026-07-31T20:00:00Z" }), // Jul 31 ET
      row({ key: "b", issuedIso: "2026-08-01T16:00:00Z" }), // Aug 1 ET
      row({ key: "c", issuedIso: "2026-08-31T16:00:00Z" }), // Aug 31 ET
      row({ key: "d", issuedIso: "2026-09-01T16:00:00Z" }), // Sep 1 ET
    ];
    const r = summarizeReceivables(rows, { fromYmd: "2026-08-01", toYmd: "2026-08-31" });
    expect(r.rows.map((x) => x.key).sort()).toEqual(["b", "c"]);
  });

  it("counts undated rows instead of losing them silently", () => {
    // The worst bug this page could have: money that vanishes when you pick a
    // date range, so nobody chases it again.
    const rows = [row({ key: "dated" }), row({ key: "undated", issuedIso: null })];
    const r = summarizeReceivables(rows, { fromYmd: "2026-08-01", toYmd: "2026-08-31" });
    expect(r.rows.map((x) => x.key)).toEqual(["dated"]);
    expect(r.undatedExcluded).toBe(1);
  });

  it("does not count undated rows when no period is applied", () => {
    const rows = [row({ key: "undated", issuedIso: null })];
    const r = summarizeReceivables(rows, { kind: "invoice" });
    expect(r.rows).toHaveLength(1);
    expect(r.undatedExcluded).toBe(0);
  });

  it("combines filters (AND, not OR)", () => {
    const rows = [
      row({ key: "a", kind: "aia", accountId: "a1", daysOut: 5 }),
      row({ key: "b", kind: "aia", accountId: "a2", daysOut: 5 }),
      row({ key: "c", kind: "invoice", accountId: "a1", daysOut: 5 }),
      row({ key: "d", kind: "aia", accountId: "a1", daysOut: 0 }),
    ];
    const r = summarizeReceivables(rows, { kind: "aia", accountId: "a1", overdueOnly: true });
    expect(r.rows.map((x) => x.key)).toEqual(["a"]);
  });

  it("offers GC options from the WHOLE book, not the filtered slice", () => {
    // Otherwise filtering to one GC removes every other name from the picker
    // and you can't switch away without clearing first.
    const rows = [
      row({ key: "a", accountId: "a1", accountName: "Zeta" }),
      row({ key: "b", accountId: "a2", accountName: "Alpha" }),
    ];
    const r = summarizeReceivables(rows, { accountId: "a1" });
    expect(r.gcOptions.map((g) => g.name)).toEqual(["Alpha", "Zeta"]);
  });
});

describe("query parsing", () => {
  const q = (o: Record<string, string>) => parseReceivableQuery((k) => o[k]);

  it("defaults to the whole book — a chase list must not hide old debt", () => {
    const parsed = q({});
    expect(parsed.period).toBe("all");
    expect(parsed.kind).toBe("all");
    expect(parsed.overdueOnly).toBe(false);
    expect(parsed.accountId).toBeNull();
    expect(filtersFor(parsed)).toEqual({
      fromYmd: undefined, toYmd: undefined, kind: undefined,
      overdueOnly: undefined, accountId: undefined,
    });
  });

  it("ignores unknown values rather than erroring or filtering to nothing", () => {
    const parsed = q({ period: "fortnight", kind: "banana", gc: "   " });
    expect(parsed.period).toBe("all");
    expect(parsed.kind).toBe("all");
    expect(parsed.accountId).toBeNull();
  });

  it("round-trips through the query string", () => {
    const parsed = q({ period: "this_month", kind: "aia", overdue: "1", gc: "abc" });
    const qs = receivableQueryString(parsed);
    const back = parseReceivableQuery((k) => new URLSearchParams(qs.slice(1)).get(k));
    expect(back).toEqual(parsed);
  });

  it("keeps a clean URL when nothing is filtered", () => {
    expect(receivableQueryString(q({}))).toBe("");
  });

  it("describes the active filter for the empty state and the CSV banner", () => {
    expect(describeReceivableQuery(q({}))).toBeNull();
    expect(describeReceivableQuery(q({ period: "this_month", overdue: "1" }))).toBe("this month · overdue only");
  });
});

describe("activity periods", () => {
  it("'all' is unbounded, not a sentinel date that clips history", () => {
    expect(activityRange("all")).toBeNull();
  });

  it("every other preset is a valid ordered window", () => {
    for (const p of ACTIVITY_PRESETS.filter((x) => x.key !== "all")) {
      const r = activityRange(p.key)!;
      expect(r).not.toBeNull();
      expect(r.fromYmd <= r.toYmd).toBe(true);
      expect(r.fromYmd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("weeks start Monday, matching the payroll week", () => {
    expect(weekStartOf("2026-08-19")).toBe("2026-08-17"); // Wed → Mon
    expect(weekStartOf("2026-08-17")).toBe("2026-08-17"); // Mon → itself
    // Sunday belongs to the week that STARTED, not the one about to begin.
    expect(weekStartOf("2026-08-23")).toBe("2026-08-17");
  });

  it("labour gained week windows and they stay ordered", () => {
    expect(LABOR_PRESETS.map((p) => p.key)).toContain("this_week");
    expect(LABOR_PRESETS.map((p) => p.key)).toContain("last_week");
    const lw = laborRange("last_week");
    // A completed week is exactly 7 days, Monday to Sunday.
    const from = new Date(`${lw.fromYmd}T00:00:00Z`);
    const to = new Date(`${lw.toYmd}T00:00:00Z`);
    expect((to.getTime() - from.getTime()) / 86_400_000).toBe(6);
    expect(from.getUTCDay()).toBe(1);
    expect(to.getUTCDay()).toBe(0);
    // Last week ends the day before this week starts — no gap, no overlap.
    const tw = laborRange("this_week");
    to.setUTCDate(to.getUTCDate() + 1);
    expect(to.toISOString().slice(0, 10)).toBe(tw.fromYmd);
  });
});
