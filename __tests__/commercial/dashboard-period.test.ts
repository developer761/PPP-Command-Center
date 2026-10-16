import { describe, it, expect } from "vitest";
import {
  dashboardRange,
  priorDashboardRange,
  validYmd,
  resolvePreset,
  DASHBOARD_PRESETS,
  DASHBOARD_DEFAULT,
} from "@/lib/commercial/reports/presets";
import { foldPeriodBilling, monthlyPointsFor } from "@/lib/commercial/reports/period-billing";
import { wasWonInPeriod } from "@/lib/commercial/opportunities/constants";
import { isSalesforceCarryoverInvoice } from "@/lib/commercial/invoices/constants";
import { dashboardMetricNotes } from "@/lib/commercial/dashboard/metric-notes";

/**
 * The Commercial dashboard's period picker (Katie 2026-10-15, for Alex).
 *
 * PPP's fiscal year starts in FEBRUARY (FY26 = 2026-02-01 → 2027-01-31,
 * Q1 = Feb–Apr). Every boundary below is a date a person would check against a
 * calendar, so they are pinned exactly rather than "well-formed".
 */

const FEB = 2;

describe("dashboardRange — fiscal year starting February", () => {
  const today = "2026-10-15";

  it("defaults to this fiscal year", () => {
    expect(DASHBOARD_DEFAULT).toBe("this_fy");
    expect(resolvePreset(undefined, DASHBOARD_PRESETS, DASHBOARD_DEFAULT)).toBe("this_fy");
    expect(resolvePreset("last_quarter", DASHBOARD_PRESETS, DASHBOARD_DEFAULT)).toBe("last_quarter");
  });

  it("this FY runs from Feb 1 to today, named by its start year", () => {
    expect(dashboardRange("this_fy", FEB, today)).toEqual({ fromYmd: "2026-02-01", toYmd: today, label: "FY26 to date" });
  });

  it("last FY is the whole previous Feb–Jan", () => {
    expect(dashboardRange("last_fy", FEB, today)).toEqual({ fromYmd: "2025-02-01", toYmd: "2026-01-31", label: "FY25" });
  });

  it("quarters are fiscal: October is Q3 (Aug–Oct)", () => {
    expect(dashboardRange("this_quarter", FEB, today)).toEqual({ fromYmd: "2026-08-01", toYmd: today, label: "Q3 FY26" });
    expect(dashboardRange("last_quarter", FEB, today)).toEqual({ fromYmd: "2026-05-01", toYmd: "2026-07-31", label: "Q2 FY26" });
  });

  it("January belongs to the fiscal year that started the previous February", () => {
    expect(dashboardRange("this_fy", FEB, "2027-01-20")?.fromYmd).toBe("2026-02-01");
    expect(dashboardRange("this_quarter", FEB, "2027-01-20")).toEqual({ fromYmd: "2026-11-01", toYmd: "2027-01-20", label: "Q4 FY26" });
  });

  it("last quarter crosses the fiscal year boundary from Q1", () => {
    expect(dashboardRange("last_quarter", FEB, "2026-02-10")).toEqual({ fromYmd: "2025-11-01", toYmd: "2026-01-31", label: "Q4 FY25" });
  });

  it("last month across a calendar year", () => {
    expect(dashboardRange("last_month", FEB, "2026-01-05")).toEqual({ fromYmd: "2025-12-01", toYmd: "2025-12-31", label: "Last month" });
  });

  it("all time is no window at all, never a sentinel date", () => {
    expect(dashboardRange("all", FEB, today)).toBeNull();
  });
});

describe("dashboardRange — calendar-year operating company", () => {
  it("fiscal start 1 gives calendar quarters and plain year labels", () => {
    expect(dashboardRange("this_fy", 1, "2026-10-15")).toEqual({ fromYmd: "2026-01-01", toYmd: "2026-10-15", label: "2026 to date" });
    expect(dashboardRange("this_quarter", 1, "2026-10-15")?.fromYmd).toBe("2026-10-01");
    expect(dashboardRange("last_quarter", 1, "2026-10-15")).toEqual({ fromYmd: "2026-07-01", toYmd: "2026-09-30", label: "Q3 2026" });
  });
});

describe("custom ranges", () => {
  it("uses valid dates, in either order", () => {
    expect(dashboardRange("custom", FEB, "2026-10-15", { from: "2026-03-01", to: "2026-03-31" })).toMatchObject({ fromYmd: "2026-03-01", toYmd: "2026-03-31" });
    expect(dashboardRange("custom", FEB, "2026-10-15", { from: "2026-03-31", to: "2026-03-01" })).toMatchObject({ fromYmd: "2026-03-01", toYmd: "2026-03-31" });
  });

  it("falls back to the default when a date is missing or impossible", () => {
    const fallback = dashboardRange(DASHBOARD_DEFAULT, FEB, "2026-10-15");
    expect(dashboardRange("custom", FEB, "2026-10-15", { from: "2026-02-31", to: "2026-03-01" })).toEqual(fallback);
    expect(dashboardRange("custom", FEB, "2026-10-15", { from: "2026-03-01" })).toEqual(fallback);
  });

  it("validYmd rejects non-dates and hostile input", () => {
    for (const bad of ["", "2026-13-01", "2026-02-30", "26-02-01", "2026-02-01T00:00", "../../x"]) {
      expect(validYmd(bad)).toBeNull();
    }
    expect(validYmd("2028-02-29")).toBe("2028-02-29");
  });
});

