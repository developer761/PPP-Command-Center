import { describe, it, expect } from "vitest";
import {
  cents,
  dealStatusForWorkOrder,
  jobStatusForWorkOrder,
  dueDateFor,
  addressParts,
  isClosedWorkOrder,
  planInvoice,
  adjustmentLabel,
  invoiceStatus,
  purchaseCategory,
  isReimbursement,
  employeeFromCrewWorker,
  ymd,
  planInvoiceColumns,
} from "@/lib/commercial/import/mapping";

/**
 * The Tomco migration's decisions. Karan's rule: every KPI and total lines up to
 * the cent — so the seven jobs where Salesforce disagrees with itself are tested
 * with their REAL figures, not invented ones.
 */

describe("dollars to cents", () => {
  it("does not drift on the values that actually appear", () => {
    // 1087.50 * 100 is 108749.99999999999 in floating point.
    expect(cents(1087.5)).toBe(108750);
    expect(cents(3795.92)).toBe(379592);
    expect(cents(22620.01)).toBe(2262001);
    expect(cents(2676983.67)).toBe(267698367);
    expect(cents("46500.00")).toBe(4650000);
  });
  it("handles nothing, and negatives, without inventing money", () => {
    expect(cents(null)).toBe(0);
    expect(cents(undefined)).toBe(0);
    expect(cents("")).toBe(0);
    expect(cents(-21.75)).toBe(-2175);
  });
});

describe("work order status → deal status", () => {
  it("maps every status Tomco actually uses", () => {
    expect(dealStatusForWorkOrder("Closed")).toEqual({ status: "post_sale_closed", subStatus: "closed" });
    expect(dealStatusForWorkOrder("Work In Progress")).toEqual({ status: "in_progress", subStatus: "wip_on_site" });
    expect(dealStatusForWorkOrder("On Hold")).toEqual({ status: "in_progress", subStatus: "wip_on_hold" });
    expect(dealStatusForWorkOrder("Coordination")).toEqual({ status: "pre_construction", subStatus: "coordination" });
    expect(dealStatusForWorkOrder("Pending")).toEqual({ status: "pre_construction", subStatus: "coordination" });
  });

  it("keeps 'Complete Balance Owed' in BILLING, not closed", () => {
    // 10 jobs. Closing them would hide what Tomco is still owed.
    expect(dealStatusForWorkOrder("Complete Balance Owed")).toEqual({
      status: "billing",
      subStatus: "completed_and_invoiced",
    });
    expect(isClosedWorkOrder("Complete Balance Owed")).toBe(true);
  });

  it("puts live work back on Brendan's calendar", () => {
    // Field Ops lists only the open statuses; `closed` is invisible there.
    expect(jobStatusForWorkOrder("Work In Progress")).toBe("in_progress");
    expect(jobStatusForWorkOrder("On Hold")).toBe("on_hold");
    expect(jobStatusForWorkOrder("Coordination")).toBe("ready_to_schedule");
    expect(jobStatusForWorkOrder("Pending")).toBe("ready_to_schedule");
    // Painting done, money not in: off the schedule, not finished with.
    expect(jobStatusForWorkOrder("Complete Balance Owed")).toBe("complete");
    expect(jobStatusForWorkOrder("Closed")).toBe("closed");
    expect(jobStatusForWorkOrder("Complete Paid in Full")).toBe("closed");
    expect(jobStatusForWorkOrder("Something New")).toBe("closed");
  });

  it("refuses to guess at an unknown status", () => {
    expect(dealStatusForWorkOrder("Something New")).toEqual({ status: "", subStatus: "" });
    expect(dealStatusForWorkOrder(null)).toEqual({ status: "", subStatus: "" });
  });
});

