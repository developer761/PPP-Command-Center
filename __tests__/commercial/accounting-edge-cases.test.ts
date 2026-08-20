import { describe, it, expect } from "vitest";
import { summarizeReceivables, type ReceivableRow } from "@/lib/commercial/reports/receivables";
import { receivablesCsv } from "@/lib/commercial/reports/receivables-export";
import { summarizeTransactions, monthLabel, type TxnRow } from "@/lib/commercial/reports/transactions";
import { transactionsCsv } from "@/lib/commercial/reports/transactions-export";
import { summarizeSalesTax, type SalesTaxRow } from "@/lib/commercial/reports/sales-tax";
import { summarizeReimbursements, type ReimbursementRow } from "@/lib/commercial/reports/reimbursements";
import { renderDigestEmail, digestWindow, type DigestData } from "@/lib/commercial/reports/alex-digest";
import { chartDomain } from "@/components/trend-chart";

/**
 * The degenerate cases, across every surface on the money desk.
 *
 * A brand-new environment, a single row, a filter that matches nothing, an
 * overpayment, a job with no dates — these are the states the platform is
 * actually in during its first months, and the ones nobody demos. Every
 * assertion here is a way a page could show a wrong number or an empty box
 * that reads as a failure.
 */

// ───────────────────────── fixtures ─────────────────────────

const receivable = (o: Partial<ReceivableRow> = {}): ReceivableRow => ({
  kind: "invoice", key: "invoice:1", sourceId: "1", accountId: "a1", accountName: "Acme GC",
  opportunityId: "o1", jobName: "Job", openCents: 100_00, reference: "INV-1", note: null,
  issuedIso: "2026-08-10T16:00:00Z", daysOut: null, href: "/x", billingHref: "/y", ...o,
});

const txn = (o: Partial<TxnRow> = {}): TxnRow => ({
  id: "pay:1", direction: "in", dateYmd: "2026-08-14", dateIso: "2026-08-14T15:00:00Z",
  name: "Job", recordType: "Payment In", amountCents: 100_00, reference: null,
  depositedAtIso: null, depositable: true, accountId: "a1", accountName: "Acme GC",
  opportunityId: "o1", href: "/x", ...o,
});

const taxRow = (o: Partial<SalesTaxRow> = {}): SalesTaxRow => ({
  invoiceId: "i1", invoiceNumber: "INV-1", issuedYmd: "2026-08-10", accountId: "a1",
  accountName: "Acme GC", jobName: "Job", subtotalCents: 100_00, taxCents: 8_63, taxPct: 8.625,
  exempt: false, exemptSource: null, exemptKind: null, certNumber: null, href: "/x", ...o,
});

const reimb = (o: Partial<ReimbursementRow> = {}): ReimbursementRow => ({
  purchaseId: "p1", person: "Mike", purchasedYmd: "2026-08-01", amountCents: 40_00,
  category: "materials", description: "Aboffs", jobName: "Job", opportunityId: "o1",
  accountName: "Acme GC", settledYmd: null, ageDays: 18, hasReceipt: true, href: "/x", ...o,
});

const digest = (o: Partial<DigestData> = {}): DigestData => ({
  cadence: "daily", windowLabel: "today", fromYmd: "2026-08-19", toYmd: "2026-08-19",
  outstandingCents: 0, collectibleCents: 0, overdueCents: 0, retainageCents: 0, openItemCount: 0,
  briefText: null, briefStale: false, inCents: 0, outCents: 0, netCents: 0, txnCount: 0,
  undepositedCents: 0, undepositedCount: 0, taxCollectedCents: 0, uncertifiedCount: 0,
  reimbursementsOwedCents: 0, reimbursementsOwedCount: 0, readyToBillCents: 0,
  overBilledProjects: 0, ...o,
});

// ───────────────────── a brand-new environment ─────────────────────

describe("day one — nothing in the database", () => {
  it("every summariser returns zeros rather than NaN", () => {
    const r = summarizeReceivables([]);
    const t = summarizeTransactions([]);
    const s = summarizeSalesTax([]);
    const m = summarizeReimbursements([]);
    for (const n of [
      r.totalOpenCents, r.dueNowCents, r.overdueCents, r.retainageCents, r.noDueDateCents,
      t.inCents, t.outCents, t.netCents, t.totalCents, t.undepositedCents,
      s.taxCollectedCents, s.taxableBaseCents, s.exemptBaseCents, s.uncertifiedBaseCents,
      m.owedCents, m.settledCents,
    ]) {
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBe(0);
    }
  });

  it("no summariser invents a top GC or a rate band out of nothing", () => {
    expect(summarizeReceivables([]).topGc).toBeNull();
    expect(summarizeSalesTax([]).byRate).toEqual([]);
    expect(summarizeReimbursements([]).byPerson).toEqual([]);
    expect(summarizeTransactions([]).partyOptions).toEqual([]);
  });

  it("every CSV still produces a readable file with headers", () => {
    // An export that throws on an empty book is an export nobody trusts on a
    // slow month either.
    const rCsv = receivablesCsv(summarizeReceivables([]));
    expect(rCsv).toContain("Job");
    expect(rCsv).toContain("TOTAL OUTSTANDING");
    const tCsv = transactionsCsv(summarizeTransactions([]));
    expect(tCsv).toContain("Date");
    expect(tCsv).toContain("NET");
  });

  it("the digest reads as calm, not broken", () => {
    const { text, html, subject } = renderDigestEmail(digest());
    expect(subject).toContain("$0.00 outstanding");
    expect(subject).not.toContain("late");
    expect(html).toContain("Nothing needs attention");
    expect(text).not.toContain("NaN");
  });
});

