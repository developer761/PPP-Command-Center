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

/**
 * When an invoice is due, from the terms Salesforce recorded on the job.
 *
 * All 92 of Tomco's invoices carry "Upon Receipt", which means exactly what it
 * says: due the day it was issued. That makes the older ones months past due —
 * which is TRUE, and is the whole reason AR aging exists. Without a due date
 * nothing can age, and the aging report reads a healthy "$0 overdue" over a
 * book that is entirely late.
 *
 * Net terms are honoured where Tomco used them; anything unrecognised falls
 * back to the platform's own 30 days rather than being left undated, because an
 * undated invoice is invisible to every collections surface.
 *
 * Returns a bare YYYY-MM-DD; the caller anchors it for the timestamp column.
 */
export function dueDateFor(issuedYmd: string | null, terms: string | null | undefined): string | null {
  if (!issuedYmd) return null;
  const t = (terms ?? "").trim().toLowerCase();
  if (/upon\s*receipt|due\s*on\s*receipt|^cod$|cash\s*on\s*delivery/.test(t)) return issuedYmd;
  const net = /net\s*(\d{1,3})/.exec(t);
  const days = net ? Number(net[1]) : 30;
  const d = new Date(`${issuedYmd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A Salesforce address → the four columns the platform stores.
 *
 * `Estimation_Address__c` is a COMPOUND address field: jsforce hands it back as
 * an object, and assigning it straight to a text column stringifies it. 44 of
 * Tomco's 132 deals ended up with this on the deal's Info tab, under "Street":
 *
 *   {"city":"Glen Head","country":"United States","countryCode":"US",
 *    "geocodeAccuracy":null,"latitude":null,"longitude":null,"postalCode":…}
 *
 * — and their city, state and zip columns were left empty, so those jobs were
 * also missing from the Geography report. The parts were there the whole time;
 * nothing read them.
 */
export type SfAddress = {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
} | string | null | undefined;

export function addressParts(value: SfAddress): {
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const empty = { street: null, city: null, state: null, zip: null };
  if (!value) return empty;

  // A plain string is already the street line — that is what WorkOrder.Street
  // gives, and it must keep working exactly as it did.
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return empty;
    if (!t.startsWith("{")) return { ...empty, street: t };
    try {
      return addressParts(JSON.parse(t) as SfAddress);
    } catch {
      // Unparseable: keep the text rather than losing the address entirely.
      return { ...empty, street: t };
    }
  }

  const clean = (v: unknown) => {
    const t = typeof v === "string" ? v.trim() : "";
    return t || null;
  };
  return {
    street: clean(value.street),
    city: clean(value.city),
    // Two-letter code where Salesforce has one — "NY" is what every address
    // on the platform is written with.
    state: clean(value.stateCode) ?? clean(value.state),
    zip: clean(value.postalCode),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The same cheque, banked twice
// ─────────────────────────────────────────────────────────────────────────────

export type ExistingPayment = {
  id: string;
  invoice_id: string;
  amount_cents: number;
  paid_at: string | null;
  reference: string | null;
};

export type IncomingPayment = {
  amount_cents: number;
  paid_at: string | null;
  reference: string | null;
};

export type PaymentMatch =
  /** Nothing here looks like it — a normal insert. */
  | { kind: "insert" }
  /** This row IS it. Adopt rather than banking the money a second time. */
  | { kind: "adopt"; row: ExistingPayment }
  /** Looks like it, but something is off. Report; never guess with money. */
  | { kind: "ask"; row: ExistingPayment | null; why: string };

/**
 * Has this Salesforce payment already been recorded here by a person?
 *
 * During the dual run Mary enters a payment in BOTH systems. The importer then
 * inserts Salesforce's copy, because the row she typed carries no Salesforce id
 * and nothing looked for one — so the invoice shows the money twice. Found
 * 2026-10-13: 12 payments, $42,874.63 counted double, ten of them carrying the
 * same cheque number on both copies.
 *
 * It fails the dangerous way. Paid twice drives the balance negative, the job
 * reads as settled, it drops off AR, and nobody chases it.
 *
 * `existing` is every payment on the JOB, not just the one invoice — because
 * the worst case in the book hid across two. J. Carleton Environmental Center
 * is invoiced $23,235.70 by Salesforce and another $11,617.85 by an invoice
 * raised here, with the same $11,617.85 payment recorded against each.
 *
 * Deliberately conservative: this says "ask" far more readily than "adopt",
 * because a wrong adopt MERGES two real payments and loses cash, which is worse
 * than the duplicate it was trying to prevent.
 */
export function matchExistingPayment(
  existing: ExistingPayment[],
  incoming: IncomingPayment,
  invoiceId: string,
): PaymentMatch {
  /*
   * THE DAY IS THE WEAK SIGNAL. THE CHEQUE NUMBER IS THE STRONG ONE.
   *
   * The first version had this backwards: it selected candidates on (amount,
   * day) and used the reference only as a veto. Ten of the twelve duplicates
   * this function was written from carried the SAME cheque number on both
   * copies — while the dates are typed by hand and drift routinely, because a
   * bookkeeper records a cheque dated the 6th on the 8th. Keyed on the day, a
   * cheque recorded two days late finds nothing and is banked a second time:
   * the exact failure, in its most likely form.
   *
   * So a candidate is the same money that agrees on EITHER the day or the
   * cheque number, and the decision below needs real corroboration before it
   * will adopt.
   *
   * And the day is an EASTERN day. `paid_at` is TIMESTAMPTZ; most writers
   * anchor it to noon ET, but `lib/commercial/invoices/db.ts` falls back to
   * `new Date()` when the date field is left blank, so some rows hold a true
   * instant. `.slice(0, 10)` on one of those is a UTC day — anything recorded
   * after 8pm ET reads as tomorrow and misses. `ymd` does the ET conversion
   * that the rest of this file already relies on.
   */
  const ref = (v: string | null | undefined) => String(v ?? "").trim().toLowerCase();
  const sameDay = (a: string | null | undefined, b: string | null | undefined) => {
    const x = ymd(a), y = ymd(b);
    return x !== null && y !== null && x === y;
  };
  /** Whole days between two payments, or null if either has no usable date. */
  const daysApart = (a: string | null | undefined, b: string | null | undefined) => {
    const x = ymd(a), y = ymd(b);
    if (x === null || y === null) return null;
    return Math.abs(Date.parse(`${x}T12:00:00Z`) - Date.parse(`${y}T12:00:00Z`)) / 86_400_000;
  };
  /*
   * `reference` IS A MEMO BOX, NOT AN IDENTIFIER.
   *
   * The recording form writes the "other method" free text into this same
   * column (`joinOtherDetail(method_other, reference)`), so it holds "ACH",
   * "Labr Reimbursement", "PPP reimbursed Tomco for Labor", "Inv#312838" —
   * 20 of 133 live values are not cheque-like at all. Worse, 32 distinct values
   * are shared by more than one payment: 530812 is a batch cheque covering five
   * payments across four jobs.
   *
   * An earlier version of this matched on the reference alone, unbounded in
   * time, on the grounds that ten of the twelve known duplicates shared a
   * cheque number. That is a statement about RECALL and says nothing about
   * PRECISION — and the precision is what this data refuses. VCA Commack has
   * two genuine $15,000 draws, 2026-01-15 and 2026-03-19, on one invoice, both
   * carrying the GC's PO number "00268853". Matching on the reference merges
   * them, which deletes a real payment.
   *
   * So the reference may only RESCUE a near-miss on the date — the bookkeeper
   * recording a cheque a few days after it was dated, which is the case worth
   * catching — and only when it looks like a cheque number rather than prose.
   */
  const CHEQUE_LIKE = /^#?\d{3,10}$/;
  const REFERENCE_RESCUE_DAYS = 5;

  const incomingRef = ref(incoming.reference);
  const refsLookLikeTheSameCheque = (mineRef: string) =>
    mineRef !== "" &&
    incomingRef !== "" &&
    mineRef === incomingRef &&
    CHEQUE_LIKE.test(mineRef);

  const candidates = existing.filter((p) => {
    if (p.amount_cents !== incoming.amount_cents) return false;
    if (sameDay(p.paid_at, incoming.paid_at)) return true;
    if (!refsLookLikeTheSameCheque(ref(p.reference))) return false;
    const gap = daysApart(p.paid_at, incoming.paid_at);
    return gap !== null && gap <= REFERENCE_RESCUE_DAYS;
  });

  if (candidates.length === 0) return { kind: "insert" };
  // SEVERAL IS NOT NONE. Returning "insert" here — which an early version did,
  // by collapsing both into a single null — adds a THIRD copy of the money, the
  // one outcome this function exists to prevent.
  if (candidates.length > 1) {
    return { kind: "ask", row: null, why: `matches ${candidates.length} payments already on this job — too alike to tell apart` };
  }

  const mine = candidates[0];
  const mineRef = ref(mine.reference);
  const refsAgree = mineRef !== "" && incomingRef !== "" && mineRef === incomingRef;
  const refsConflict = mineRef !== "" && incomingRef !== "" && mineRef !== incomingRef;

  // Both name a cheque and they disagree: two cheques for one amount on one day
  // is unusual, not impossible. Only the bookkeeper can say.
  if (refsConflict) {
    return { kind: "ask", row: mine, why: `the references differ (${mine.reference} vs ${incoming.reference})` };
  }
  // Same money on a DIFFERENT invoice means the JOB is billed twice, and the
  // payment is only the symptom. Adopting would move the person's payment onto
  // Salesforce's invoice and leave theirs unpaid — a worse lie than the
  // duplicate, and the same shape as deleting a payment to fix a deposit total.
  if (mine.invoice_id !== invoiceId) {
    return { kind: "ask", row: mine, why: "already recorded here against a DIFFERENT invoice — the job looks billed twice" };
  }
  /*
   * NEITHER SIDE NAMES A CHEQUE, AND THE DAYS DISAGREE.
   *
   * Reachable only through the reference arm of the filter, so this is
   * defensive — but the rule it states is the one that matters: adopting needs
   * evidence beyond the amount. Two equal draws landing on one invoice
   * (progress plus a retainage release) are ordinary, so amount alone merges
   * real money.
   */
  if (!refsLookLikeTheSameCheque(mineRef) && !sameDay(mine.paid_at, incoming.paid_at)) {
    return { kind: "ask", row: mine, why: "same amount but a different day and no shared cheque number — not enough to call it the same payment" };
  }
  void refsAgree;
  return { kind: "adopt", row: mine };
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

/* ───────────────────────────────────────────────────────────────────────────
 * COSTS ENTERED HERE, AND THE SAME COST ARRIVING FROM SALESFORCE.
 *
 * Mary records job costs in the Commercial Command Center. That is correct and
 * wanted — it is the platform going forward. The problem was never her entries;
 * it is that the SAME purchase also sits in Salesforce, and the importer, which
 * only ever asked "is this Salesforce id mapped yet?", answered no and inserted
 * a second row. Five pairs were live on 2026-10-14, and the list grew by one
 * while that day's work was going on, because nothing stops it recurring.
 *
 * Deleting one side was the wrong instinct. Both rows are real records of one
 * real purchase, and deleting Mary's throws away the entry she was right to
 * make. So the importer ADOPTS instead: it recognises her row as this
 * Salesforce transaction and maps the two together. One row, one cost, and the
 * link that keeps the two systems reconcilable.
 *
 * Mirrors matchExistingPayment deliberately — same three answers, same reasons.
 * ─────────────────────────────────────────────────────────────────────────── */

export type ExistingPurchase = {
  id: string;
  vendor: string | null;
  amount_cents: number;
  purchased_at: string | null;
  /** A row the importer already owns cannot be adopted by a second one. */
  mapped: boolean;
};

export type IncomingPurchase = {
  vendor: string | null;
  amount_cents: number;
  purchased_at: string | null;
};

export type PurchaseMatch =
  | { kind: "insert"; why: string }
  | { kind: "adopt"; row: ExistingPurchase; why: string }
  | { kind: "ask"; row: ExistingPurchase | null; why: string };

/**
 * How far apart the two systems date the same purchase.
 *
 * Measured on the real pairs: 0 to 3 days. A receipt is logged in one system
 * the day it is spent and in the other when somebody gets to it.
 */
const PURCHASE_WINDOW_DAYS = 3;

/**
 * Whole days between two timestamps, as EASTERN days.
 *
 * The same reasoning as the payment matcher's local copy: `purchased_at` is
 * TIMESTAMPTZ, and a `.slice(0, 10)` on a true instant reads as tomorrow for
 * anything recorded after 8pm ET. `ymd` does the conversion the rest of this
 * file relies on. Module-scoped because the payment version is trapped inside
 * its own function, and two subtly different day definitions in one file is how
 * one of these quietly stops agreeing with the other.
 */
function daysApart(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = ymd(a), y = ymd(b);
  if (x === null || y === null) return null;
  return Math.abs(Date.parse(`${x}T12:00:00Z`) - Date.parse(`${y}T12:00:00Z`)) / 86_400_000;
}

/**
 * The vendor, reduced to what both systems agree on.
 *
 * Salesforce holds the sub as "Peter-Profinish" and the app as
 * "Peter - Profinish" — the same person, two spellings, and a trim-and-lowercase
 * comparison puts them in different buckets. That one difference hid a $2,400
 * duplicate through an entire cleanup.
 */
function normaliseVendor(v: string | null | undefined): string {
  return String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function matchExistingPurchase(
  existing: ExistingPurchase[],
  incoming: IncomingPurchase,
): PurchaseMatch {
  const want = normaliseVendor(incoming.vendor);
  // A blank vendor on either side is not a match — it is an absence. Adopting
  // on (amount, date) alone would merge two unrelated receipts for the same
  // money on one job in one week, which is a thing that happens.
  if (!want) return { kind: "insert", why: "no vendor to match on" };
  if (!incoming.purchased_at) return { kind: "insert", why: "no date to match on" };

  const candidates = existing.filter((p) => {
    if (p.mapped) return false;                       // already another transaction's
    if (p.amount_cents !== incoming.amount_cents) return false;
    if (normaliseVendor(p.vendor) !== want) return false;
    const gap = daysApart(p.purchased_at, incoming.purchased_at);
    return gap !== null && gap <= PURCHASE_WINDOW_DAYS;
  });

  if (candidates.length === 0) {
    return { kind: "insert", why: "nothing here matches this purchase" };
  }
  if (candidates.length > 1) {
    /*
     * Two unmapped rows for the same vendor, amount and week. They might be two
     * genuine receipts — a crew buying the same thing twice is ordinary — so
     * adopting one at random would silently attach the Salesforce record to
     * whichever sorted first and leave the other orphaned. A person decides.
     */
    return {
      kind: "ask",
      row: null,
      why: `${candidates.length} rows here match this vendor and amount within ${PURCHASE_WINDOW_DAYS} days`,
    };
  }
  const row = candidates[0];
  const gap = daysApart(row.purchased_at, incoming.purchased_at) ?? 0;
  return {
    kind: "adopt",
    row,
    why:
      gap === 0
        ? "already recorded here on the same day"
        : `already recorded here ${gap} day${gap === 1 ? "" : "s"} ${
            (row.purchased_at ?? "") < (incoming.purchased_at ?? "") ? "earlier" : "later"
          }`,
  };
}