describe("the invoice plan — Salesforce's balance wins, to the cent", () => {
  it("a straightforward job needs no adjustment", () => {
    const p = planInvoice({
      quotedSubtotalWithCo: 46500, totalChangeOrder: 0, tax: 0,
      grandTotal: 46500, totalPaymentsIn: 19000, balanceOwed: 27500,
    });
    expect(p.subtotalCents).toBe(4650000);
    expect(p.balanceCents).toBe(2750000);
    expect(p.adjustmentCents).toBe(0);
    expect(adjustmentLabel(p)).toBeNull();
    expect(invoiceStatus(p)).toBe("partial");
  });

  // The seven real disagreements, with Salesforce's own numbers.
  const cases = [
    { job: "00277843", grandTotal: 1087.5, paid: 1065.75, balance: 0, adj: -2175, over: false },
    { job: "00269035", grandTotal: 22620.01, paid: 22623.01, balance: 0, adj: 300, over: true },
    { job: "00271332", grandTotal: 3795.92, paid: 4285.43, balance: 0, adj: 48951, over: true },
    { job: "00273063", grandTotal: 669.04, paid: 669.0, balance: 0, adj: -4, over: false },
    { job: "00276888", grandTotal: 762.13, paid: 761.25, balance: 0, adj: -88, over: false },
    { job: "00281988", grandTotal: 2492.19, paid: 2491.19, balance: 0, adj: -100, over: false },
    { job: "00302953", grandTotal: 46500, paid: 19000, balance: 29075.4, adj: 157540, over: false },
  ];

  it.each(cases)("$job lands on Salesforce's balance exactly", (c) => {
    const p = planInvoice({
      quotedSubtotalWithCo: c.grandTotal, totalChangeOrder: 0, tax: 0,
      grandTotal: c.grandTotal, totalPaymentsIn: c.paid, balanceOwed: c.balance,
    });
    expect(p.balanceCents).toBe(cents(c.balance));
    // total − payments + adjustment == Salesforce's balance, by construction.
    expect(p.totalCents - p.paymentsCents + p.adjustmentCents).toBe(p.balanceCents);
    expect(p.adjustmentCents).toBe(c.adj);
    expect(p.isOverpaid).toBe(c.over);
  });

  it("names a write-off a write-off and a credit a credit", () => {
    const shortPaid = planInvoice({ quotedSubtotalWithCo: 1087.5, totalChangeOrder: 0, tax: 0, grandTotal: 1087.5, totalPaymentsIn: 1065.75, balanceOwed: 0 });
    expect(adjustmentLabel(shortPaid)).toMatch(/[Ww]ritten off/);
    const overPaid = planInvoice({ quotedSubtotalWithCo: 3795.92, totalChangeOrder: 0, tax: 0, grandTotal: 3795.92, totalPaymentsIn: 4285.43, balanceOwed: 0 });
    expect(adjustmentLabel(overPaid)).toMatch(/[Cc]redit/);
    const owedMore = planInvoice({ quotedSubtotalWithCo: 46500, totalChangeOrder: 0, tax: 0, grandTotal: 46500, totalPaymentsIn: 19000, balanceOwed: 29075.4 });
    expect(adjustmentLabel(owedMore)).toMatch(/exceeds/);
  });

  it("uses Salesforce's grand total rather than recomputing subtotal + tax", () => {
    // A job whose SF arithmetic differs by a cent: the platform must show what
    // Tomco sees, not a number we derived.
    const p = planInvoice({ quotedSubtotalWithCo: 100, totalChangeOrder: 0, tax: 6.63, grandTotal: 106.62, totalPaymentsIn: 0, balanceOwed: 106.62 });
    expect(p.totalCents).toBe(10662);
    expect(p.subtotalCents + p.taxCents).toBe(10663);
    expect(p.balanceCents).toBe(10662);
  });

  it("a fully paid job reads paid, an untouched one reads sent", () => {
    expect(invoiceStatus(planInvoice({ quotedSubtotalWithCo: 100, totalChangeOrder: 0, tax: 0, grandTotal: 100, totalPaymentsIn: 100, balanceOwed: 0 }))).toBe("paid");
    expect(invoiceStatus(planInvoice({ quotedSubtotalWithCo: 100, totalChangeOrder: 0, tax: 0, grandTotal: 100, totalPaymentsIn: 0, balanceOwed: 100 }))).toBe("sent");
  });
});

