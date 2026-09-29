/**
 * What does the customer owe right now, milestone by milestone?
 *
 * Pure — no Salesforce, no Stripe, no database — so every rule here is tested
 * on numbers (see __tests__/payments/schedule.test.ts), including the real
 * Work Order that started this: 00313399.
 *
 * WHERE THE NUMBERS COME FROM
 *   - Milestones: the Work Order's Payment_Term__c rows (Deposit / Progress /
 *     Final), ordered by Order__c. Amount__c is maintained by PPP's
 *     PaymentTerm_SetAmountByPercent flow.
 *   - What is still owed: WorkOrder.BalanceOwed__c — the same number the S-Docs
 *     invoice prints as "Remaining Balance".
 *
 * WHY NOT Payment_Term__c.Unpaid_Amount__c / Paid_In_Full__c
 *   Those fields exist and look made for this, but nothing maintains them:
 *   across the 6,158 terms created in the last 120 days, zero have
 *   Unpaid_Amount__c set and zero are marked Paid_In_Full__c — including on
 *   Work Orders that ARE paid in full. Reading them would show every milestone
 *   as unpaid forever. So payments are applied here, in order, the way the
 *   office reads the invoice: the first dollars in pay the Deposit, then
 *   Progress, then Final.
 *
 * WHAT IS NOT DECIDED YET (open with PPP)
 *   - When Progress becomes "due". Today: the earliest unpaid milestone is due,
 *     everything after it is upcoming. The customer can always choose to pay
 *     the full balance instead.
 */

/** 3.00% — the rate printed on every PPP invoice ("Credit Card Service Fee (3.00%)"). */
export const CARD_FEE_BPS = 300;

export type PaymentTermInput = {
  /** Payment_Term__c.Id */
  id: string;
  /** Payment_Term__c.Payment_Type__c — 'Deposit' | 'Progress' | 'Final' (or anything PPP adds later). */
  type: string | null;
  /** Payment_Term__c.Order__c */
  order: number | null;
  /** Payment_Term__c.Amount__c in dollars. */
  amount: number | null;
  /** Payment_Term__c.Percent__c (30 = 30%) when Value_Type__c is 'Percent'. Shown to
   *  the customer so "Deposit" reads as "Deposit · 30% of the job". */
  percent?: number | null;
  /** Payment_Term__c.Paid_In_Full__c — set by online payments (see
   *  buildPaymentTermUpdates). Display only; what is owed still comes from the
   *  balance, because manual payments never set it. */
  paidInFull?: boolean;
};

export type MilestoneStatus =
  /** Fully covered by payments Salesforce already knows about. */
  | "paid"
  /** Covered only once in-flight online payments land (ACH clearing, or a
   *  succeeded payment not yet written to Salesforce). Not payable again. */
  | "processing"
  /** The earliest milestone with money still owed. Payable. */
  | "due"
  /** Later milestones. Shown, not offered, unless paying the full balance. */
  | "upcoming";

export type Milestone = {
  /** Payment_Term__c Id, or 'extra' for charges beyond the payment terms. */
  key: string;
  label: string;
  /** Share of the job this milestone is, e.g. 30. Null for dollar-amount terms and extras. */
  percent: number | null;
  amountCents: number;
  /** Still owed after confirmed AND in-flight payments. What a button would charge. */
  remainingCents: number;
  status: MilestoneStatus;
  /** Some, but not all, of this milestone has been paid. */
  partlyPaid: boolean;
};

export type PaymentSchedule = {
  milestones: Milestone[];
  /** Sum of the payment terms. */
  termsTotalCents: number;
  /** BalanceOwed__c, floored at 0. */
  balanceCents: number;
  /** In-flight online payments not yet reflected in the balance. */
  inFlightCents: number;
  /** What "Pay full balance" would charge: balance less in-flight. */
  payableBalanceCents: number;
  /** Anything the page should say out loud rather than silently absorb. */
  warnings: string[];
};

export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * The card service fee on a base amount, rounded to the cent the same way the
 * S-Docs invoice does (half up): $2,830.75 → $84.92, $4,529.20 → $135.88.
 */
export function cardFeeCents(baseCents: number, rateBps: number = CARD_FEE_BPS): number {
  if (baseCents <= 0) return 0;
  return Math.round((baseCents * rateBps) / 10_000);
}