describe("priorDashboardRange — vs last, like for like", () => {
  it("an in-progress month compares with the same days of last month", () => {
    expect(priorDashboardRange("this_month", FEB, "2026-10-15")).toMatchObject({ fromYmd: "2026-09-01", toYmd: "2026-09-15" });
  });

  it("the same point is clipped to the end of a shorter previous period", () => {
    expect(priorDashboardRange("this_month", FEB, "2026-03-31")).toMatchObject({ fromYmd: "2026-02-01", toYmd: "2026-02-28" });
  });

  it("this FY compares with last FY to the same day", () => {
    expect(priorDashboardRange("this_fy", FEB, "2026-10-15")).toMatchObject({ fromYmd: "2025-02-01", toYmd: "2025-10-15" });
  });

  it("a completed period compares with the whole period before it", () => {
    expect(priorDashboardRange("last_quarter", FEB, "2026-10-15")).toMatchObject({ fromYmd: "2026-02-01", toYmd: "2026-04-30" });
    expect(priorDashboardRange("last_month", FEB, "2026-10-15")).toMatchObject({ fromYmd: "2026-08-01", toYmd: "2026-08-31" });
    expect(priorDashboardRange("last_fy", FEB, "2026-10-15")).toMatchObject({ fromYmd: "2024-02-01", toYmd: "2025-01-31" });
  });

  it("all time and custom have no natural 'last'", () => {
    expect(priorDashboardRange("all", FEB, "2026-10-15")).toBeNull();
    expect(priorDashboardRange("custom", FEB, "2026-10-15")).toBeNull();
  });
});

describe("foldPeriodBilling — both ledgers, dated by when they were billed", () => {
  const invoices = [
    { invoice_number: "INV-0001", status: "sent", subtotal_cents: 100_00, issued_at: "2026-09-10T15:00:00Z", created_at: "2026-08-01T15:00:00Z", opportunity_id: "o1" },
    { invoice_number: "INV-0002", status: "paid", subtotal_cents: 50_00, issued_at: "2026-03-05T15:00:00Z", created_at: "2026-03-05T15:00:00Z", opportunity_id: "o1" },
    { invoice_number: "INV-0003", status: "draft", subtotal_cents: 999_00, issued_at: null, created_at: "2026-09-01T15:00:00Z", opportunity_id: "o1" },
    { invoice_number: "INV-0004", status: "void", subtotal_cents: 999_00, issued_at: "2026-09-01T15:00:00Z", created_at: "2026-09-01T15:00:00Z", opportunity_id: "o1" },
    { invoice_number: "INV-0005", status: "sent", subtotal_cents: 7_00, issued_at: "2026-09-01T15:00:00Z", created_at: "2026-09-01T15:00:00Z", opportunity_id: "elsewhere" },
  ];
  // Three issued applications, completed-to-date 300 → 500 → 900, plus a draft.
  const apps = [
    { id: "a1", opportunity_id: "o2", application_number: 1, status: "paid", frozen_at: "2026-04-20T16:00:00Z", period_to: null },
    { id: "a2", opportunity_id: "o2", application_number: 2, status: "paid", frozen_at: null, period_to: "2026-08-21" },
    { id: "a3", opportunity_id: "o2", application_number: 3, status: "submitted", frozen_at: "2026-09-24T16:00:00Z", period_to: "2026-09-21" },
    { id: "a4", opportunity_id: "o2", application_number: 4, status: "draft", frozen_at: null, period_to: "2026-10-21" },
  ];
  const completed = new Map([["a1", 300_00], ["a2", 500_00], ["a3", 900_00], ["a4", 1_200_00]]);
  const scope = new Set(["o1", "o2"]);

  it("dates an invoice by when it was SENT, not created, and skips drafts and voids", () => {
    const sept = foldPeriodBilling(invoices, [], new Map(), { fromYmd: "2026-09-01", toYmd: "2026-09-30", label: "" }, scope);
    expect(sept.byOpp.get("o1")).toBe(100_00);
    const aug = foldPeriodBilling(invoices, [], new Map(), { fromYmd: "2026-08-01", toYmd: "2026-08-31", label: "" }, scope);
    expect(aug.byOpp.get("o1") ?? 0).toBe(0);
  });

  it("counts the work each AIA application ADDED, in the period it was issued", () => {
    const q3 = foldPeriodBilling([], apps, completed, { fromYmd: "2026-08-01", toYmd: "2026-10-31", label: "" }, scope);
    // #2 added 200, #3 added 400; #1 is before the window; the draft never counts.
    expect(q3.byOpp.get("o2")).toBe(600_00);
  });

  it("dates an application by its billing PERIOD, not when it was entered here", () => {
    // Back-entered history: period ended in March, issued in the platform in September.
    const backEntered = [{ id: "b1", opportunity_id: "o2", application_number: 1, status: "paid", frozen_at: "2026-09-25T16:00:00Z", period_to: "2026-03-24" }];
    const done = new Map([["b1", 400_00]]);
    const march = foldPeriodBilling([], backEntered, done, { fromYmd: "2026-03-01", toYmd: "2026-03-31", label: "" }, scope);
    expect(march.byOpp.get("o2")).toBe(400_00);
    const sept = foldPeriodBilling([], backEntered, done, { fromYmd: "2026-09-01", toYmd: "2026-09-30", label: "" }, scope);
    expect(sept.byOpp.get("o2") ?? 0).toBe(0);
  });

  it("over all time, AIA increments telescope to the latest issued application", () => {
    const all = foldPeriodBilling(invoices, apps, completed, null, scope);
    expect(all.byOpp.get("o2")).toBe(900_00);
    expect(all.byOpp.get("o1")).toBe(150_00);
    expect(all.totalCents).toBe(1_050_00);
    expect(all.byOpp.has("elsewhere")).toBe(false);
  });

  it("keeps every month for the chart, whatever the window", () => {
    const sept = foldPeriodBilling(invoices, apps, completed, { fromYmd: "2026-09-01", toYmd: "2026-09-30", label: "" }, scope);
    expect(sept.monthly.get("2026-04")).toBe(300_00);
    expect(sept.monthly.get("2026-09")).toBe(100_00 + 400_00);
  });
});