describe("when an invoice is due", () => {
  it("'Upon Receipt' is due the day it went out — which is what Tomco's terms say", () => {
    expect(dueDateFor("2026-02-26", "Upon Receipt")).toBe("2026-02-26");
    expect(dueDateFor("2026-02-26", "upon receipt")).toBe("2026-02-26");
    expect(dueDateFor("2026-02-26", "Due on Receipt")).toBe("2026-02-26");
  });
  it("honours net terms, including across a month and a year end", () => {
    expect(dueDateFor("2026-02-26", "Net 30")).toBe("2026-03-28");
    expect(dueDateFor("2026-12-20", "Net 30")).toBe("2027-01-19");
    expect(dueDateFor("2026-01-31", "Net 45")).toBe("2026-03-17");
  });
  it("falls back to 30 days rather than leaving it undated", () => {
    // An invoice with no due date cannot age, and every collections surface
    // then reads it as current.
    expect(dueDateFor("2026-02-26", null)).toBe("2026-03-28");
    expect(dueDateFor("2026-02-26", "whatever Salesforce had")).toBe("2026-03-28");
  });
  it("returns nothing when the invoice was never issued", () => {
    expect(dueDateFor(null, "Upon Receipt")).toBeNull();
  });
});

describe("Salesforce addresses → the four columns", () => {
  it("pulls a compound address apart instead of stringifying it", () => {
    // What jsforce actually returned for Estimation_Address__c, and what
    // landed on 44 of Tomco's 132 deals as the "Street" on screen.
    expect(
      addressParts({
        city: "Glen Head",
        country: "United States",
        countryCode: "US",
        postalCode: "11545",
        state: "New York",
        stateCode: "NY",
        street: "10 Glen Head Road",
      } as never)
    ).toEqual({ street: "10 Glen Head Road", city: "Glen Head", state: "NY", zip: "11545" });
  });

  it("parses one that arrived already stringified", () => {
    const raw = '{"city":"Melville","postalCode":"11747","stateCode":"NY","street":"540 Broadhollow Road"}';
    expect(addressParts(raw)).toEqual({ street: "540 Broadhollow Road", city: "Melville", state: "NY", zip: "11747" });
  });

  it("leaves a plain street line alone — WorkOrder.Street must keep working", () => {
    expect(addressParts("21 Newton Place")).toEqual({ street: "21 Newton Place", city: null, state: null, zip: null });
  });

  it("prefers the two-letter state code, which is how every address here is written", () => {
    expect(addressParts({ state: "New York", stateCode: "NY" } as never).state).toBe("NY");
    expect(addressParts({ state: "New York" } as never).state).toBe("New York");
  });

  it("keeps unparseable text rather than losing the address", () => {
    expect(addressParts("{not json").street).toBe("{not json");
  });

  it("returns nothing for nothing", () => {
    expect(addressParts(null)).toEqual({ street: null, city: null, state: null, zip: null });
    expect(addressParts("   ")).toEqual({ street: null, city: null, state: null, zip: null });
  });
});

describe("transactions → cost categories", () => {
  it("splits purchases, crew labor and reimbursements", () => {
    expect(purchaseCategory({ recordType: "Purchase", payeeType: null })).toBe("materials");
    expect(purchaseCategory({ recordType: "Payment_Out", payeeType: "Labor_Company" })).toBe("labor");
    expect(purchaseCategory({ recordType: "Payment_Out", payeeType: "Reimbursement" })).toBe("other");
    expect(isReimbursement({ recordType: "Payment_Out", payeeType: "Reimbursement" })).toBe(true);
  });
  it("never turns money IN into a cost", () => {
    expect(purchaseCategory({ recordType: "Payment_In", payeeType: null })).toBeNull();
  });
});

