import { describe, expect, it } from "vitest";
import {
  buildPaymentSchedule,
  buildPaymentTermUpdates,
  cardFeeCents,
  coveredTermIds,
  formatCents,
  normalizeFunding,
  quoteCardCharge,
  quoteCharge,
  type PaymentTermInput,
} from "@/lib/payments/schedule";

// WO 00313399 as Salesforce holds it (read 2026-09-23): 30/50/20 terms on a
// $5,661.50 job, one $1,132.30 payment in, so BalanceOwed was $4,529.20 on the
// invoice dated 9/18.
const TERMS_00313399: PaymentTermInput[] = [
  { id: "a04Wj00000NjsLbIAJ", type: "Final", order: 3, amount: 1132.3 },
  { id: "a04Wj00000NjsLZIAZ", type: "Deposit", order: 1, amount: 1698.45 },
  { id: "a04Wj00000NjsLaIAJ", type: "Progress", order: 2, amount: 2830.75 },
];

describe("cardFeeCents — matches the S-Docs invoice to the cent", () => {
  // Every figure below is printed on the 00313399 invoice PDF.
  it.each([
    [169845, 174940],
    [283075, 291567],
    [113230, 116627],
    [452920, 466508],
  ])("%i cents plus the card fee is %i", (base, total) => {
    expect(base + cardFeeCents(base)).toBe(total);
  });

  it("is zero on nothing", () => {
    expect(cardFeeCents(0)).toBe(0);
  });
});

describe("buildPaymentSchedule — WO 00313399", () => {
  const s = buildPaymentSchedule({ terms: TERMS_00313399, balanceOwed: 4529.2 });

  it("orders milestones by Order__c, not by the order Salesforce returned them", () => {
    expect(s.milestones.map((m) => m.label)).toEqual(["Deposit", "Progress", "Final"]);
  });

  it("applies the $1,132.30 already paid to the Deposit first", () => {
    const [dep, prog, fin] = s.milestones;
    expect(dep).toMatchObject({ status: "due", remainingCents: 56615, partlyPaid: true });
    expect(prog).toMatchObject({ status: "upcoming", remainingCents: 283075, partlyPaid: false });
    expect(fin).toMatchObject({ status: "upcoming", remainingCents: 113230 });
  });

  it("remaining milestones add back up to the invoice's Remaining Balance", () => {
    const sum = s.milestones.reduce((a, m) => a + m.remainingCents, 0);
    expect(sum).toBe(452920);
    expect(s.payableBalanceCents).toBe(452920);
    expect(s.warnings).toEqual([]);
  });

  it("quotes card and ACH for the due milestone with the fee only on card", () => {
    const dep = s.milestones[0].key;
    expect(quoteCharge(s, dep, "ach")).toMatchObject({ baseCents: 56615, feeCents: 0, totalCents: 56615 });
    expect(quoteCharge(s, dep, "card")).toMatchObject({ baseCents: 56615, feeCents: 1698, totalCents: 58313 });
  });

  it("the full-balance card quote is exactly the invoice's 'if paying by credit card' line", () => {
    expect(quoteCharge(s, "balance", "card")?.totalCents).toBe(466508);
    expect(quoteCharge(s, "balance", "ach")?.totalCents).toBe(452920);
  });

  it("refuses to quote a milestone that is not due", () => {
    expect(quoteCharge(s, s.milestones[1].key, "ach")).toBeNull();
    expect(quoteCharge(s, "a04-not-a-term", "ach")).toBeNull();
  });

  it("once paid in full, nothing is payable", () => {
    const paid = buildPaymentSchedule({ terms: TERMS_00313399, balanceOwed: 0 });
    expect(paid.milestones.every((m) => m.status === "paid")).toBe(true);
    expect(quoteCharge(paid, "balance", "card")).toBeNull();
    expect(paid.milestones.some((m) => quoteCharge(paid, m.key, "ach"))).toBe(false);
  });
});

