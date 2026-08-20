import { describe, it, expect } from "vitest";
import { receivablesCsv } from "@/lib/commercial/reports/receivables-export";
import type { ReceivablesReport, ReceivableRow } from "@/lib/commercial/reports/receivables";

function row(over: Partial<ReceivableRow>): ReceivableRow {
  return {
    kind: "invoice",
    key: "invoice:1",
    sourceId: "1",
    accountId: "a1",
    accountName: "Big Builder",
    opportunityId: "o1",
    jobName: "Job A",
    openCents: 100_00,
    reference: "INV-1",
    note: null,
    issuedIso: null,
    daysOut: null,
    href: "/x",
    billingHref: "/y",
    ...over,
  };
}

function report(rows: ReceivableRow[]): ReceivablesReport {
  const retainage = rows.filter((r) => r.kind === "retainage").reduce((n, r) => n + r.openCents, 0);
  const total = rows.reduce((n, r) => n + r.openCents, 0);
  return {
    rows,
    totalOpenCents: total,
    retainageCents: retainage,
    dueNowCents: total - retainage,
    overdueCents: rows.filter((r) => (r.daysOut ?? 0) > 0).reduce((n, r) => n + r.openCents, 0),
    generatedAt: "2026-08-19T12:00:00.000Z",
    gcOptions: [],
    topGc: null,
    unfilteredCount: rows.length,
    undatedExcluded: 0,
    noDueDateCount: rows.filter((r) => r.kind !== "retainage" && r.daysOut === null).length,
    noDueDateCents: rows
      .filter((r) => r.kind !== "retainage" && r.daysOut === null)
      .reduce((n, r) => n + r.openCents, 0),
    filtered: false,
    bookFingerprint: rows.map((r) => r.key).sort().join("|"),
  };
}

describe("receivablesCsv", () => {
  it("writes Mary's columns in her order", () => {
    const csv = receivablesCsv(report([row({})]));
    expect(csv.split("\r\n")[0]).toBe(
      '"Job","GC","Type","Reference","Billed / open","Status","Notes"'
    );
  });

  it("ties out with the page — every row, plus the four summary figures", () => {
    const csv = receivablesCsv(
      report([
        row({ key: "invoice:1", openCents: 500_00, daysOut: 12 }),
        row({ kind: "retainage", key: "retainage:o1", openCents: 200_00, daysOut: null }),
      ])
    );
    expect(csv).toContain('"TOTAL OUTSTANDING","","","","700.00","",""');
    // Collectible excludes retention — the distinction the whole report rests on.
    expect(csv).toContain('"Collectible now","","","","500.00","excludes retention",""');
    expect(csv).toContain('"Past due","","","","500.00","",""');
    expect(csv).toContain('"Retention held","","","","200.00","released at close-out",""');
  });

  it("never calls retention late", () => {
    const csv = receivablesCsv(report([row({ kind: "retainage", daysOut: null })]));
    expect(csv).toContain('"Held to close-out"');
    expect(csv).not.toContain("days late");
  });

  it("labels ageing the way the page does", () => {
    expect(receivablesCsv(report([row({ daysOut: 9 })]))).toContain('"9 days late"');
    expect(receivablesCsv(report([row({ daysOut: 0 })]))).toContain('"Not yet due"');
    expect(receivablesCsv(report([row({ daysOut: null })]))).toContain('"No due date"');
  });

  it("neutralises a formula-injection payload in a job name or a note", () => {
    // This file leaves the building as an email attachment.
    const csv = receivablesCsv(
      report([row({ jobName: '=cmd|\'/c calc\'!A1', note: "+1234" })])
    );
    expect(csv).toContain(`"'=cmd|'`);
    expect(csv).toContain(`"'+1234"`);
  });

  it("keeps an embedded quote and newline from shifting columns", () => {
    const csv = receivablesCsv(report([row({ note: 'said "pay\r\nnext week"' })]));
    expect(csv).toContain('""pay');
    // Header + 1 row + blank + 4 totals = 7 logical lines, plus trailing.
    expect(csv.trimEnd().split("\r\n").filter((l) => l.startsWith('"')).length).toBeGreaterThan(0);
  });

  it("ends with a trailing CRLF so Excel doesn't drop the last row", () => {
    expect(receivablesCsv(report([row({})]))).toMatch(/\r\n$/);
  });
});