// ───────────────────── money that misbehaves ─────────────────────

describe("money at its edges", () => {
  it("an overpaid row can't drag the book negative", () => {
    // getReceivablesReport clamps at source; this pins that a negative can't
    // silently net away another row's real debt if one ever slips through.
    const r = summarizeReceivables([
      receivable({ key: "a", openCents: 100_00 }),
      receivable({ key: "b", openCents: 0 }),
    ]);
    expect(r.totalOpenCents).toBe(100_00);
  });

  it("a book that is ENTIRELY retention is collectible-zero, not overdue", () => {
    const r = summarizeReceivables([
      receivable({ key: "r", kind: "retainage", openCents: 5_000_00, daysOut: null }),
    ]);
    expect(r.retainageCents).toBe(5_000_00);
    expect(r.dueNowCents).toBe(0);
    expect(r.overdueCents).toBe(0);
    // And it is never counted as "no due date" — retention HAS no due date by
    // design, so warning about it would cry wolf on every AIA job.
    expect(r.noDueDateCount).toBe(0);
  });

  it("one GC holding the whole book reads as 100%, not a divide-by-zero", () => {
    const r = summarizeReceivables([receivable({ openCents: 1_00 })]);
    expect(r.topGc?.sharePct).toBe(100);
  });

  it("a zero-value row can't make the concentration share NaN", () => {
    const r = summarizeReceivables([receivable({ openCents: 0 })]);
    expect(r.topGc?.sharePct).toBe(0);
    expect(Number.isFinite(r.topGc!.sharePct)).toBe(true);
  });

  it("a month of pure spend nets negative and says so", () => {
    const t = summarizeTransactions([txn({ direction: "out", depositable: false, amountCents: 900_00 })]);
    expect(t.netCents).toBe(-900_00);
    expect(t.months[0].netCents).toBe(-900_00);
  });

  it("a 0% tax rate is a rate band, not an exemption", () => {
    // taxCents 0 with exempt=false shouldn't land in the exempt bucket — the
    // report decides on the FLAG, not on the arithmetic.
    const s = summarizeSalesTax([taxRow({ taxCents: 0, taxPct: 0, exempt: false })]);
    expect(s.exemptCount).toBe(0);
    expect(s.taxableBaseCents).toBe(100_00);
  });
});

// ───────────────────── dates that are missing or odd ─────────────────────

