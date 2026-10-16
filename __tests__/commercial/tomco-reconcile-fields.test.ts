import { describe, expect, it } from "vitest";

import {
  RECONCILE_FIELDS,
  classify,
  reconcileDeal,
  type OursForReconcile,
  type SfForReconcile,
} from "@/lib/salesforce/tomco-reconcile";

/**
 * The field-by-field reconciliation behind `npm run check:salesforce`.
 *
 * Every rule is driven to "differ" here at least once. The version this
 * replaced compared one field on 98 of 140 deals and passed on any two
 * differences, so the property worth pinning is that each comparison CAN fail
 * — and that a pinned known difference cannot absorb a new one.
 */

const ours = (over: Partial<OursForReconcile> = {}): OursForReconcile => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Job A",
  deleted: false,
  sold: true,
  closedUnsold: false,
  baseCents: 4_575_000,
  approvedCoCents: 2_262_500,
  bidCents: null,
  decidedOn: "2025-08-04",
  accountId: "acct-1",
  accountName: "ALTA Construction East Inc.",
  jobNumber: "00268849",
  ...over,
});

const sf = (over: Partial<SfForReconcile> = {}): SfForReconcile => ({
  id: "006Kf00000MqFQ0IAN",
  name: "Job A",
  stageName: "Closed Won",
  isClosed: true,
  isWon: true,
  closeDate: "2025-08-04",
  accountName: "ALTA Construction East Inc.",
  ourAccountIdForSfAccount: "acct-1",
  ownerName: "Brendan Tomco",
  recordType: "Tomco",
  corporateName: "Tomco Painting",
  externalId: null,
  syncedQuoteId: "0Q0Kf000000IWCPKA4",
  quoteSubtotal: 45_750,
  canonical: 68_375,
  approvedCoCents: 2_262_500,
  workOrderNumbers: ["00268849"],
  quotes: [{ status: "Approved", lines: 1, lineAmounts: [45_750] }],
  ...over,
});

const imported = { createdByWriteBack: false, closedByWriteBack: false };
const status = (vs: ReturnType<typeof reconcileDeal>, f: string) => vs.find((v) => v.field === f)!.status;