export function buildPaymentSchedule(input: {
  terms: PaymentTermInput[];
  /** WorkOrder.BalanceOwed__c in dollars. */
  balanceOwed: number | null;
  /** Cents of online payments that have not reached Salesforce's balance yet. */
  inFlightCents?: number;
}): PaymentSchedule {
  const warnings: string[] = [];

  const terms = [...input.terms]
    .map((t, i) => ({ ...t, amountCents: toCents(t.amount ?? 0), idx: i }))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.idx - b.idx);

  const dropped = terms.filter((t) => t.amountCents <= 0);
  if (dropped.length) {
    warnings.push(
      `${dropped.length} payment term${dropped.length === 1 ? " has" : "s have"} no amount in Salesforce and ${dropped.length === 1 ? "is" : "are"} not shown.`,
    );
  }
  const live = terms.filter((t) => t.amountCents > 0);

  const termsTotalCents = live.reduce((s, t) => s + t.amountCents, 0);
  const rawBalance = input.balanceOwed == null ? null : toCents(input.balanceOwed);
  if (rawBalance == null) warnings.push("Salesforce has no balance for this Work Order.");
  if (rawBalance != null && rawBalance < 0) {
    warnings.push(`Salesforce shows a credit of ${formatCents(-rawBalance)} — the customer has overpaid.`);
  }
  const balanceCents = Math.max(0, rawBalance ?? 0);
  const inFlightCents = Math.max(0, Math.min(input.inFlightCents ?? 0, balanceCents));

  // Charges beyond the payment terms (a change order or billable materials
  // that never got a term). Owed, so shown — as its own line, due last, rather
  // than silently stretched across the milestones.
  const extraCents = Math.max(0, balanceCents - termsTotalCents);
  if (extraCents > 0) {
    warnings.push(
      `The balance is ${formatCents(extraCents)} more than the payment terms add up to — shown as "Additional charges".`,
    );
  }
  const rows = [
    ...live.map((t) => ({
      key: t.id,
      label: t.type?.trim() || "Payment",
      percent: typeof t.percent === "number" && t.percent > 0 ? t.percent : null,
      amountCents: t.amountCents,
    })),
    ...(extraCents > 0 ? [{ key: "extra", label: "Additional charges", percent: null, amountCents: extraCents }] : []),
  ];
  const rowsTotal = termsTotalCents + extraCents;

  // Dollars already paid toward these rows, applied first-milestone-first.
  let confirmed = Math.max(0, rowsTotal - balanceCents);
  let inFlight = inFlightCents;
  let dueAssigned = false;

  const milestones: Milestone[] = rows.map((r) => {
    const fromConfirmed = Math.min(confirmed, r.amountCents);
    confirmed -= fromConfirmed;
    const fromInFlight = Math.min(inFlight, r.amountCents - fromConfirmed);
    inFlight -= fromInFlight;
    const remainingCents = r.amountCents - fromConfirmed - fromInFlight;

    let status: MilestoneStatus;
    if (remainingCents === 0) status = fromInFlight > 0 ? "processing" : "paid";
    else if (!dueAssigned) {
      status = "due";
      dueAssigned = true;
    } else status = "upcoming";

    return {
      key: r.key,
      label: r.label,
      percent: r.percent,
      amountCents: r.amountCents,
      remainingCents,
      status,
      partlyPaid: remainingCents > 0 && remainingCents < r.amountCents,
    };
  });

  return {
    milestones,
    termsTotalCents,
    balanceCents,
    inFlightCents,
    payableBalanceCents: balanceCents - inFlightCents,
    warnings,
  };
}

export type ChargeQuote = {
  milestoneKey: string;
  label: string;
  method: "card" | "ach";
  baseCents: number;
  feeCents: number;
  totalCents: number;
};

/**
 * What one button charges. Returns null when that milestone is not payable
 * right now — the checkout route refuses rather than charging a stale or
 * already-paid amount.
 *
 * 'balance' pays everything still owed. Otherwise only the milestone marked
 * "due" is payable; paying an upcoming one out of order would leave an earlier
 * milestone open with a later one paid, which is not how the office reads it.
 */
export function quoteCharge(
  schedule: PaymentSchedule,
  milestoneKey: string,
  method: "card" | "ach",
): ChargeQuote | null {
  let baseCents: number;
  let label: string;
  if (milestoneKey === "balance") {
    baseCents = schedule.payableBalanceCents;
    label = "Full balance";
  } else {
    const m = schedule.milestones.find((x) => x.key === milestoneKey);
    if (!m || m.status !== "due") return null;
    baseCents = m.remainingCents;
    label = m.label;
  }
  // Stripe's minimum charge is $0.50.
  if (baseCents < 50) return null;
  const feeCents = method === "card" ? cardFeeCents(baseCents) : 0;
  return { milestoneKey, label, method, baseCents, feeCents, totalCents: baseCents + feeCents };
}