describe("monthlyPointsFor", () => {
  const monthly = new Map([["2025-01", 1_000_00], ["2026-09", 2_000_00]]);

  it("pads a short range back to six months", () => {
    const pts = monthlyPointsFor(monthly, { fromYmd: "2026-09-01", toYmd: "2026-09-30", label: "" }, "2026-10-15");
    expect(pts.map((p) => p.key)).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(pts.at(-1)?.value).toBe(2); // $2,000 in $K
  });

  it("covers a fiscal year month by month", () => {
    const pts = monthlyPointsFor(monthly, { fromYmd: "2026-02-01", toYmd: "2027-01-31", label: "" }, "2026-10-15");
    expect(pts).toHaveLength(12);
    expect(pts[0].key).toBe("2026-02");
    expect(pts[0].label).toBe("Feb '26");
    expect(pts.find((p) => p.key === "2027-01")?.label).toBe("Jan '27");
  });

  it("caps all time at the most recent 24 months", () => {
    const pts = monthlyPointsFor(monthly, null, "2026-10-15");
    expect(pts).toHaveLength(22); // Jan 2025 → Oct 2026
    const many = new Map([["2020-01", 1], ["2026-10", 1]]);
    expect(monthlyPointsFor(many, null, "2026-10-15")).toHaveLength(24);
  });
});

describe("wasWonInPeriod with an end date", () => {
  const won = { status: "pre_sale_closed", sub_status: "won", decided_at: "2026-07-15", closed_out_at: null } as const;

  it("open-ended without one (the original behaviour)", () => {
    expect(wasWonInPeriod(won as never, "2026-07-01")).toBe(true);
  });

  it("a completed period excludes wins after it ends", () => {
    expect(wasWonInPeriod(won as never, "2026-05-01", "2026-07-31")).toBe(true);
    expect(wasWonInPeriod(won as never, "2026-05-01", "2026-07-14")).toBe(false);
  });
});

describe("isSalesforceCarryoverInvoice", () => {
  it("matches the migration's SF-<work order> numbering only", () => {
    expect(isSalesforceCarryoverInvoice({ invoice_number: "SF-00268849" })).toBe(true);
    for (const n of ["INV-0024", "SF-", "XSF-00268849", "SF-00268849-B", null, undefined]) {
      expect(isSalesforceCarryoverInvoice({ invoice_number: n })).toBe(false);
    }
  });
});

describe("dashboardMetricNotes", () => {
  const notes = dashboardMetricNotes("FY26 to date");

  it("every figure says whether it follows the picker", () => {
    for (const [key, n] of Object.entries(notes)) {
      expect(n.text.length, key).toBeGreaterThan(40);
      if (n.scope === "range") expect(n.text, key).toContain("Period: FY26 to date.");
      else expect(n.text, key).toContain("As of today");
    }
  });

  it("Owed to us says it excludes unbilled work and includes retention", () => {
    expect(notes.owedToUs.scope).toBe("today");
    expect(notes.owedToUs.text).toMatch(/NOT included/);
    expect(notes.owedToUs.text).toMatch(/retention/i);
  });
});