describe("buildPaymentSchedule — in-flight payments cannot be paid twice", () => {
  it("an ACH still clearing covers the deposit and moves 'due' to Progress", () => {
    const s = buildPaymentSchedule({ terms: TERMS_00313399, balanceOwed: 4529.2, inFlightCents: 56615 });
    expect(s.milestones.map((m) => m.status)).toEqual(["processing", "due", "upcoming"]);
    expect(quoteCharge(s, s.milestones[0].key, "ach")).toBeNull();
    expect(s.payableBalanceCents).toBe(452920 - 56615);
  });

  it("in-flight larger than the balance cannot drive anything negative", () => {
    const s = buildPaymentSchedule({ terms: TERMS_00313399, balanceOwed: 100, inFlightCents: 999999 });
    expect(s.inFlightCents).toBe(10000);
    expect(s.payableBalanceCents).toBe(0);
    expect(s.milestones.every((m) => m.remainingCents >= 0)).toBe(true);
  });
});

describe("buildPaymentSchedule — data Salesforce gets wrong", () => {
  it("a balance above the terms becomes its own 'Additional charges' line, not a silent stretch", () => {
    const s = buildPaymentSchedule({ terms: TERMS_00313399, balanceOwed: 5661.5 + 250 });
    const extra = s.milestones.at(-1)!;
    expect(extra).toMatchObject({ key: "extra", label: "Additional charges", remainingCents: 25000 });
    expect(s.milestones.reduce((a, m) => a + m.remainingCents, 0)).toBe(591150);
    expect(s.warnings.join(" ")).toMatch(/\$250\.00 more/);
  });

  it("an overpayment shows as a warning and nothing is due", () => {
    const s = buildPaymentSchedule({ terms: TERMS_00313399, balanceOwed: -135.88 });
    expect(s.balanceCents).toBe(0);
    expect(s.warnings.join(" ")).toMatch(/credit of \$135\.88/);
    expect(s.milestones.every((m) => m.status === "paid")).toBe(true);
  });

  it("terms with no amount are dropped out loud", () => {
    const s = buildPaymentSchedule({
      terms: [...TERMS_00313399, { id: "x", type: "Progress", order: 4, amount: null }],
      balanceOwed: 4529.2,
    });
    expect(s.milestones).toHaveLength(3);
    expect(s.warnings[0]).toMatch(/1 payment term has no amount/);
  });

  it("no terms at all still lets the balance be paid", () => {
    const s = buildPaymentSchedule({ terms: [], balanceOwed: 1200 });
    expect(s.milestones).toEqual([
      expect.objectContaining({ key: "extra", status: "due", remainingCents: 120000 }),
    ]);
    expect(quoteCharge(s, "balance", "ach")?.baseCents).toBe(120000);
  });

  it("under Stripe's 50-cent minimum is not payable online", () => {
    const s = buildPaymentSchedule({ terms: [], balanceOwed: 0.4 });
    expect(quoteCharge(s, "balance", "card")).toBeNull();
  });
});

describe("formatCents", () => {
  it.each([
    [466508, "$4,665.08"],
    [5, "$0.05"],
    [-13588, "-$135.88"],
  ])("%i → %s", (c, s) => expect(formatCents(c)).toBe(s));
});

describe("quoteCardCharge — the fee follows the CARD, not the button", () => {
  const s = buildPaymentSchedule({ terms: TERMS_00313399, balanceOwed: 4529.2 });
  const dep = s.milestones[0].key;

  it("credit pays the 3%", () => {
    expect(quoteCardCharge(s, dep, "credit")).toMatchObject({ baseCents: 56615, feeCents: 1698, totalCents: 58313, method: "card" });
  });

  it.each(["debit", "prepaid", "unknown"] as const)("%s pays no fee", (funding) => {
    expect(quoteCardCharge(s, dep, funding)).toMatchObject({ baseCents: 56615, feeCents: 0, totalCents: 56615, method: "card", funding });
  });

  it("the full balance on a debit card is the invoice's no-fee Remaining Balance", () => {
    expect(quoteCardCharge(s, "balance", "debit")?.totalCents).toBe(452920);
    expect(quoteCardCharge(s, "balance", "credit")?.totalCents).toBe(466508);
  });

  it("same payability rules as bank payments — nothing not due", () => {
    expect(quoteCardCharge(s, s.milestones[1].key, "debit")).toBeNull();
  });

  it("normalizeFunding only trusts the three real values", () => {
    expect(normalizeFunding("credit")).toBe("credit");
    expect(normalizeFunding("debit")).toBe("debit");
    expect(normalizeFunding("prepaid")).toBe("prepaid");
    expect(normalizeFunding("CREDIT")).toBe("unknown");
    expect(normalizeFunding(null)).toBe("unknown");
    expect(normalizeFunding("unknown")).toBe("unknown");
  });
});

