import { describe, it, expect } from "vitest";

import { buildWorklist, visibleWorklist, worklistTotals, type WorklistInput } from "@/lib/commercial/worklist";

/**
 * The worklist's two rules, pinned.
 *
 * Both came out of the first build being wrong on real data:
 *  - it listed one row per INVOICE, and the top eight came back as eight rows
 *    of the same GC, which is the "same ones over and over" complaint it was
 *    written to fix;
 *  - and straight money-first ranking hid the overdue bid entirely, which is
 *    the one row somebody could have acted on that morning.
 */

const EMPTY: WorklistInput = {
  overdueInvoices: [],
  unbilled: [],
  overdueProposals: [],
  coldRfps: [],
  followUps: [],
  awaitingDebrief: [],
  jobGaps: [],
};

const invoice = (n: number, accountId: string, cents: number, daysLate: number) => ({
  id: `i${n}`,
  number: `SF-${n}`,
  accountId,
  accountName: accountId === "a1" ? "LMJ Management" : "Bannett Group",
  balanceCents: cents,
  daysLate,
});

describe("chasing is per GC, not per invoice", () => {
  it("folds one GC's invoices into a single row", () => {
    const items = buildWorklist({
      ...EMPTY,
      overdueInvoices: [
        invoice(1, "a1", 10_000, 30),
        invoice(2, "a1", 20_000, 90),
        invoice(3, "a1", 30_000, 10),
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].subject).toBe("LMJ Management");
    expect(items[0].cents).toBe(60_000);
    // The oldest one is what makes the row urgent, not the average.
    expect(items[0].daysLate).toBe(90);
    // "documents", not "invoices": an overdue AIA application is one of these
    // too now, and calling it an invoice would send somebody looking for an
    // invoice that does not exist.
    expect(items[0].why).toContain("3 documents");
    // Several invoices → the filtered list, which is where you work a GC down.
    expect(items[0].href).toContain("view=receivables");
    expect(items[0].href).toContain("gc=a1");
  });

  it("a GC with one invoice opens that invoice", () => {
    const items = buildWorklist({ ...EMPTY, overdueInvoices: [invoice(9, "a2", 5_000, 3)] });
    expect(items[0].href).toBe("/commercial/invoices/i9");
    expect(items[0].why).toContain("one document");
  });

  /*
   * OVERDUE AIA BELONGS HERE, and did not used to.
   *
   * "Owed to us" counted overdue AIA while this list did not, so the tile said
   * chase $X and the list of whom to chase was short. It stopped being academic
   * on 2026-10-15: once AR aging stopped dating back-entered certificates from
   * the day they were typed, $29,275.70 of genuinely overdue AIA appeared that
   * nobody would have been told to collect.
   */
  it("an overdue AIA application is chased, and opens the application", () => {
    const items = buildWorklist({
      ...EMPTY,
      overdueInvoices: [
        {
          id: "app-7",
          number: "AIA#3",
          accountId: "a1",
          accountName: "LMJ Management",
          balanceCents: 27_460_82,
          daysLate: 120,
          href: "/commercial/opportunities/opp-1?tab=aia&app=app-7",
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].cents).toBe(27_460_82);
    // Its own link — an AIA application does not live under /commercial/invoices.
    expect(items[0].href).toBe("/commercial/opportunities/opp-1?tab=aia&app=app-7");
  });

  it("an AIA application and an invoice for one GC become one row", () => {
    const items = buildWorklist({
      ...EMPTY,
      overdueInvoices: [
        invoice(1, "a1", 10_000, 30),
        {
          id: "app-7",
          number: "AIA#3",
          accountId: "a1",
          accountName: "LMJ Management",
          balanceCents: 20_000,
          daysLate: 120,
          href: "/commercial/opportunities/opp-1?tab=aia&app=app-7",
        },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].cents).toBe(30_000);
    expect(items[0].daysLate).toBe(120);
    // Two documents → the filtered receivables list, not either document.
    expect(items[0].href).toContain("view=receivables");
  });

  it("keeps GCs apart", () => {
    const items = buildWorklist({
      ...EMPTY,
      overdueInvoices: [invoice(1, "a1", 10_000, 5), invoice(2, "a2", 90_000, 5)],
    });
    expect(items).toHaveLength(2);
    // Bigger money first.
    expect(items[0].subject).toBe("Bannett Group");
  });

  it("goes red only once something is properly old", () => {
    const fresh = buildWorklist({ ...EMPTY, overdueInvoices: [invoice(1, "a1", 100, 5)] });
    const old = buildWorklist({ ...EMPTY, overdueInvoices: [invoice(1, "a1", 100, 61)] });
    expect(fresh[0].tone).toBe("amber");
    expect(old[0].tone).toBe("rose");
  });
});

describe("ranking", () => {
  it("puts money at risk above everything, and lateness breaks ties", () => {
    const items = buildWorklist({
      ...EMPTY,
      overdueInvoices: [invoice(1, "a1", 500_000, 2)],
      followUps: [{ oppId: "o1", name: "A job", daysLate: 40 }],
      unbilled: [{ oppId: "o2", name: "Another job", cents: 900_000 }],
    });
    expect(items.map((i) => i.group)).toEqual(["money", "money", "bids"]);
    expect(items[0].cents).toBe(900_000);
  });

  it("a row with no money still outranks nothing", () => {
    const items = buildWorklist({ ...EMPTY, awaitingDebrief: [{ oppId: "o1", name: "Won job" }] });
    expect(items).toHaveLength(1);
    expect(items[0].cents).toBeUndefined();
  });
});

describe("every kind of work reaches the screen", () => {
  const manyMoney = Array.from({ length: 12 }, (_, n) => invoice(n, `acct${n}`, 1_000_000 - n, 10));

  it("promotes a group that the ranking shut out", () => {
    const items = buildWorklist({
      ...EMPTY,
      overdueInvoices: manyMoney,
      followUps: [{ oppId: "o1", name: "A bid", daysLate: 1 }],
    });
    // Ranked, the bid is last of 13 and would never be seen.
    expect(items[items.length - 1].group).toBe("bids");

    const shown = visibleWorklist(items, 8);
    expect(shown).toHaveLength(8);
    expect(shown.some((i) => i.group === "bids")).toBe(true);
    // It cost the LEAST urgent money row, not the most.
    expect(shown[0]).toBe(items[0]);
  });

  it("leaves a short list exactly as ranked", () => {
    const items = buildWorklist({ ...EMPTY, overdueInvoices: manyMoney.slice(0, 3) });
    expect(visibleWorklist(items, 8)).toEqual(items);
  });

  it("does not invent a row for a group with no work", () => {
    const items = buildWorklist({ ...EMPTY, overdueInvoices: manyMoney });
    const shown = visibleWorklist(items, 4);
    expect(shown).toHaveLength(4);
    expect(shown.every((i) => i.group === "money")).toBe(true);
  });
});

describe("the headline figure", () => {
  it("counts only money actually owed or billable", () => {
    const items = buildWorklist({
      ...EMPTY,
      overdueInvoices: [invoice(1, "a1", 100_000, 5)],
      unbilled: [{ oppId: "o1", name: "Job", cents: 50_000 }],
      // A bid's value is not money anybody owes us — including it would make
      // the headline impossible to reconcile against Accounting.
      overdueProposals: [{ oppId: "o2", name: "Bid", daysLate: 3, cents: 9_000_000 }],
    });
    expect(worklistTotals(items).atRiskCents).toBe(150_000);
    expect(worklistTotals(items).count).toBe(3);
  });
});
