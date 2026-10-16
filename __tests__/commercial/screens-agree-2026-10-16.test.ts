import { describe, it, expect } from "vitest";
import { aiaOverdueFrom } from "@/lib/commercial/invoices/rollup";
import { lastSixMonthsPoints } from "@/lib/commercial/reports/billed-trend";
import { foldPeriodBilling } from "@/lib/commercial/reports/period-billing";
import { monthlyBilledSeries } from "@/lib/commercial/invoices/monthly";
import { latestUserActivityByAccount, type AuditActivityRow } from "@/lib/commercial/accounts/user-activity";

/**
 * Four screens that disagreed about the same rows on 2026-10-16. Each test
 * is built from the shape of the real rows that disagreed.
 */

// 2026-10-16 noon ET.
const NOW = Date.parse("2026-10-16T16:00:00Z");

describe("account Collections counts overdue AIA, like the dashboard chase list", () => {
  // LMJ: Water Lilies Post Fire AIA #3, period to 2026-08-20, frozen
  // 2026-09-16 (back-entered) → due 30 days after its issue → 27 days late.
  // AIREF #2 AIA #6 issued today → not due for 30 days.
  const lmj = [
    { dueNowCents: 1_517_571, latestIssuedFrozenAt: "2026-08-20T16:00:00Z", latestIssuedPeriodTo: "2026-08-20" },
    { dueNowCents: 7_600_000, latestIssuedFrozenAt: "2026-10-16T14:00:00Z", latestIssuedPeriodTo: "2026-10-16" },
    // Fully collected: nothing due now, never overdue whatever its age.
    { dueNowCents: 0, latestIssuedFrozenAt: "2026-01-01T16:00:00Z", latestIssuedPeriodTo: "2026-01-01" },
  ];

  it("counts the past-due application and only that one", () => {
    expect(aiaOverdueFrom(lmj, NOW)).toEqual({ cents: 1_517_571, count: 1 });
  });

  it("adds to the $550 invoice to make the dashboard's $15,725.71", () => {
    const invoiceOverdue = 55_000;
    expect(invoiceOverdue + aiaOverdueFrom(lmj, NOW).cents).toBe(1_572_571);
  });

  it("an application with no issue date cannot be called late", () => {
    expect(aiaOverdueFrom([{ dueNowCents: 100, latestIssuedFrozenAt: null, latestIssuedPeriodTo: null }], NOW)).toEqual({ cents: 0, count: 0 });
  });
});

describe("billed / month charts include AIA", () => {
  // One invoice ($7k) and an AIA job whose applications added $100k in
  // September and $40k in October.
  const invoices = [{ status: "sent", subtotal_cents: 700_000, issued_at: "2026-09-10T15:00:00Z", created_at: "2026-09-10T15:00:00Z", opportunity_id: "inv-job" }];
  const apps = [
    { id: "a1", opportunity_id: "aia-job", application_number: 1, status: "paid", frozen_at: "2026-10-01T00:00:00Z", period_to: "2026-09-30" },
    { id: "a2", opportunity_id: "aia-job", application_number: 2, status: "submitted", frozen_at: "2026-10-16T00:00:00Z", period_to: "2026-10-16" },
  ];
  const completed = new Map([["a1", 10_000_000], ["a2", 14_000_000]]);
  const fold = foldPeriodBilling(invoices, apps, completed, null, new Set(["inv-job", "aia-job"]));

  it("draws six months ending this one, with the AIA money in them", () => {
    const pts = lastSixMonthsPoints(fold.monthly, "2026-10-16");
    expect(pts).toHaveLength(6);
    expect(pts.at(-2)).toMatchObject({ value: 107 }); // Sep: $7k invoice + $100k AIA, in $K
    expect(pts.at(-1)).toMatchObject({ value: 40 }); // Oct: $40k AIA
  });

  it("the invoice-only series it replaces tops out at the $7k invoice", () => {
    const old = monthlyBilledSeries(invoices, { months: 6, nowIso: "2026-10-16T16:00:00Z" });
    expect(Math.max(...old.map((p) => p.value))).toBe(7);
  });
});

describe("recently active = what people did, not updated_at", () => {
  const opps = new Map([["opp-1", "acct-b"]]);
  const row = (o: Partial<AuditActivityRow>): AuditActivityRow => ({
    table_name: "commercial_accounts",
    row_id: "acct-a",
    user_id: "u1",
    at: "2026-10-15T12:00:00Z",
    after_json: null,
    before_json: null,
    ...o,
  });

  it("a system write (a bulk backfill) makes nobody active", () => {
    const m = latestUserActivityByAccount([row({ user_id: null }), row({ row_id: "acct-c", user_id: null })], opps);
    expect(m.size).toBe(0);
  });

  it("ties a deal's records back to its GC, through opportunity_id or the deal row", () => {
    const m = latestUserActivityByAccount(
      [
        row({ table_name: "commercial_aia_applications", row_id: "app-1", after_json: { opportunity_id: "opp-1" }, at: "2026-10-14T10:00:00Z" }),
        row({ table_name: "commercial_opportunities", row_id: "opp-1", at: "2026-10-16T10:00:00Z" }),
        row({ table_name: "commercial_account_contacts", row_id: "c-1", before_json: { account_id: "acct-d" } }),
      ],
      opps,
    );
    expect(m.get("acct-b")).toBe("2026-10-16T10:00:00Z");
    expect(m.get("acct-d")).toBe("2026-10-15T12:00:00Z");
  });

  it("a row that reaches no GC is skipped, not guessed", () => {
    const m = latestUserActivityByAccount([row({ table_name: "commercial_aia_line_items", row_id: "li-1", after_json: { application_id: "app-1" } })], opps);
    expect(m.size).toBe(0);
  });
});