describe("reconcileDeal", () => {
  it("compares every field, and a deal that matches agrees on all the applicable ones", () => {
    const vs = reconcileDeal(ours(), sf(), imported);
    expect(vs.map((v) => v.field).sort()).toEqual([...RECONCILE_FIELDS].sort());
    expect(vs.filter((v) => v.status === "differ")).toEqual([]);
  });

  // Each binding field, broken on purpose, must say "differ".
  const breakers: Array<[string, Partial<OursForReconcile>, Partial<SfForReconcile>]> = [
    ["live_here", { deleted: true }, {}],
    ["corporate_name", {}, { corporateName: "Precision Painting Plus" }],
    ["record_type", {}, { recordType: "New" }],
    ["external_id", {}, { externalId: "22222222-2222-4222-8222-222222222222" }],
    ["stage", { sold: false }, {}],
    ["contract", {}, { canonical: 83_000 }],
    ["base", { baseCents: 4_575_001 }, {}],
    ["change_orders", {}, { approvedCoCents: 3_725_000, canonical: 83_000 }],
    ["account", {}, { ourAccountIdForSfAccount: "acct-2" }],
    ["close_date", { decidedOn: "2025-08-05" }, {}],
    ["quote", {}, { quotes: [{ status: "Draft", lines: 1, lineAmounts: [45_750] }] }],
  ];
  for (const [field, o, s] of breakers) {
    it(`a broken ${field} is a difference`, () => {
      expect(status(reconcileDeal(ours(o), sf(s), imported), field)).toBe("differ");
      // and the unbroken pair agrees, so the line above is not vacuous
      expect(status(reconcileDeal(ours(), sf(), imported), field)).toBe("agree");
    });
  }

  it("the money is compared in cents, not floats — one cent is a difference", () => {
    expect(status(reconcileDeal(ours({ baseCents: 4_575_001 }), sf({ canonical: 68_375.01 }), imported), "contract")).toBe("agree");
    expect(status(reconcileDeal(ours(), sf({ canonical: 68_375.01 }), imported), "contract")).toBe("differ");
  });

  it("a deal sold here but still open in Salesforce differs on stage, and its money is not compared", () => {
    const vs = reconcileDeal(ours(), sf({ stageName: "Estimate Sent", isClosed: false, isWon: false }), imported);
    expect(status(vs, "stage")).toBe("differ");
    expect(status(vs, "contract")).toBe("n/a");
  });

  it("an unsold deal is compared on what IS comparable — stage, GC, name, bid", () => {
    const o = ours({ sold: false, baseCents: null, approvedCoCents: 0, bidCents: 500_000, decidedOn: null, jobNumber: null });
    const s = sf({ stageName: "Estimate Sent", isClosed: false, isWon: false, quoteSubtotal: 5_000, canonical: null, workOrderNumbers: [] });
    const vs = reconcileDeal(o, s, imported);
    expect(status(vs, "stage")).toBe("agree");
    expect(status(vs, "bid")).toBe("agree");
    expect(status(vs, "account")).toBe("agree");
    expect(status(vs, "contract")).toBe("n/a");
    expect(status(reconcileDeal({ ...o, bidCents: 500_100 }, s, imported), "bid")).toBe("differ");
    expect(status(reconcileDeal(o, { ...s, stageName: "Closed Lost", isClosed: true }, imported), "stage")).toBe("differ");
  });

  it("a GC compared by name when the linked row was deleted here — case-insensitively, like SOQL", () => {
    const s = sf({ ourAccountIdForSfAccount: null, sfAccountLinkStale: true, accountName: "Cummins sales and Service" });
    expect(status(reconcileDeal(ours({ accountName: "Cummins Sales and Service" }), s, imported), "account")).toBe("agree");
    expect(status(reconcileDeal(ours({ accountName: "Cummins Inc" }), s, imported), "account")).toBe("differ");
  });

  it("the close date is NOT compared on a sale the write-back closed — the org stamps the sync day by design", () => {
    const vs = reconcileDeal(ours({ decidedOn: "2026-10-13" }), sf({ closeDate: "2026-10-14" }), { createdByWriteBack: false, closedByWriteBack: true });
    expect(status(vs, "close_date")).toBe("n/a");
    // …but it IS compared on one a person closed in Salesforce.
    expect(status(reconcileDeal(ours({ decidedOn: "2026-09-17" }), sf({ closeDate: "2026-09-22" }), imported), "close_date")).toBe("differ");
  });

  it("a sale the write-back built must be exactly Katie's shape, and its owner Brendan", () => {
    const built = { createdByWriteBack: true, closedByWriteBack: true };
    const good = sf({ canonical: 45_750, approvedCoCents: 0, quoteSubtotal: 45_750 });
    const o = ours({ approvedCoCents: 0 });
    expect(status(reconcileDeal(o, good, built), "quote")).toBe("agree");
    expect(status(reconcileDeal(o, good, built), "owner")).toBe("agree");
    expect(status(reconcileDeal(o, { ...good, syncedQuoteId: null }, built), "quote")).toBe("differ");
    expect(status(reconcileDeal(o, { ...good, quotes: [{ status: "Approved", lines: 2, lineAmounts: [40_000, 5_750] }] }, built), "quote")).toBe("differ");
    expect(status(reconcileDeal(o, { ...good, quotes: [{ status: "Approved", lines: 1, lineAmounts: [45_000] }] }, built), "quote")).toBe("differ");
    expect(status(reconcileDeal(o, { ...good, ownerName: "Mary O'Sullivan" }, built), "owner")).toBe("differ");
  });

  it("the labels nothing syncs are reported but never binding", () => {
    const vs = reconcileDeal(ours({ name: "Renamed here" }), sf(), imported);
    const name = vs.find((v) => v.field === "name")!;
    expect(name.status).toBe("differ");
    expect(name.binding).toBe(false);
    expect(vs.find((v) => v.field === "contract")!.binding).toBe(true);
  });
});

describe("classify — a known difference is pinned, not counted", () => {
  const vca = (canonical: number) => [{ dealId: "d1", label: "VCA", verdicts: reconcileDeal(ours({ id: "d1" }), sf({ canonical }), imported) }];
  const pin = { dealId: "d1", field: "contract" as const, ours: "$68,375.00", theirs: "$83,000.00", reason: "r", owner: "o" };

  it("matches only the exact figures it was pinned to", () => {
    const { classified } = classify(vca(83_000), [pin]);
    expect(classified.find((c) => c.verdict.field === "contract")!.kind).toBe("known");
  });

  it("🔴 the same deal drifting FURTHER is a new difference, not the known one", () => {
    const { classified } = classify(vca(84_000), [pin]);
    expect(classified.find((c) => c.verdict.field === "contract")!.kind).toBe("NEW");
  });

  it("🔴 a second deal differing is new — the old `differ.length <= 2` passed it", () => {
    const rows = [...vca(83_000), { dealId: "d2", label: "Other", verdicts: reconcileDeal(ours({ id: "d2" }), sf({ canonical: 1 }), imported) }];
    const { classified } = classify(rows, [pin]);
    expect(classified.filter((c) => c.kind === "NEW").map((c) => c.dealId)).toContain("d2");
  });

  it("a pinned difference that goes away is reported, so the list only shrinks on purpose", () => {
    const { classified } = classify(vca(68_375), [pin]);
    expect(classified.find((c) => c.verdict.field === "contract")!.kind).toBe("resolved-known");
  });

  it("a pin naming no linked deal is stale", () => {
    expect(classify(vca(83_000), [pin, { ...pin, dealId: "gone" }]).staleKnown.map((k) => k.dealId)).toEqual(["gone"]);
  });

  it("an informational difference is `info`, never NEW", () => {
    const rows = [{ dealId: "d3", label: "x", verdicts: reconcileDeal(ours({ id: "d3", name: "Renamed" }), sf(), imported) }];
    expect(classify(rows, []).classified.find((c) => c.verdict.field === "name")!.kind).toBe("info");
  });
});
