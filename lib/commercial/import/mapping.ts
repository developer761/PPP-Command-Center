/**
 * Salesforce → Commercial: every mapping decision, as pure functions.
 *
 * The importer itself is a script that talks to two databases; nothing in it can
 * be unit-tested. These are the decisions that have to be RIGHT — what a status
 * becomes, how a job's money is built so the balance matches Salesforce to the
 * cent, which category a transaction lands in — so they live here, away from the
 * I/O, and the tests hold them.
 *
 * See docs/TOMCO_MIGRATION_PLAN.md. Karan's rule: every KPI and total lines up
 * to the cent.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Money. Salesforce stores dollars; the platform stores cents.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dollars → cents, without the floating-point drift that turns $1,087.50 into
 * 108749. Rounds half away from zero, like money does.
 */
export function cents(dollars: number | string | null | undefined): number {
  const n = typeof dollars === "string" ? Number(dollars) : dollars ?? 0;
  if (!Number.isFinite(n)) return 0;
  return Math.sign(n) * Math.round(Math.abs(n) * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

export type DealStatus = { status: string; subStatus: string };

/**
 * A Tomco work order's status → the deal's status and sub-status.
 *
 * "Complete Balance Owed" is the one worth reading twice: the work is done but
 * the money is not in, which is `billing`, not closed. Closing it would hide
 * $1.39M of what Tomco is owed.
 */
export function dealStatusForWorkOrder(woStatus: string | null | undefined): DealStatus {
  switch ((woStatus ?? "").trim()) {
    case "Closed":
    case "Complete Paid in Full":
      return { status: "post_sale_closed", subStatus: "closed" };
    case "Complete Balance Owed":
      return { status: "billing", subStatus: "completed_and_invoiced" };
    case "Work In Progress":
      return { status: "in_progress", subStatus: "wip_on_site" };
    case "On Hold":
      return { status: "in_progress", subStatus: "wip_on_hold" };
    case "Coordination":
    case "Pending":
      return { status: "pre_construction", subStatus: "coordination" };
    default:
      // An unmapped status must not silently become "qualifying" — the importer
      // reports these rather than guessing.
      return { status: "", subStatus: "" };
  }
}

/**
 * An open bid, placed by what Salesforce says has actually happened to it.
 *
 * Every open bid used to import as `proposal / sent`, which put a "Proposal
 * sent" pill on 9 deals Tomco has been assigned but not yet quoted — and the
 * deal page then said "No proposals yet" directly underneath it.
 *
 *   Estimate Sent        → the quote is out, waiting on the GC
 *   Opportunity Assigned → it is ours to price, nothing sent
 */
export function openBidStatus(stageName: string | null | undefined): DealStatus {
  switch ((stageName ?? "").trim()) {
    case "Estimate Sent":
      return { status: "proposal", subStatus: "sent" };
    case "Opportunity Assigned":
      return { status: "estimating", subStatus: "estimating" };
    default:
      return { status: "qualifying", subStatus: "rfp" };
  }
}

/** An open bid with no work order — kept for callers that have no stage. */
export const OPEN_BID_STATUS: DealStatus = { status: "proposal", subStatus: "sent" };

/**
 * A Tomco work order's status → the FIELD OPS job's status.
 *
 * A different vocabulary from the deal's, and a different question: not "where
 * is the money" but "is there crew work left". It matters because Field Ops
 * hides anything closed — the calendar, the Jobs page and the overview KPIs all
 * list only the open statuses. Importing all 92 jobs as `closed` (which is what
 * happened) left Brendan a calendar with nothing on it, including the jobs his
 * crews were standing on that morning.
 *
 * "Complete Balance Owed" is `complete`, not `closed`: the painting is done, so
 * it is off the schedule, but the job is not finished with.
 */
export function jobStatusForWorkOrder(woStatus: string | null | undefined):
  | "ready_to_schedule"
  | "in_progress"
  | "on_hold"
  | "complete"
  | "closed" {
  switch ((woStatus ?? "").trim()) {
    case "Work In Progress":
      return "in_progress";
    case "On Hold":
      return "on_hold";
    case "Coordination":
    case "Pending":
      return "ready_to_schedule";
    case "Complete Balance Owed":
      return "complete";
    case "Closed":
    case "Complete Paid in Full":
      return "closed";
    default:
      // An unknown status must not park real work on the calendar forever, nor
      // hide it. Closed is what Salesforce's own unmapped statuses have been.
      return "closed";
  }
}

export function isClosedWorkOrder(woStatus: string | null | undefined): boolean {
  const s = (woStatus ?? "").trim();
  return s === "Closed" || s === "Complete Paid in Full" || s === "Complete Balance Owed";
}

// ─────────────────────────────────────────────────────────────────────────────
// The money model (plan §3, §8)
// ─────────────────────────────────────────────────────────────────────────────

export type SfJobMoney = {
  /** Quoted_Subtotal_with_Change_Order__c — the contract, pre-tax. */
  quotedSubtotalWithCo: number;
  /** TotalChangeOrder__c — change-order value, already inside the subtotal. */
  totalChangeOrder: number;
  tax: number;
  grandTotal: number;
  totalPaymentsIn: number;
  balanceOwed: number;
};

export type InvoicePlan = {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paymentsCents: number;
  /**
   * What Salesforce says is still owed. The invoice must land here exactly.
   */
  balanceCents: number;
  /**
   * The gap between (total − payments) and Salesforce's balance, as a signed
   * adjustment to put ON the invoice so the two agree.
   *   negative → written off (short-paid, closed at zero)
   *   positive → owed beyond what the payments explain
   * Zero on 85 of the 92 jobs.
   */
  adjustmentCents: number;
  /** True when the customer paid MORE than the invoice — a credit, not a debt. */
  isOverpaid: boolean;
};

/**
 * Build one job's invoice so that `balance == Salesforce's BalanceOwed__c`, to
 * the cent, using the real payments.
 *
 * Karan, 2026-09-16: Salesforce's balance wins. It is the system Tomco runs on,
 * so the platform has to agree with what they see. Where the payments do not
 * explain that balance (7 jobs), the difference becomes a visible adjustment
 * line — a write-off or a credit — never a payment that never happened.
 */
export function planInvoice(m: SfJobMoney): InvoicePlan {
  const subtotalCents = cents(m.quotedSubtotalWithCo);
  const taxCents = cents(m.tax);
  // Salesforce's own grand total, not a recomputation: if SF's arithmetic
  // differs from subtotal+tax, the platform should show what Tomco sees.
  const totalCents = cents(m.grandTotal);
  const paymentsCents = cents(m.totalPaymentsIn);
  const balanceCents = cents(m.balanceOwed);
  const impliedBalance = totalCents - paymentsCents;
  return {
    subtotalCents,
    taxCents,
    totalCents,
    paymentsCents,
    balanceCents,
    adjustmentCents: balanceCents - impliedBalance,
    isOverpaid: paymentsCents > totalCents,
  };
}

/** What to call the adjustment on the invoice, so anyone reading it knows. */
export function adjustmentLabel(plan: InvoicePlan): string | null {
  if (plan.adjustmentCents === 0) return null;
  // Overpaid FIRST, and regardless of sign. A job paid beyond its invoice and
  // closed at zero produces a POSITIVE adjustment (the balance has to come back
  // up to zero), which read as "owed more than the payments explain" — the
  // opposite of what happened. 00271332 is that job: $4,285.43 paid against
  // $3,795.92 invoiced.
  if (plan.isOverpaid) return "Credit carried over from Salesforce (paid more than invoiced)";
  if (plan.adjustmentCents < 0) return "Written off in Salesforce (balance closed at zero)";
  return "Adjustment carried over from Salesforce (balance owed exceeds invoice less payments)";
}

/** Invoice status from the money, matching the platform's own rules. */
export function invoiceStatus(plan: InvoicePlan): "paid" | "partial" | "sent" {
  if (plan.balanceCents <= 0) return "paid";
  if (plan.paymentsCents > 0) return "partial";
  return "sent";
}

// ─────────────────────────────────────────────────────────────────────────────
// Costs
// ─────────────────────────────────────────────────────────────────────────────

export type SfTransactionKind = { recordType: string | null; payeeType: string | null };

/**
 * A Salesforce transaction → a purchase category the platform understands.
 *
 * `labor` is subcontract labor paid to a crew company — it is the cost figure
 * the job reports read. Attendance hours import separately and carry NO cost,
 * so the same money is never counted twice.
 */
export function purchaseCategory(t: SfTransactionKind): "materials" | "labor" | "other" | null {
  const rt = (t.recordType ?? "").trim();
  const payee = (t.payeeType ?? "").trim();
  if (rt === "Purchase") return "materials";
  if (rt === "Payment_Out") {
    if (payee === "Labor_Company") return "labor";
    // Reimbursements are a real cost, but not materials and not crew labor.
    return "other";
  }
  return null;
}

export function isReimbursement(t: SfTransactionKind): boolean {
  return (t.recordType ?? "") === "Payment_Out" && (t.payeeType ?? "") === "Reimbursement";
}

// ─────────────────────────────────────────────────────────────────────────────
// People
// ─────────────────────────────────────────────────────────────────────────────

/** "Greg Martinez" → the columns commercial_employees insists on. */
export function employeeFromCrewWorker(name: string): {
  first_name: string;
  last_name: string | null;
  display_name: string;
  worker_type: "sub";
  role: "painter";
  pay_type: "hourly";
} {
  const clean = name.trim().replace(/\s+/g, " ");
  const [first, ...rest] = clean.split(" ");
  return {
    first_name: first || clean || "Crew",
    last_name: rest.length ? rest.join(" ") : null,
    display_name: clean || "Crew",
    // Tomco's crew are paid through labor companies, not payroll: `sub`, and
    // deliberately no pay rate, so attendance never invents a labor cost on top
    // of the 790 payouts that already carry it.
    worker_type: "sub",
    role: "painter",
    pay_type: "hourly",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A Salesforce date or datetime → the YYYY-MM-DD the platform stores.
 *
 * A bare DATE is taken as-is: it has no time and no zone, and `new Date()` would
 * read it as UTC midnight and shift it a day backwards in Eastern time. A
 * datetime is converted to the Eastern calendar day, because that is the day
 * Tomco worked.
 */
export function ymd(sfValue: string | null | undefined): string | null {
  if (!sfValue) return null;
  const bare = /^(\d{4}-\d{2}-\d{2})$/.exec(sfValue.trim());
  if (bare) return bare[1];
  const d = new Date(sfValue);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  return parts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Turning the plan into the two columns the invoice actually stores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `commercial_invoices.total_cents` and `balance_cents` are GENERATED:
 *
 *   total   = subtotal_cents + ROUND(subtotal_cents * tax_pct / 100)
 *   balance = total - paid_cents
 *
 * So a balance cannot be written — it has to be CONSTRUCTED. Given the payments
 * (which are real) and the balance Salesforce states (which wins), the invoice
 * total has to come out at exactly `balance + payments`, and `tax_pct` is capped
 * at three decimals, so the rate has to be chosen to land on the cent rather
 * than assumed.
 *
 * Returns the two columns, plus `taxFolded` when no rate could reproduce
 * Salesforce's tax exactly and it was folded into the subtotal instead — the
 * import report names those jobs rather than letting the difference hide.
 */
export function planInvoiceColumns(plan: InvoicePlan): {
  subtotal_cents: number;
  tax_pct: number;
  taxFolded: boolean;
} {
  const totalTarget = plan.balanceCents + plan.paymentsCents;
  if (totalTarget <= 0) return { subtotal_cents: Math.max(0, totalTarget), tax_pct: 0, taxFolded: false };
  if (plan.taxCents <= 0) return { subtotal_cents: totalTarget, tax_pct: 0, taxFolded: false };

  // Postgres ROUND() on numeric rounds half away from zero; these are positive.
  const taxFor = (subtotal: number, pct: number) => Math.round((subtotal * pct) / 100);

  let subtotal = totalTarget - plan.taxCents;
  for (let attempt = 0; attempt < 4 && subtotal > 0; attempt++) {
    const pct = Math.round((plan.taxCents / subtotal) * 100 * 1000) / 1000; // 3 dp
    if (pct > 100) break;
    const computed = taxFor(subtotal, pct);
    if (subtotal + computed === totalTarget) return { subtotal_cents: subtotal, tax_pct: pct, taxFolded: false };
    // Move the subtotal by the miss and try again: the rate shifts slightly and
    // usually lands on the second pass.
    subtotal = totalTarget - computed;
  }
  // No rate reproduces it exactly. The TOTAL is what every report and every
  // customer sees, so keep that exact and fold the tax in, loudly.
  return { subtotal_cents: totalTarget, tax_pct: 0, taxFolded: true };
}