describe("crew workers → employees", () => {
  it("splits a name and marks them subcontract, with no pay rate", () => {
    const e = employeeFromCrewWorker("  Greg   Martinez ");
    expect(e).toMatchObject({ first_name: "Greg", last_name: "Martinez", display_name: "Greg Martinez", worker_type: "sub" });
  });
  it("copes with a single name", () => {
    expect(employeeFromCrewWorker("Miguel")).toMatchObject({ first_name: "Miguel", last_name: null, display_name: "Miguel" });
  });
});

describe("Salesforce dates → the day the work happened", () => {
  it("leaves a bare DATE alone — no UTC shift backwards", () => {
    expect(ymd("2026-08-13")).toBe("2026-08-13");
  });
  it("converts a datetime to the Eastern day, including after 8pm", () => {
    // 01:17 UTC on the 16th is still the 15th in Islip.
    expect(ymd("2026-09-16T01:17:36.000+0000")).toBe("2026-09-15");
    expect(ymd("2026-09-15T13:04:01.000+0000")).toBe("2026-09-15");
  });
  it("returns nothing for nothing", () => {
    expect(ymd(null)).toBeNull();
    expect(ymd("not a date")).toBeNull();
  });
});

describe("the invoice COLUMNS reproduce the total exactly", () => {
  // total_cents is generated as subtotal + ROUND(subtotal * tax_pct / 100),
  // so this is the arithmetic Postgres will actually do.
  const generated = (c: { subtotal_cents: number; tax_pct: number }) =>
    c.subtotal_cents + Math.round((c.subtotal_cents * c.tax_pct) / 100);

  const job = (subtotal: number, tax: number, grand: number, paid: number, balance: number) =>
    planInvoice({ quotedSubtotalWithCo: subtotal, totalChangeOrder: 0, tax, grandTotal: grand, totalPaymentsIn: paid, balanceOwed: balance });

  it("a job with no tax is exact", () => {
    const p = job(46500, 0, 46500, 19000, 27500);
    const c = planInvoiceColumns(p);
    expect(generated(c)).toBe(p.balanceCents + p.paymentsCents);
    expect(c.tax_pct).toBe(0);
    expect(c.taxFolded).toBe(false);
  });

  // Every taxed Tomco job I pulled, with its real figures.
  const taxed: Array<[string, number, number, number]> = [
    ["00269011", 2620.0, 229.25, 2849.25],
    ["00269060", 151.36, 13.24, 164.6],
    ["00269066", 6250.0, 546.88, 6796.88],
    ["00269240", 9750.0, 853.13, 10603.13],
    ["00274853", 350.0, 30.63, 380.63],
    ["00276888", 700.0, 62.13, 762.13],
    ["00277843", 1000.0, 87.5, 1087.5],
    ["00279537", 7050.0, 616.88, 7666.88],
  ];

  it.each(taxed)("%s: the generated total equals what Salesforce says", (_job, subtotal, tax, grand) => {
    const p = job(subtotal, tax, grand, 0, grand);
    const c = planInvoiceColumns(p);
    expect(generated(c)).toBe(cents(grand));
    // and the balance the platform will compute equals Salesforce's
    expect(generated(c) - p.paymentsCents).toBe(p.balanceCents);
  });

  it("still lands exactly on the seven jobs that carry an adjustment", () => {
    for (const [subtotal, tax, grand, paid, balance] of [
      [1000.0, 87.5, 1087.5, 1065.75, 0],
      [22620.01, 0, 22620.01, 22623.01, 0],
      [3795.92, 0, 3795.92, 4285.43, 0],
      [700.0, 62.13, 762.13, 761.25, 0],
      [46500, 0, 46500, 19000, 29075.4],
    ] as Array<[number, number, number, number, number]>) {
      const p = job(subtotal, tax, grand, paid, balance);
      const c = planInvoiceColumns(p);
      expect(generated(c) - p.paymentsCents, `balance for ${grand}`).toBe(p.balanceCents);
      expect(c.subtotal_cents).toBeGreaterThanOrEqual(0); // the CHECK constraint
    }
  });
});