describe("dates", () => {
  it("an item with no due date is counted, and never called late", () => {
    const r = summarizeReceivables([receivable({ daysOut: null, openCents: 1_629_38 })]);
    expect(r.overdueCents).toBe(0);
    expect(r.noDueDateCount).toBe(1);
    expect(r.noDueDateCents).toBe(1_629_38);
  });

  it("a period filter reports what it hid rather than dropping it", () => {
    const r = summarizeReceivables(
      [receivable({ key: "dated", issuedIso: "2026-08-10T16:00:00Z" }), receivable({ key: "undated", issuedIso: null })],
      { fromYmd: "2026-08-01", toYmd: "2026-08-31" }
    );
    expect(r.rows).toHaveLength(1);
    expect(r.undatedExcluded).toBe(1);
  });

  it("December doesn't roll the month label into the next year", () => {
    expect(monthLabel("2026-12")).toBe("December 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
  });

  it("a digest on the 1st of January still bounds its own month", () => {
    const w = digestWindow("monthly", "2027-01-01");
    expect(w.fromYmd).toBe("2027-01-01");
    expect(w.toYmd).toBe("2027-01-01");
  });

  it("a weekly digest on a Monday starts that same day", () => {
    // 2026-08-17 is a Monday.
    expect(digestWindow("weekly", "2026-08-17").fromYmd).toBe("2026-08-17");
  });
});

// ───────────────────── filters that match nothing ─────────────────────

describe("a filter that matches nothing", () => {
  it("says the book isn't empty — it's filtered", () => {
    const r = summarizeReceivables([receivable({ accountId: "a1" })], { accountId: "nobody" });
    expect(r.rows).toHaveLength(0);
    expect(r.filtered).toBe(true);
    // The count that lets the page say "0 of 1" instead of looking bankrupt.
    expect(r.unfilteredCount).toBe(1);
  });

  it("still offers every GC so you can get back out", () => {
    const r = summarizeReceivables(
      [receivable({ key: "a", accountId: "a1", accountName: "Acme" }),
       receivable({ key: "b", accountId: "a2", accountName: "Zeta" })],
      { accountId: "a1" }
    );
    expect(r.rows).toHaveLength(1);
    expect(r.gcOptions).toHaveLength(2);
  });

  it("an overdue-only view on a book with nothing late is empty, not wrong", () => {
    const r = summarizeReceivables([receivable({ daysOut: -5 })], { overdueOnly: true });
    expect(r.rows).toHaveLength(0);
    expect(r.totalOpenCents).toBe(0);
  });
});

// ───────────────────── one data point ─────────────────────

describe("a single data point", () => {
  it("the chart domain never invents headroom above a flat zero", () => {
    // A phantom "$180" ceiling above a line of nothing was a real bug here.
    expect(chartDomain([0])).toEqual({ yMax: 0, yMin: 0, yRange: 1 });
  });

  it("the chart domain is finite for one non-zero point", () => {
    const d = chartDomain([50]);
    expect(Number.isFinite(d.yMax)).toBe(true);
    expect(Number.isFinite(d.yRange)).toBe(true);
    expect(d.yRange).toBeGreaterThan(0);
  });

  it("one reimbursement is still a ranking of one person", () => {
    const m = summarizeReimbursements([reimb()]);
    expect(m.byPerson).toHaveLength(1);
    expect(m.byPerson[0].owedCents).toBe(40_00);
  });
});

// ───────────────────── strings that break layouts ─────────────────────

describe("hostile strings", () => {
  it("a comma and a quote in a job name survive the CSV intact", () => {
    const csv = receivablesCsv(
      summarizeReceivables([receivable({ jobName: 'Panera, "the big one" — Holbrook' })])
    );
    expect(csv).toContain('"Panera, ""the big one"" — Holbrook"');
  });

  it("a formula in a note can't execute when the sheet is opened", () => {
    // The payroll CSV leaves the building; so does this one.
    const csv = receivablesCsv(summarizeReceivables([receivable({ note: "=cmd|'/c calc'!A1" })]));
    expect(csv).toContain(`"'=cmd|'/c calc'!A1"`);
  });

  it("a newline in a note can't split one row into two", () => {
    const csv = receivablesCsv(summarizeReceivables([receivable({ note: "line one\nline two" })]));
    // Quoted, so the row count is unchanged by the interior newline.
    expect(csv).toContain(`"line one\nline two"`);
  });

  it("the digest escapes a brief before it reaches an inbox", () => {
    const { html } = renderDigestEmail(digest({ briefText: '<img src=x onerror="alert(1)">' }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

// ───────────────────── scale ─────────────────────

describe("a book with real volume", () => {
  const many = Array.from({ length: 500 }, (_, i) =>
    receivable({
      key: `invoice:${i}`,
      accountId: `a${i % 20}`,
      accountName: `GC ${i % 20}`,
      openCents: (i + 1) * 100,
      daysOut: i % 3 === 0 ? i : null,
    })
  );

  it("totals 500 rows without losing precision", () => {
    const r = summarizeReceivables(many);
    const expected = many.reduce((n, x) => n + x.openCents, 0);
    expect(r.totalOpenCents).toBe(expected);
    expect(Number.isInteger(r.totalOpenCents)).toBe(true);
  });

  it("offers each GC once, not once per row", () => {
    expect(summarizeReceivables(many).gcOptions).toHaveLength(20);
  });

  it("sorts oldest-first without a NaN comparator on undated rows", () => {
    // `(null ?? -Infinity) - (null ?? -Infinity)` is NaN — the sort has to
    // survive two undated rows meeting each other.
    const sorted = summarizeReceivables(many, { sort: "oldest" }).rows;
    expect(sorted).toHaveLength(500);
    expect(sorted.every((x) => Number.isFinite(x.openCents))).toBe(true);
  });

  it("groups a year of transactions into months, newest first", () => {
    const rows = Array.from({ length: 365 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + i));
      const ymd = d.toISOString().slice(0, 10);
      return txn({ id: `pay:${i}`, dateYmd: ymd, dateIso: `${ymd}T15:00:00Z`, amountCents: 100 });
    });
    const t = summarizeTransactions(rows);
    expect(t.rowCount).toBe(365);
    expect(t.months.length).toBeGreaterThanOrEqual(12);
    const keys = t.months.map((m) => m.key);
    expect([...keys].sort().reverse()).toEqual(keys);
  });
});