/**
 * Which cards carry the 3% fee. PPP's invoice: "Cash, check, Zelle, bank
 * transfer, and debit card payments are not subject to the fee."
 *
 *   credit  → fee
 *   debit   → no fee
 *   prepaid → no fee (it is not credit; pending PPP confirming)
 *   unknown → no fee. Stripe reports 'unknown' when the issuer doesn't say.
 *             Charging a debit card the fee is the mistake this exists to
 *             prevent, so the benefit of the doubt goes to the customer
 *             (pending PPP confirming).
 */
export type CardFunding = "credit" | "debit" | "prepaid" | "unknown";

export function normalizeFunding(raw: string | null | undefined): CardFunding {
  return raw === "credit" || raw === "debit" || raw === "prepaid" ? raw : "unknown";
}

export function cardCarriesFee(funding: CardFunding): boolean {
  return funding === "credit";
}

/**
 * What a card payment charges once the card is known. Same payability rules as
 * quoteCharge — only the 'due' milestone or 'balance' — with the fee decided
 * by the card rather than by the button.
 */
export function quoteCardCharge(
  schedule: PaymentSchedule,
  milestoneKey: string,
  funding: CardFunding,
): (ChargeQuote & { funding: CardFunding }) | null {
  const base = quoteCharge(schedule, milestoneKey, "ach");
  if (!base) return null;
  const feeCents = cardCarriesFee(funding) ? cardFeeCents(base.baseCents) : 0;
  return { ...base, method: "card", feeCents, totalCents: base.baseCents + feeCents, funding };
}

/**
 * Which Payment_Term__c records a successful online payment completes, and what
 * to write on each — so Salesforce shows "Deposit: paid" on the term itself,
 * not only as a Transaction on the Work Order.
 *
 * A milestone payment always pays that milestone's whole remaining amount (the
 * pay page offers nothing smaller), so it completes exactly that term. A
 * full-balance payment completes the terms that still had money owing WHEN THE
 * CUSTOMER PAID (`coveredTermIds`, captured at checkout) — not every open term:
 * a Deposit paid weeks ago by check is still unmarked in Salesforce, and must
 * not be stamped as paid today by this payment (found in test 2026-09-29).
 * 'Additional charges' is not a term, so it writes nothing.
 */
export type PaymentTermUpdate = {
  id: string;
  fields: { Paid_In_Full__c: true; Paid_In_Full_Date__c: string; Unpaid_Amount__c: 0 };
};

export function buildPaymentTermUpdates(input: {
  milestoneKey: string;
  terms: Array<{ id: string; paidInFull?: boolean }>;
  /** For 'balance': the terms still owing when the customer paid. Missing
   *  (an older payment) falls back to every open term. */
  coveredTermIds?: string[] | null;
  /** YYYY-MM-DD, Eastern. */
  paidDateEt: string;
}): PaymentTermUpdate[] {
  const fields = { Paid_In_Full__c: true, Paid_In_Full_Date__c: input.paidDateEt, Unpaid_Amount__c: 0 } as const;
  const open = input.terms.filter((t) => !t.paidInFull);
  const covered =
    input.milestoneKey === "balance"
      ? input.coveredTermIds
        ? open.filter((t) => input.coveredTermIds!.includes(t.id))
        : open
      : open.filter((t) => t.id === input.milestoneKey);
  return covered.map((t) => ({ id: t.id, fields: { ...fields } }));
}

/**
 * The Payment_Term__c ids a payment for `milestoneKey` covers, as of now —
 * stored on the Stripe payment so the Salesforce write later marks exactly
 * these. Comma-joined for Stripe metadata (500-char values; a term id is 18).
 */
export function coveredTermIds(schedule: PaymentSchedule, milestoneKey: string): string {
  const ids =
    milestoneKey === "balance"
      ? schedule.milestones.filter((m) => m.key !== "extra" && m.remainingCents > 0).map((m) => m.key)
      : schedule.milestones.filter((m) => m.key === milestoneKey && m.key !== "extra").map((m) => m.key);
  return ids.join(",").slice(0, 500);
}