describe("percentages reach the customer", () => {
  it("each milestone carries its share of the job", () => {
    const s = buildPaymentSchedule({
      terms: [
        { id: "d", type: "Deposit", order: 1, amount: 1698.45, percent: 30 },
        { id: "p", type: "Progress", order: 2, amount: 2830.75, percent: 50 },
        { id: "f", type: "Final", order: 3, amount: 1132.3, percent: 20 },
      ],
      balanceOwed: 4529.2,
    });
    expect(s.milestones.map((m) => m.percent)).toEqual([30, 50, 20]);
  });

  it("a dollar-amount term and the extras line have no percent", () => {
    const s = buildPaymentSchedule({
      terms: [{ id: "d", type: "Deposit", order: 1, amount: 500, percent: null }],
      balanceOwed: 700,
    });
    expect(s.milestones.map((m) => m.percent)).toEqual([null, null]);
  });
});

describe("buildPaymentTermUpdates — Salesforce shows the TERM as paid", () => {
  const terms = [
    { id: "dep", paidInFull: true },
    { id: "prog", paidInFull: false },
    { id: "fin", paidInFull: false },
  ];
  const date = "2026-09-29";

  it("a milestone payment marks exactly that term paid", () => {
    expect(buildPaymentTermUpdates({ milestoneKey: "prog", terms, paidDateEt: date })).toEqual([
      { id: "prog", fields: { Paid_In_Full__c: true, Paid_In_Full_Date__c: date, Unpaid_Amount__c: 0 } },
    ]);
  });

  it("a full-balance payment marks every open term, and skips ones already paid", () => {
    expect(buildPaymentTermUpdates({ milestoneKey: "balance", terms, paidDateEt: date }).map((u) => u.id)).toEqual([
      "prog",
      "fin",
    ]);
  });

  it("full balance marks only the terms it covered — not a Deposit paid weeks ago by check", () => {
    const allOpen = [{ id: "dep" }, { id: "prog" }, { id: "fin" }];
    expect(
      buildPaymentTermUpdates({ milestoneKey: "balance", terms: allOpen, coveredTermIds: ["prog", "fin"], paidDateEt: date }).map(
        (u) => u.id,
      ),
    ).toEqual(["prog", "fin"]);
  });

  it("coveredTermIds: full balance = terms still owing now; a milestone = itself", () => {
    const s = buildPaymentSchedule({ terms: TERMS_00313399, balanceOwed: 5661.5 - 1698.45 });
    // Deposit fully paid by earlier money; Progress + Final still owing.
    expect(coveredTermIds(s, "balance")).toBe("a04Wj00000NjsLaIAJ,a04Wj00000NjsLbIAJ");
    expect(coveredTermIds(s, "a04Wj00000NjsLaIAJ")).toBe("a04Wj00000NjsLaIAJ");
    expect(coveredTermIds(s, "extra")).toBe("");
  });

  it("a term already marked paid is not written again", () => {
    expect(buildPaymentTermUpdates({ milestoneKey: "dep", terms, paidDateEt: date })).toEqual([]);
  });

  it("'Additional charges' is not a term — nothing to mark", () => {
    expect(buildPaymentTermUpdates({ milestoneKey: "extra", terms, paidDateEt: date })).toEqual([]);
  });
});
