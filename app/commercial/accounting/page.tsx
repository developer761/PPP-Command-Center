import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { normalizeRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getReceivablesReport, summarizeReceivables } from "@/lib/commercial/reports/receivables";
import { getCashFlowReport, EMPTY as EMPTY_CASH } from "@/lib/commercial/reports/cash-flow";
import { getJobCostsReport, COST_BUCKET_COLUMNS, type CostBuckets, EMPTY_JOB_COSTS } from "@/lib/commercial/reports/job-costs";
import { getChangeOrderVendorReport, EMPTY as EMPTY_CO } from "@/lib/commercial/reports/change-orders-vendors";
import { listProjects, summarizeProduction } from "@/lib/commercial/projects/db";
import { getArAging } from "@/lib/commercial/reports/ar-aging";
import { getTransactionsReport, setPaymentDeposited, type TxnFilters, type TxnDirection } from "@/lib/commercial/reports/transactions";
import { getSalesTaxReport } from "@/lib/commercial/reports/sales-tax";
import { getReimbursementsReport, setReimbursementSettled } from "@/lib/commercial/reports/reimbursements";
import { TransactionsLedger } from "@/components/commercial/transactions-ledger";
import { ACTIVITY_PRESETS, LEDGER_DEFAULT, activityRange, resolvePreset, type ActivityPreset } from "@/lib/commercial/reports/presets";
import { NavSelect, type NavChoice } from "@/components/commercial/nav-select";
import { setReceivableNote } from "@/lib/commercial/reports/receivables";
import { ReceivablesTable } from "@/components/commercial/receivables-table";
import { isLaborPaymentCategory } from "@/lib/commercial/purchases/constants";
import { SpendPeriodBar } from "@/components/commercial/spend-period-bar";
import {
  filterToSpendPeriod, undatedCount, isSpendPeriod, type SpendPeriodKey,
} from "@/lib/commercial/reports/tomco/spend-periods";
import { INPUT_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";
import { GroupedReport } from "@/components/commercial/grouped-report";
import { RecordPaymentForm, RecordLaborPaymentForm, RecordPurchaseForm } from "@/components/commercial/accounting-entry-forms";
import { PayrollWeekPanels, PayrollWeekHeader } from "@/components/commercial/payroll-week-panels";
import { getAccountingEntryOptions } from "@/lib/commercial/accounting/entry-options";
import { getBalanceOwedRows, BALANCE_OWED_SPEC } from "@/lib/commercial/reports/tomco/balance-owed";
import { costToolHref } from "@/lib/commercial/reports/tomco/accounting-links";
import { getArSheetRows, AR_APPLICATIONS_SPEC, AR_PERIODS, arPeriodCutoff } from "@/lib/commercial/reports/tomco/ar-applications";
import { AR_CARRYOVER, AR_CARRYOVER_AS_OF } from "@/lib/commercial/reports/tomco/ar-carryover";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  getSpendRows,
  getMoneyInRows,
  purchaseRows,
  laborPaymentRows,
  PURCHASES_BY_VENDOR_SPEC,
  LABOR_PAYMENTS_SPEC,
  DEPOSIT_HISTORY_SPEC,
} from "@/lib/commercial/reports/tomco/transactions";
import { ReceivablesFilterBar } from "@/components/commercial/receivables-filter-bar";
import {
  parseReceivableQuery, filtersFor, receivableQueryParams, receivableQueryString,
  describeReceivableQuery,
} from "@/lib/commercial/reports/receivables-filters";
import { ExportCsvLink } from "@/components/commercial/export-csv-link";
import { sendReceivablesToAlex, receivablesRecipients } from "@/lib/commercial/reports/receivables-email";
import { formatCentsFull, formatCentsCompact, fmtEtDate } from "@/lib/commercial/invoices/format";
import type { ReceivableKind } from "@/lib/commercial/reports/receivables";
import { joinOtherDetail } from "@/lib/commercial/forms/other-detail";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/kanban-columns";
import { PrintButton } from "@/components/commercial/reports/print-button";
import { PrintSheetStyles, PrintHeader } from "@/components/commercial/print-sheet";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { DepositCheckbox } from "@/components/commercial/deposit-checkbox";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { DonutChart, type DonutSegment, type ChartTone } from "@/components/commercial/charts";
import {
  cashFlowRange, CASH_FLOW_DEFAULT, changeOrderRange, CHANGE_ORDER_DEFAULT,
} from "@/lib/commercial/reports/presets";
import TrendChart from "@/components/trend-chart";
import { ACCOUNTING_VIEWS, type AccountingView } from "@/lib/commercial/accounting/tabs";

export const dynamic = "force-dynamic";

/**
 * The browser prints the page TITLE in its own header, above anything we draw.
 *
 * It read "PPP Command Center" on every sheet, so an AR sheet sent to a
 * bookkeeper arrived headed with the name of the software. Naming the tab after
 * the report makes that line useful instead — and it is also what the browser
 * offers as the filename when you Save as PDF, which is why Karan's copy landed
 * as "PPP Command Center.pdf" rather than anything he could file.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const view = pickFirst(sp.view) ?? "overview";
  const label = VIEWS.find((v) => v.key === view)?.label ?? "Accounting";
  return { title: `Tomco Painting - ${label}` };
}

/** FormData gives FormDataEntryValue | null; the helpers want a string. */
const str = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v : "");

const BASE = "/commercial/accounting";

/**
 * ACCOUNTING — the money desk. Karan, 2026-08-19: *"maybe have a separate
 * Accounting Page with this plus other important things that Alex would need
 * to see."*
 *
 * Deliberately NOT another Reports tab. Reports is per-topic analysis: you
 * arrive already knowing which question you have and pick the report that
 * answers it. This page is for the person who has no specific question yet —
 * Alex on his phone in the morning, Mary at the start of the day — and needs
 * "where do we stand" without choosing a report first.
 *
 * So it is ordered the way the money actually moves, not by report:
 *
 *   1. The brief        — one read, in words.
 *   2. What's owed us   — outstanding, collectible, late, retention held.
 *   3. What came in     — collected, how fast, cash per month.
 *   4. What's out       — the top receivables, biggest first.
 *   5. Not yet billed   — money earned but never invoiced. The one thing
 *                         nowhere else on the platform surfaces, and the
 *                         fastest cash in the building.
 *   6. Where it went    — cost mix and margin.
 *
 * Every block links to the report that owns the detail. Nothing here is a
 * second implementation of a figure: each number comes from the same helper
 * the report uses, so this page and that report can never disagree.
 *
 * Gated to admin + account manager (margin, cost, and AR are not rep data).
 * The sidebar hides the link on the same predicate so a rep is never offered a
 * page that bounces them.
 */

const BUCKET_TONE: Record<keyof CostBuckets, ChartTone> = {
  materials: "brand", crewLabor: "emerald", employeeLabor: "navy", subLabor: "blue",
  subcontractor: "neutral", equipment: "amber", permit: "neutral", other: "neutral",
};

type Tone = "brand" | "navy" | "amber" | "emerald" | "rose" | "neutral";
const toneText: Record<Tone, string> = {
  brand: "text-cc-brand-700",
  navy: "text-ppp-navy-700",
  amber: "text-amber-700",
  emerald: "text-emerald-700",
  rose: "text-rose-700",
  neutral: "text-ppp-charcoal",
};

/**
 * Typed to the KIND UNION, not Record<string, …>.
 *
 * It was the loose version, and adding a fourth receivable kind took the whole
 * Overview down: `KIND_META["uninvoiced"]` was undefined, `.cls` threw
 * mid-stream, and the page returned 200 with the shell and no content. Three
 * other copies of this map were caught by the compiler in the same edit
 * because they are typed to the union; this one was invisible.
 */
const KIND_META: Record<ReceivableKind, { label: string; cls: string }> = {
  invoice: { label: "Invoice", cls: "bg-ppp-blue-50 text-ppp-blue-800 border-ppp-blue-200" },
  aia: { label: "AIA", cls: "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200" },
  // Grey, never red: retention isn't late, it's held to close-out.
  retainage: { label: "Retention", cls: "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200" },
  // Amber: owed, but nobody has billed for it. The job is to raise an invoice,
  // not to chase somebody who has been sent nothing.
  uninvoiced: { label: "Not invoiced", cls: "bg-amber-50 text-amber-800 border-amber-200" },
};

/** Admin + account manager. Rep-facing surfaces never show cost or margin. */
async function requireFinanceViewer() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(user.email));
  if (role !== "admin" && role !== "account_manager") redirect("/commercial");
  return user;
}

/** Only ever return to this page. A `back` posted from a form is user input;
 *  without this, a crafted one would make either button an open redirect. */
function safeBack(raw: unknown): string {
  const v = String(raw ?? "");
  return v === BASE || v.startsWith(`${BASE}?`) ? v : BASE;
}


/** Save a chase note without leaving Accounting. Revalidates BOTH surfaces —
 *  the note is one record and it must not appear on one page and not the other. */
async function saveNoteAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  // FINANCE-GATED, not merely signed-in.
  //
  // These actions post to the page path, and a server action executes even
  // when the render-time redirect WOULD have fired — lib/commercial/auth.ts
  // says so in as many words. The page requires admin/account_manager; every
  // one of these ten actions required only "has commercial access", so a rep
  // replaying the action id could record payments, edit AR rows, and cost and
  // POST a whole payroll week onto every job — while being unable to approve
  // a single hour.
  const user = await requireFinanceViewer();
  const rowKey = String(formData.get("row_key") ?? "");
  // Carry the filters back, so saving a note doesn't drop you out of the view
  // you were working through row by row.
  const qs = String(formData.get("qs") ?? "?view=receivables");
  const sep = qs.includes("?") ? "&" : "?";
  if (!rowKey) redirect(`${BASE}${qs}`);
  const res = await setReceivableNote(rowKey, String(formData.get("note") ?? ""), user.id);
  revalidatePath(BASE);
  revalidatePath("/commercial/reports/receivables");
  // Same rule as the deposit tick: a successful save keeps you exactly where
  // you were, mid-list, rather than navigating (and scrolling) to the top. The
  // saved note re-renders in place, which is its own confirmation — a banner
  // you have to scroll back up to read is not.
  if (!res.ok) {
    redirect(`${BASE}${qs}${sep}error=${encodeURIComponent(res.error)}`);
  }
}

/**
 * Tick a payment as deposited (or untick it).
 *
 * Its own action so it stays a single click. Reconciling a bank statement is
 * thirty of these in a row; anything heavier doesn't get done, and the column
 * stops meaning anything the moment it's half-filled.
 */
async function depositAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  // FINANCE-GATED, not merely signed-in.
  //
  // These actions post to the page path, and a server action executes even
  // when the render-time redirect WOULD have fired — lib/commercial/auth.ts
  // says so in as many words. The page requires admin/account_manager; every
  // one of these ten actions required only "has commercial access", so a rep
  // replaying the action id could record payments, edit AR rows, and cost and
  // POST a whole payroll week onto every job — while being unable to approve
  // a single hour.
  const user = await requireFinanceViewer();
  const paymentId = String(formData.get("payment_id") ?? "");
  if (!paymentId) return;
  const res = await setPaymentDeposited(paymentId, String(formData.get("deposited")) === "1");
  // NO redirect on success — Karan: "make sure it doesnt redirect me to a
  // different page but just keeps me there". Even a redirect to this same URL
  // is a navigation, and a navigation scrolls you back to the top. Ticking off
  // a bank statement is thirty of these in a row; being thrown to the top of
  // the page after each one makes the feature unusable. `revalidatePath` alone
  // re-renders the row in place and leaves the scroll position alone.
  revalidatePath(BASE);
  if (!res.ok) {
    const qs = String(formData.get("qs") ?? "?view=transactions");
    const sep = qs.includes("?") ? "&" : "?";
    redirect(`${BASE}${qs}${sep}error=${encodeURIComponent(res.error)}`);
  }
}

/**
 * Mark a reimbursement paid back (or un-mark it). Same rule as the deposit
 * tick: no navigation on success, so paying out a list of them doesn't throw
 * you to the top of the page after every one.
 */
async function settleReimbursementAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  // FINANCE-GATED, not merely signed-in.
  //
  // These actions post to the page path, and a server action executes even
  // when the render-time redirect WOULD have fired — lib/commercial/auth.ts
  // says so in as many words. The page requires admin/account_manager; every
  // one of these ten actions required only "has commercial access", so a rep
  // replaying the action id could record payments, edit AR rows, and cost and
  // POST a whole payroll week onto every job — while being unable to approve
  // a single hour.
  const user = await requireFinanceViewer();
  const purchaseId = String(formData.get("purchase_id") ?? "");
  if (!purchaseId) return;
  const res = await setReimbursementSettled(purchaseId, String(formData.get("settled")) === "1");
  revalidatePath(BASE);
  if (!res.ok) {
    redirect(`${BASE}?view=reimbursements&error=${encodeURIComponent(res.error)}`);
  }
}

/**
 * Mary's three entry points — money in, money out to a crew, money out to a
 * supplier — posting to the SAME functions the invoice page and the deal cost
 * tool use. Not a second way of writing the row, just a nearer one.
 *
 * Amounts arrive as typed dollars ("1,250.50"), so they are parsed once, here.
 */
/**
 * Money a person typed → cents, or NULL when it is not money.
 *
 * It used to return 0 for anything unparseable. For three of its callers that
 * was harmless — they reject `cents <= 0` — but it is the wrong shape, and it
 * made "abc" and "nothing" the same value. Payroll is where that becomes
 * expensive: a Gusto cost of `N/A` pasted from a spreadsheet saved as $0.00,
 * cleared every blocker, and let the week post with that person's entire
 * payroll on no job while the screen certified the split tied to the cent.
 *
 * Returning null makes "not a number" distinguishable from "zero", which is
 * the distinction every caller actually needed.
 *
 * Accounting parentheses are read as negative — `(500)` means −500 on every
 * statement Mary handles, and silently reading it as 500 would be worse than
 * rejecting it.
 */
function dollarsToCents(raw: unknown): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text);
  const bare = text.replace(/^\(|\)$/g, "").replace(/[$,\s]/g, "");
  // Number("") is 0 and Number("1e5") is 100000 — neither is money somebody
  // typed, so the shape is checked before the value.
  if (!/^-?\d*\.?\d+$/.test(bare)) return null;
  const n = Number(bare);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100) * (negative ? -1 : 1);
  // Beyond this a bigint overflows Postgres and the raw error reaches the user.
  if (Math.abs(cents) > 1_000_000_000_00) return null;
  return cents;
}

/** A bare YYYY-MM-DD anchored at noon ET, so it lands on the day picked. */
function pickedDate(raw: unknown): string | undefined {
  const d = String(raw ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T16:00:00.000Z` : undefined;
}

/**
 * Mary's AR sheet is hers to keep. She has maintained it by hand for years, and
 * a platform that can only ever show her a copy of it is a downgrade — a line
 * gets revised, a figure corrected, one added before its certificate exists.
 */
async function editArRowAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  // FINANCE-GATED, not merely signed-in.
  //
  // These actions post to the page path, and a server action executes even
  // when the render-time redirect WOULD have fired — lib/commercial/auth.ts
  // says so in as many words. The page requires admin/account_manager; every
  // one of these ten actions required only "has commercial access", so a rep
  // replaying the action id could record payments, edit AR rows, and cost and
  // POST a whole payroll week onto every job — while being unable to approve
  // a single hour.
  const user = await requireFinanceViewer();
  const id = String(formData.get("id") ?? "");
  const intent = String(formData.get("intent") ?? "save");
  const { editArRow, setCarryoverCleared, addArRow, removeAddedArRow } = await import(
    "@/lib/commercial/reports/tomco/ar-applications"
  );

  if (intent === "clear" && id) {
    if (id.startsWith("added:")) await removeAddedArRow(id);
    else await setCarryoverCleared(id, true);
    revalidatePath(BASE);
    redirect(
      `${BASE}?view=ar&ok=${encodeURIComponent(
        // A carryover line can be put back; a hand-added one is gone. Say
        // which, so nobody has to find out by looking for it.
        id.startsWith("added:")
          ? "Line removed."
          : "Line removed — it's under “Removed lines” if you need it back.",
      )}`,
    );
  }
  /**
   * PUT A CLEARED CARRYOVER LINE BACK.
   *
   * `setCarryoverCleared` has always taken a boolean and `clearedCarryoverRows`
   * was written — its docblock says — as "the copied lines that have been
   * ticked off, shown so they can be put back". Nothing ever called it, and
   * nothing ever passed `false`. So a mis-click on Remove deleted an open
   * receivable from Mary's sheet with no undo and no list of what had gone:
   * the AR total quietly dropped and the only way to notice was remembering
   * the line existed.
   */
  if (intent === "restore" && id) {
    await setCarryoverCleared(id, false);
    revalidatePath(BASE);
    redirect(`${BASE}?view=ar&ok=${encodeURIComponent("Line put back.")}`);
  }
  if (intent === "add") {
    const cents = dollarsToCents(formData.get("amount"));
    const job = String(formData.get("job") ?? "").trim();
    if (!job || cents == null || cents <= 0) redirect(`${BASE}?view=ar&error=${encodeURIComponent("Give the line a job and an amount.")}`);
    await addArRow({ job, openCents: cents, note: String(formData.get("note") ?? "").trim() });
    revalidatePath(BASE);
    redirect(`${BASE}?view=ar&ok=${encodeURIComponent("Line added.")}`);
  }
  if (id) {
    const raw = String(formData.get("amount") ?? "").trim();
    await editArRow(id, {
      job: String(formData.get("job") ?? "").trim() || undefined,
      note: String(formData.get("note") ?? "").trim() || undefined,
      // `null` here means they typed something that is not money. Leaving the
      // field alone beats writing $0.00 over a real figure.
      openCents: raw ? dollarsToCents(raw) ?? undefined : undefined,
    });
  }
  revalidatePath(BASE);
  redirect(`${BASE}?view=ar&ok=${encodeURIComponent("Line updated.")}`);
}

async function recordPaymentAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  // FINANCE-GATED, not merely signed-in.
  //
  // These actions post to the page path, and a server action executes even
  // when the render-time redirect WOULD have fired — lib/commercial/auth.ts
  // says so in as many words. The page requires admin/account_manager; every
  // one of these ten actions required only "has commercial access", so a rep
  // replaying the action id could record payments, edit AR rows, and cost and
  // POST a whole payroll week onto every job — while being unable to approve
  // a single hour.
  const user = await requireFinanceViewer();
  const invoiceId = String(formData.get("invoice_id") ?? "");
  const cents = dollarsToCents(formData.get("amount"));
  if (!invoiceId || cents == null || cents <= 0) {
    redirect(`${BASE}?view=receivables&error=${encodeURIComponent("Pick an invoice or AIA certificate and enter an amount.")}`);
  }

  // AN AIA CERTIFICATE, NOT AN INVOICE.
  //
  // Stephanie 2026-09-23: "when I went into record the payment, it didn't show
  // up on the list because it was billed as AIA." The picker now offers them,
  // and they carry an `aia:` prefix because a bare uuid cannot say which of
  // the two ledgers it belongs to — and posting an AIA payment into
  // commercial_invoice_payments would be a silent write to the wrong table.
  if (invoiceId.startsWith("aia:")) {
    const appId = invoiceId.slice(4);
    // The picker builds this value, but a form field is a form field: check it
    // before it reaches an insert rather than trusting the shape of our own
    // option list.
    if (!UUID_RE.test(appId)) {
      redirect(`${BASE}?view=receivables&error=${encodeURIComponent("Pick an invoice or AIA certificate.")}`);
    }
    const { recordAiaPayment } = await import("@/lib/commercial/aia/payments");
    const aiaRes = await recordAiaPayment({
      application_id: appId,
      amount_cents: cents,
      paid_at: pickedDate(formData.get("paid_at")),
      method: String(formData.get("method") ?? "other"),
      reference: joinOtherDetail(str(formData.get("method_other")), str(formData.get("reference"))),
      recorded_by_user_id: user.id,
    });
    revalidatePath(BASE);
    if (!aiaRes.ok)
      redirect(`${BASE}?view=receivables&error=${encodeURIComponent(aiaRes.error)}`);
    // Capping is not a failure — it is the certificate refusing to be overpaid
    // — but it must not be silent, or the bank and the platform quietly
    // disagree. Same rule and same wording as the invoice path below.
    redirect(
      `${BASE}?view=receivables&ok=${encodeURIComponent(
        aiaRes.capped
          ? `Recorded ${formatCentsFull(Number(aiaRes.value.amount_cents))} — capped at what this certificate bills. Put the rest on the next application.`
          : "Payment recorded against the AIA certificate.",
      )}`,
    );
  }

  const { addPayment } = await import("@/lib/commercial/invoices/db");
  const res = await addPayment(invoiceId, {
    amount_cents: cents,
    paid_at: pickedDate(formData.get("paid_at")),
    method: String(formData.get("method") ?? "other"),
    // Same as the purchase form: "Other" on its own says nothing on a
    // reconciliation, so what they typed rides along in the reference.
    reference: joinOtherDetail(str(formData.get("method_other")), str(formData.get("reference"))),
    recorded_by_user_id: user.id,
  });
  revalidatePath(BASE);
  if (!res.ok) redirect(`${BASE}?view=receivables&error=${encodeURIComponent(res.error ?? "Could not record the payment.")}`);
  // Capping is not a failure — it is the invoice refusing to be overpaid — but
  // it must not be silent, or the bank and the platform quietly disagree.
  redirect(`${BASE}?view=receivables&ok=${encodeURIComponent(res.capped ? `Recorded ${formatCentsFull(res.applied_cents ?? 0)} — capped at the invoice balance.` : "Payment recorded.")}`);
}

/**
 * Save the actual Gusto cost for every person in one week, in one submit.
 *
 * One form for the whole table rather than a save per row: Mary is reading a
 * Gusto report and typing down a column, and fifteen separate saves is fifteen
 * chances to leave one behind.
 */
async function savePayrollCostsAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  // FINANCE-GATED, not merely signed-in.
  //
  // These actions post to the page path, and a server action executes even
  // when the render-time redirect WOULD have fired — lib/commercial/auth.ts
  // says so in as many words. The page requires admin/account_manager; every
  // one of these ten actions required only "has commercial access", so a rep
  // replaying the action id could record payments, edit AR rows, and cost and
  // POST a whole payroll week onto every job — while being unable to approve
  // a single hour.
  const user = await requireFinanceViewer();
  const start = String(formData.get("start") ?? "");
  const end = String(formData.get("end") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    redirect(`${BASE}?view=payroll&error=${encodeURIComponent("Bad week.")}`);
  }
  const { ensurePayrollPeriod, setPayrollCost } = await import("@/lib/commercial/field-ops/payroll-week");
  const period = await ensurePayrollPeriod(start, end, user.id);
  if (!period.ok) redirect(`${BASE}?view=payroll&week=${start}&error=${encodeURIComponent(period.error)}`);

  const problems: string[] = [];
  let saved = 0;
  // Gather BOTH fields per person before writing. Looping over cost_ alone
  // dropped a PTO job chosen for somebody whose cost had not been typed yet —
  // the choice vanished on save with no sign it had.
  const perEmployee = new Map<string, { cost?: string; pto?: string }>();
  for (const [k, v] of formData.entries()) {
    const raw = String(v ?? "").trim();
    if (k.startsWith("cost_")) {
      const e = perEmployee.get(k.slice(5)) ?? {};
      e.cost = raw;
      perEmployee.set(k.slice(5), e);
    } else if (k.startsWith("pto_")) {
      const e = perEmployee.get(k.slice(4)) ?? {};
      e.pto = raw;
      perEmployee.set(k.slice(4), e);
    }
  }

  for (const [employeeId, f] of perEmployee) {
    const ptoJob = UUID_RE.test(f.pto ?? "") ? (f.pto as string) : null;
    const raw = f.cost ?? "";
    // A BLANK IS NOT A ZERO. Clearing the box means "I have not entered this
    // yet", and writing 0 would let the week post with somebody costed at
    // nothing — silently putting their jobs in profit. But a PTO job chosen
    // without a cost still has to save, or the choice is lost.
    if (raw === "") {
      if (ptoJob) {
        const res = await setPayrollCost({
          periodId: period.id,
          employeeId,
          actualCostCents: null,
          unassignedOpportunityId: ptoJob,
          userId: user.id,
        });
        if (!res.ok) problems.push(res.error);
      }
      continue;
    }
    const cents = dollarsToCents(raw);
    if (cents == null || cents < 0) {
      // Named back to her, so a pasted "N/A" is visible rather than silently
      // becoming zero.
      problems.push(raw);
      continue;
    }
    const res = await setPayrollCost({
      periodId: period.id,
      employeeId,
      actualCostCents: cents,
      unassignedOpportunityId: ptoJob,
      userId: user.id,
    });
    if (res.ok) saved += 1;
    else problems.push(res.error);
  }
  revalidatePath(BASE);
  const note = problems.length
    ? `&error=${encodeURIComponent(`Saved ${saved}. Could not read: ${problems.slice(0, 3).join(", ")}`)}`
    : `&ok=${encodeURIComponent(`Saved ${saved} cost${saved === 1 ? "" : "s"}.`)}`;
  redirect(`${BASE}?view=payroll&week=${start}${note}`);
}

/** Turn the week's split into labor payouts on each job. */
async function postPayrollAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  // FINANCE-GATED, not merely signed-in.
  //
  // These actions post to the page path, and a server action executes even
  // when the render-time redirect WOULD have fired — lib/commercial/auth.ts
  // says so in as many words. The page requires admin/account_manager; every
  // one of these ten actions required only "has commercial access", so a rep
  // replaying the action id could record payments, edit AR rows, and cost and
  // POST a whole payroll week onto every job — while being unable to approve
  // a single hour.
  const user = await requireFinanceViewer();
  const start = String(formData.get("start") ?? "");
  const end = String(formData.get("end") ?? "");
  const { postPayrollWeek } = await import("@/lib/commercial/field-ops/payroll-week");
  const res = await postPayrollWeek(start, end, user.id);
  revalidatePath(BASE);
  revalidatePath("/commercial");
  if (!res.ok) redirect(`${BASE}?view=payroll&week=${start}&error=${encodeURIComponent(res.error)}`);
  redirect(
    `${BASE}?view=payroll&week=${start}&ok=${encodeURIComponent(
      `Posted ${formatCentsFull(res.totalCents)} across ${res.created} job line${res.created === 1 ? "" : "s"}${res.replaced ? ` — replaced ${res.replaced} from the previous run` : ""}.`,
    )}`,
  );
}

async function recordSpendAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  // FINANCE-GATED, not merely signed-in.
  //
  // These actions post to the page path, and a server action executes even
  // when the render-time redirect WOULD have fired — lib/commercial/auth.ts
  // says so in as many words. The page requires admin/account_manager; every
  // one of these ten actions required only "has commercial access", so a rep
  // replaying the action id could record payments, edit AR rows, and cost and
  // POST a whole payroll week onto every job — while being unable to approve
  // a single hour.
  const user = await requireFinanceViewer();
  const oppId = String(formData.get("opportunity_id") ?? "");
  const cents = dollarsToCents(formData.get("amount"));
  const isLabor = String(formData.get("kind") ?? "") === "labor";
  const view = isLabor ? "labor-out" : "purchases";
  if (!oppId || cents == null || cents <= 0) {
    redirect(`${BASE}?view=${view}&error=${encodeURIComponent("Pick a job and enter an amount.")}`);
  }
  const hoursRaw = String(formData.get("hours") ?? "").trim();
  const { addPurchase } = await import("@/lib/commercial/purchases/db");
  const res = await addPurchase({
    opportunity_id: oppId,
    // A labor payment now says WHOSE labor it was. Validated against the
    // shared list rather than trusted: this writes a category straight into
    // the row, and an unknown value would render as "Other" on every report.
    category: isLabor
      ? (isLaborPaymentCategory(String(formData.get("labor_category") ?? ""))
          ? String(formData.get("labor_category"))
          : "employee_labor")
      : String(formData.get("category") ?? "materials"),
    vendor: String(formData.get("vendor") ?? "") || null,
    amount_cents: cents,
    hours: isLabor && hoursRaw ? Number(hoursRaw) : null,
    purchased_at: pickedDate(formData.get("purchased_at")),
    // "Other" with nothing else recorded the word "Other" and threw away the
    // only useful fact. There is no column for it and inventing one means a
    // migration applied by hand on a live book, so the typed value is folded
    // into the free-text field the row already has — which is the Reference
    // column Mary reads in the list, so it is visible rather than buried.
    description: joinOtherDetail(str(formData.get("category_other")), str(formData.get("description"))),
    reimburse_to: String(formData.get("reimburse_to") ?? "") || null,
    created_by_user_id: user.id,
  });
  if (!res.ok) {
    revalidatePath(BASE);
    redirect(`${BASE}?view=${view}&error=${encodeURIComponent(res.error)}`);
  }

  /**
   * The receipt, attached here rather than on a second trip.
   *
   * Karan 2026-09-17: "where does she actually log a receipt currently? A bit
   * confusing to input a receipt." He was right, and it was not a wording
   * problem — this form had no receipt field at all. The only upload was on the
   * job's Costs tool, so recording a purchase where Mary actually works meant
   * saving it here, then finding the job, then opening Costs, then Edit, then
   * attaching. Five steps to file a receipt, and nothing on this page said so.
   *
   * Best-effort, exactly as the Costs tool does it: a failed upload never loses
   * the purchase, it says so and tells her where to add it.
   */
  let receiptFailed = false;
  const file = formData.get("receipt");
  if (!isLabor && file instanceof File && file.size > 0) {
    const { attachPurchaseReceipt } = await import("@/lib/commercial/purchases/db");
    const r = await attachPurchaseReceipt({
      purchaseId: res.value.id,
      file_name: file.name || "receipt.pdf",
      mime_type: file.type || "application/octet-stream",
      data: new Uint8Array(await file.arrayBuffer()),
      actorUserId: user.id,
    }).catch(() => ({ ok: false as const }));
    receiptFailed = !r.ok;
  }

  revalidatePath(BASE);
  const done = isLabor
    ? "Labor payment recorded."
    : receiptFailed
      ? "Purchase recorded, but the receipt didn't upload — add it from the job's Costs tool."
      : "Purchase recorded.";
  redirect(`${BASE}?view=${view}&ok=${encodeURIComponent(done)}`);
}

/**
 * Draft a note for every open item nobody has written one for.
 *
 * Its own action, and its own button, for the same reason the brief has one: a
 * model call belongs behind a deliberate click, not on a page load somebody
 * refreshes all day. A human note is never touched.
 */
async function draftNotesAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  // FINANCE-GATED, not merely signed-in.
  //
  // These actions post to the page path, and a server action executes even
  // when the render-time redirect WOULD have fired — lib/commercial/auth.ts
  // says so in as many words. The page requires admin/account_manager; every
  // one of these ten actions required only "has commercial access", so a rep
  // replaying the action id could record payments, edit AR rows, and cost and
  // POST a whole payroll week onto every job — while being unable to approve
  // a single hour.
  const user = await requireFinanceViewer();
  const { generateRowNotes } = await import("@/lib/commercial/reports/receivables-row-notes");
  const res = await generateRowNotes(await getReceivablesReport());
  revalidatePath(BASE);
  revalidatePath("/commercial/reports/receivables");
  const back = safeBack(formData.get("back"));
  const sep = back.includes("?") ? "&" : "?";
  redirect(res.ok ? `${back}${sep}notes=1` : `${back}${sep}error=${encodeURIComponent(res.error)}`);
}



/** Email the sheet to Alex. Explicit click only — no auto-send from here.
 *  Stays on the view you sent it from; it used to force `?view=receivables`,
 *  so pressing Send from Overview silently switched tabs underneath you. */
async function sendToAlexAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  // FINANCE-GATED, not merely signed-in.
  //
  // These actions post to the page path, and a server action executes even
  // when the render-time redirect WOULD have fired — lib/commercial/auth.ts
  // says so in as many words. The page requires admin/account_manager; every
  // one of these ten actions required only "has commercial access", so a rep
  // replaying the action id could record payments, edit AR rows, and cost and
  // POST a whole payroll week onto every job — while being unable to approve
  // a single hour.
  const user = await requireFinanceViewer();
  const res = await sendReceivablesToAlex();
  revalidatePath(BASE);
  const back = safeBack(formData.get("back"));
  const sep = back.includes("?") ? "&" : "?";
  redirect(
    res.ok
      ? `${back}${sep}sent=${encodeURIComponent(res.to.join(", "))}`
      : `${back}${sep}error=${encodeURIComponent(res.error)}`
  );
}

/** Tabs whose CSV comes from the shared grouped-report export. */
const EXPORTABLE_TABS = new Set(["ar", "owed", "purchases", "labor-out", "deposits"]);

// The tab list moved to lib/commercial/accounting/tabs.ts so the How-it-works
// handbook can draw the SAME bar instead of a hand-typed copy that went stale.
const VIEWS = ACCOUNTING_VIEWS;

type View = AccountingView;

function pickFirst(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v ?? undefined;
}

export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireFinanceViewer();
  const sp = await searchParams;
  const error = pickFirst(sp.error);
  const okMessage = pickFirst(sp.ok);
  const saved = pickFirst(sp.saved) === "1";
  const sentTo = pickFirst(sp.sent);
  const rawView = pickFirst(sp.view);
  const view: View = (VIEWS.some((v) => v.key === rawView) ? rawView : "overview") as View;
  // ── AR sheet: group-by + period (Karan 2026-09-17) ─────────────────────
  const arGroupRaw = Number(pickFirst(sp.argroup) ?? "0");
  const arGroup =
    Number.isInteger(arGroupRaw) && arGroupRaw >= 0 && arGroupRaw < AR_APPLICATIONS_SPEC.groupings.length
      ? arGroupRaw
      : 0;
  const arPeriodRaw = pickFirst(sp.arperiod) ?? "all";
  const arPeriod = AR_PERIODS.some((p) => p.key === arPeriodRaw) ? arPeriodRaw : "all";
  /** Keep every other param, change one. */
  const arControlHref = (next: { group?: number; period?: string }) => {
    const p = new URLSearchParams();
    p.set("view", "ar");
    const g = next.group ?? arGroup;
    const per = next.period ?? arPeriod;
    if (g !== 0) p.set("argroup", String(g));
    if (per !== "all") p.set("arperiod", per);
    return `/commercial/accounting?${p.toString()}`;
  };

  const recipients = receivablesRecipients();
  const q = parseReceivableQuery((k) => sp[k]);
  const activeFilter = describeReceivableQuery(q);

  // ── The ledger's own filters ──────────────────────────────────────────
  // Its own query keys (`tp`/`td`/`tparty`/`tundep`) so switching between the
  // Receivables view and this one never carries a filter across and quietly
  // narrows a different list.
  const txPeriod = resolvePreset(pickFirst(sp.tp), ACTIVITY_PRESETS, LEDGER_DEFAULT);
  const rawDir = pickFirst(sp.td);
  const txDirection: TxnDirection | "all" = rawDir === "in" || rawDir === "out" ? rawDir : "all";
  const txParty = pickFirst(sp.tparty)?.trim() || null;
  const txUndeposited = pickFirst(sp.tundep) === "1";
  const txRange = activityRange(txPeriod);
  const txFilters: TxnFilters = {
    fromYmd: txRange?.fromYmd,
    toYmd: txRange?.toYmd,
    direction: txDirection === "all" ? undefined : txDirection,
    party: txParty ?? undefined,
    undepositedOnly: txUndeposited || undefined,
  };
  const txQuery = (patch: Record<string, string | null> = {}) => {
    const p = new URLSearchParams({ view: "transactions" });
    const set = (k: string, v: string | null) => {
      if (v) p.set(k, v);
      else p.delete(k);
    };
    set("tp", txPeriod === LEDGER_DEFAULT ? null : txPeriod);
    set("td", txDirection === "all" ? null : txDirection);
    set("tparty", txParty);
    set("tundep", txUndeposited ? "1" : null);
    for (const [k, v] of Object.entries(patch)) set(k, v);
    return `?${p.toString()}`;
  };
  // Filters live on the Receivables VIEW only. The headline band above the
  // switcher, and every overview figure, stay whole-book: those are "where does
  // the company stand", and silently narrowing them to a filter set on another
  // tab would make the money desk quietly wrong.
  const viewQs = (v: View) => (v === "receivables" ? receivableQueryString(q) : "");

  /**
   * The week window on the money-out registers.
   *
   * Mary 2026-09-24: "Can I run a payout report for this week? I want to match
   * it against SF." These three listed every row ever recorded, with no way to
   * narrow — so matching one week meant exporting 851 rows into Excel.
   */
  const rawPeriod = pickFirst(sp.period);
  /**
   * DEFAULTS TO THIS MONTH, not all time.
   *
   * Unfiltered, these registers render every row ever recorded: Purchases
   * measured 2,519kb of HTML and Labor payments 1,929kb, and both grow every
   * week. A month brings them to 413kb and 240kb. Mary reconciles a week or a
   * month at a time, so all-time was never the view she wanted — it was just
   * the only one there was.
   *
   * Nothing is hidden: the bar names the exact dates it is showing, says how
   * many rows, and All time is one click away.
   */
  const period: SpendPeriodKey = isSpendPeriod(rawPeriod) ? rawPeriod : "this_month";
  /**
   * Note the #register. Changing the week is a full navigation, so without a
   * fragment the browser lands at the top of the page and Mary has to scroll
   * back down past the KPI cards, the tab bar and the whole entry form to see
   * the result of her own click — every time she changes period.
   */
  const periodHref = (v: View, k: SpendPeriodKey) =>
    `${BASE}?view=${v}&period=${k}#register`;
  const href = (v: View) => {
    if (v === "overview") return BASE;
    // The ledger carries its own filters back, so leaving it and returning
    // doesn't silently reset the month you were reconciling.
    if (v === "transactions") return `${BASE}${txQuery()}`;
    // Carry the period across — these three read the same window, and losing
    // it on a tab switch means re-picking the month every time.
    if (v === "tax" || v === "reimbursements") {
      const p = new URLSearchParams({ view: v });
      if (txPeriod !== LEDGER_DEFAULT) p.set("tp", txPeriod);
      return `${BASE}?${p.toString()}`;
    }
    const qs = viewQs(v);
    return `${BASE}?view=${v}${qs ? `&${qs.slice(1)}` : ""}`;
  };

  // Both windows come from the reports' own preset functions, so a figure here
  // and the same figure on its report are computed over an identical period.
  // Hand-rolling them here is how the Reports index ended up showing a calendar
  // year where the estimator report used a fiscal one.
  const cashRange = cashFlowRange(CASH_FLOW_DEFAULT);
  const coRange = changeOrderRange(CHANGE_ORDER_DEFAULT);

  // `Promise.all` rejects on the first failure, so one report throwing took the
  // whole money desk down — including the four headline tiles that had nothing
  // to do with it. One failure costs one block now, and says so.
  const failed: string[] = [];
  const settle = async <T,>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      console.error(`[accounting] ${label} failed:`, err);
      failed.push(label);
      return fallback;
    }
  };
  // PAY FOR WHAT THIS TAB SHOWS.
  //
  // All five ran on every tab — so opening Purchases, or the AR sheet, or
  // Deposits also computed the cash-flow report, the whole job-costs report,
  // the change-order/vendor report and every project. Measured against Tomco's
  // book that is ~1.7s of queries on a page that needed none of them, on every
  // click, because these pages are `force-dynamic` and nothing is cached.
  //
  // Receivables stays unconditional: it feeds the money band, which is on
  // screen whatever tab you are on and is the reason the page exists.
  const needsCash = view === "overview" || view === "cash";
  const needsCosts = view === "overview" || view === "costs";
  const needsOverviewOnly = view === "overview";
  // The Won-not-invoiced tab reads the same project rows the Overview line is
  // computed from. Without this the tab rendered an empty table under a
  // heading that promised 19 jobs.
  const needsProjects = needsOverviewOnly || view === "unbilled";
  const [company, receivables, cash, jobCosts, coVendor, projects] = await Promise.all([
    // Named on the printed sheet, so what reaches the bookkeeper says whose
    // books it is. In the same batch as everything else — it is one small read
    // and paying a round-trip for it would slow every load.
    getOperatingCompany(),
    settle("Receivables", getReceivablesReport(), summarizeReceivables([])),
    needsCash ? settle("Cash flow", getCashFlowReport(cashRange), EMPTY_CASH) : Promise.resolve(EMPTY_CASH),
    needsCosts ? settle("Job costs", getJobCostsReport(), EMPTY_JOB_COSTS) : Promise.resolve(EMPTY_JOB_COSTS),
    needsOverviewOnly ? settle("Change orders", getChangeOrderVendorReport(coRange), EMPTY_CO) : Promise.resolve(EMPTY_CO),
    needsProjects ? settle("Projects", listProjects(), []) : Promise.resolve([]),
  ]);

  // What the band shows when the obvious figures collapse into each other —
  // concentration, age, and whether anybody has actually chased any of it.
  const gcTotals = new Map<string, number>();
  for (const r of receivables.rows) gcTotals.set(r.accountName, (gcTotals.get(r.accountName) ?? 0) + r.openCents);
  const topGcEntry = [...gcTotals.entries()].sort((a, b) => b[1] - a[1])[0];
  const topGc = topGcEntry
    ? {
        name: topGcEntry[0],
        cents: topGcEntry[1],
        pct: receivables.totalOpenCents > 0 ? Math.round((topGcEntry[1] / receivables.totalOpenCents) * 100) : 0,
      }
    : null;
  const oldestDays = receivables.rows.reduce((n, r) => Math.max(n, r.daysOut ?? 0), 0);
  // The single oldest line, so the Oldest tile can name who it is with.
  const oldestRow = receivables.rows.reduce<(typeof receivables.rows)[number] | null>(
    (worst, r) => ((r.daysOut ?? 0) > (worst?.daysOut ?? 0) ? r : worst),
    null
  );
  // Past 90 days: the money that is genuinely rotting, as opposed to "past due",
  // which on this book is everything and therefore tells you nothing.
  const over90 = receivables.rows.filter((r) => (r.daysOut ?? 0) > 90);
  const over90Cents = over90.reduce((n, r) => n + r.openCents, 0);
  const over90Count = over90.length;

  //
  // ── EVERY PER-VIEW READ, IN ONE WAVE ─────────────────────────────────────
  //
  // These were eleven separate sequential awaits. Each is guarded by `view`
  // (or `entryOn`, itself derived from `view`), and every one of those guards
  // comes from `sp` — NOT from the wave above — so nothing here was waiting on
  // anything. On the views that render two or three of them, that was two or
  // three round trips taken one at a time for no reason. `getCachedRowNotes`
  // runs on every view, so this is never a no-op.
  //
  // NOT merged: the filtered `getReceivablesReport` on the Receivables view
  // stays exactly as it was. It looks like a duplicate of the unfiltered read
  // above — with no filters in the URL the only difference is the `sort`
  // argument — but proving the ordering comes out the same is a bigger claim
  // than one query is worth, and getting it wrong would silently reorder
  // Mary's sheet.
  const entryOn = view === "receivables" || view === "purchases" || view === "labor-out";
  const spendOn = view === "purchases" || view === "labor-out";
  const { getCachedRowNotes, rowNotesAvailable } = await import("@/lib/commercial/reports/receivables-row-notes");
  const [
    aging,
    receivablesView,
    transactions,
    salesTax,
    reimbursements,
    owedRows,
    arRows,
    entry,
    spendRows,
    depositRows,
    payroll,
    rowNotes,
  ] = await Promise.all([
    // Only fetched for the view that renders it — the money band above doesn't
    // use aging, so paying for it on every page load would be waste.
    view === "aging" ? getArAging() : Promise.resolve(null),
    // A second, filtered read for the Receivables view. Cheap relative to a
    // wrong number: reusing the unfiltered `receivables` would ignore the
    // filter bar.
    view === "receivables" ? getReceivablesReport(Date.now(), filtersFor(q)) : Promise.resolve(null),
    view === "transactions" ? getTransactionsReport(txFilters) : Promise.resolve(null),
    // Both windowed by the same shared activity preset the ledger uses, so a
    // period means the same thing on every view of this page.
    view === "tax"
      ? getSalesTaxReport({
          fromYmd: txRange?.fromYmd,
          toYmd: txRange?.toYmd,
          uncertifiedOnly: pickFirst(sp.nocert) === "1" || undefined,
        })
      : Promise.resolve(null),
    view === "reimbursements"
      ? getReimbursementsReport({ fromYmd: txRange?.fromYmd, toYmd: txRange?.toYmd })
      : Promise.resolve(null),
    // Mary's four, each paid for only on the view that renders it.
    view === "owed" ? getBalanceOwedRows() : Promise.resolve(null),
    view === "ar" ? getArSheetRows() : Promise.resolve(null),
    // The pickers for Mary's entry forms, built only on the views that show one.
    entryOn ? getAccountingEntryOptions() : Promise.resolve(null),
    spendOn ? getSpendRows() : Promise.resolve(null),
    view === "deposits" ? getMoneyInRows() : Promise.resolve(null),
    // The payroll week. Gated like the rest — it is four joins and nobody on
    // Overview is paying for it.
    view === "payroll"
      ? (async () => {
          const { getPayrollWeek, latestPayrollWeekStart } = await import(
            "@/lib/commercial/field-ops/payroll-week"
          );
          const { mondayOf, addDaysIso, todayEtIso } = await import(
            "@/lib/commercial/field-ops/schedule"
          );
          const asked = pickFirst(sp.week);
          const thisWeek = mondayOf(todayEtIso());
          // Always a whole Monday–Sunday block. Overtime is a 40h/week idea, so
          // a half-week cannot be costed correctly — and a URL somebody edited
          // by hand must not be able to produce one.
          //
          // With no week asked for, land on the most recent week that HAS
          // hours rather than the calendar week. Payroll is run for the week
          // that ended: opening the tab midweek used to show four empty panels
          // and a warning, every time, which read as the feature being broken.
          const start =
            asked && /^\d{4}-\d{2}-\d{2}$/.test(asked)
              ? mondayOf(asked)
              : ((await latestPayrollWeekStart()) ?? thisWeek);
          return { week: await getPayrollWeek(start, addDaysIso(start, 6)), start, thisWeek };
        })()
      : Promise.resolve(null),
    // Rows whose read is missing OR written from facts that have since moved —
    // including a note somebody typed after the last draft.
    getCachedRowNotes(receivables),
  ]);
  /**
   * The period, applied — with undated lines ALWAYS kept.
   *
   * Every carried-over line on Mary's sheet has `issuedYmd = null`; they are her
   * own rows, typed by hand, with no certificate behind them to carry a date.
   * A naive `r.issuedYmd >= from` would therefore hide all 23 of them and show
   * an AR sheet of $0 against a real $314,048.14 — a filter that empties the
   * book is worse than no filter. So the period narrows the DATED rows and
   * leaves the undated ones in, and the control says so when it is doing it.
   */
  const arCutoff = arPeriodCutoff(arPeriod);
  const arRowsFiltered =
    arRows && arCutoff ? arRows.filter((r) => !r.issuedYmd || r.issuedYmd >= arCutoff) : arRows;
  const arUndatedKept = (arRowsFiltered ?? []).filter((r) => !r.issuedYmd).length;
  // The carryover lines somebody has ticked off — so a mis-click on Remove is
  // recoverable instead of silently shrinking the book. AR view only; no other
  // view pays for the read.
  const arClearedRows =
    view === "ar"
      ? await (
          await import("@/lib/commercial/reports/tomco/ar-applications")
        ).clearedCarryoverRows()
      : [];
  // `entry`, `spendRows` and `depositRows` are fetched in the wave above.
  const production = summarizeProduction(projects);
  // Work that is won and carries a DRAFT invoice — raised but never sent. A
  // project row exists only once a job is won, so no pre-sale bid can land here.
  const wonNotBilled = projects.filter((p) => p.draftedCents > 0);
  const wonNotBilledCents = wonNotBilled.reduce((n, p) => n + p.draftedCents, 0);
  const wonNotBilledJobs = wonNotBilled.length;
  // The brief block and the digest switches both left this page (2026-09-17):
  // the brief restated the tiles, and the schedule is a setting, not a figure.
  // Neither is read here any more, so neither is loaded — one fewer model call
  // and one fewer settings read on every load of the page Mary lives on.
  // Only offered when there is actually something to redraw.
  const silentRows = rowNotes.staleCount;
  const canDraftNotes = rowNotesAvailable();
  const previewedTo = pickFirst(sp.preview);

  // Cash actually collected, per month. Deliberately COLLECTED rather than
  // billed: the reports index already charts billing, and the question this
  // page exists to answer is what arrived in the bank.
  const cashSeries = cash.months.map((m) => ({ label: m.label, value: m.collectedCents / 100_000 }));
  const hasCash = cash.months.some((m) => m.collectedCents > 0);
  // Sparse-data guards. Early on, every ratio on this view is computed from one
  // or two payments, and a number that precise about a sample that small is
  // misleading rather than informative.
  const thinSample = cash.totals.paymentCount > 0 && cash.totals.paymentCount < 3;

  // Contract signed but never invoiced.
  //
  // From summarizeProduction, NOT `Σcontract − Σbilled`. Those differ, and the
  // difference is a real bug the platform already fixed once (2026-08 money
  // audit #3): the aggregate subtraction lets an OVER-billed job silently
  // cancel an under-billed one, so the portfolio understates what is still
  // billable and never warns. summarizeProduction sums each project's own
  // clamped leftToBill and tracks over-billing separately, which is why the
  // over-billed count is surfaced below rather than quietly absorbed.
  //
  // It also already folds AIA in — billedContractCents is
  // `invoice pre-tax + AIA billed` — so an AIA job doesn't read as unbilled.
  const unbilledContractCents = production.leftToBillCents;
  const unbilledCoCents = coVendor.co.unbilledCents;

  const costSegments: DonutSegment[] = COST_BUCKET_COLUMNS
    .filter((c) => jobCosts.totals.buckets[c.key] > 0)
    .map((c) => ({
      label: c.label,
      value: jobCosts.totals.buckets[c.key],
      tone: BUCKET_TONE[c.key],
      valueLabel: formatCentsCompact(jobCosts.totals.buckets[c.key]),
    }));

  const marginTone: Tone =
    jobCosts.totals.marginPct === null || jobCosts.totals.totalCostCents === 0
      ? "neutral"
      : jobCosts.totals.marginPct < 0
        ? "rose"
        : jobCosts.totals.marginPct < 15
          ? "amber"
          : "emerald";

  const topRows = receivables.rows.slice(0, 8);
  const restCount = receivables.rows.length - topRows.length;

  return (
    <div id="accounting-sheet" className="max-w-[1400px] mx-auto px-3 sm:px-6 py-6 space-y-5">
      {/* Karan 2026-09-16: "could we also have a Print / PDF button so we can
          send in a clean PDF format." Mary sends these on to the bookkeeper,
          so what prints is the report — the title, the figures and the table —
          and not the tab strip, the filter bars or the buttons, each of which
          is marked `data-print-hide` below. */}
      <PrintSheetStyles id="accounting-sheet" />
      <PrintHeader
        company={company.name}
        title={VIEWS.find((v) => v.key === view)?.label ?? "Accounting"}
        subtitle={`Run ${fmtEtDate(receivables.generatedAt) ?? ""}`}
      />
      <div data-print-hide className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">
            Accounting
          </h1>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-2xl">
            Where the money stands — what&rsquo;s owed to us, what came in, what&rsquo;s still to bill,
            and what the work cost. Open any block for the full report.
          </p>
        </div>
        {/* Two actions, one row, aligned to each other.
            
            This was a button with two email addresses spelled out underneath
            it, on a second line, in grey — which is why it read as broken
            rather than as a control. The destination still has to be knowable
            (a send button whose target you have to guess is one nobody
            presses), so it moved into the hover title and the confirmation,
            where it is available without being shouted. */}
        <div className="flex items-center gap-2 shrink-0">
          {/* EXPORT THE TAB YOU ARE ON.
              This was hard-wired to the receivables sheet, so however deep into
              Purchases or the AR sheet Mary was, pressing Export downloaded
              Receivables — and the AR sheet is the one she sends Alex. The
              three tabs with their own endpoints keep them (they carry filters
              a generic export cannot); the rest go through one route that
              builds the CSV from the same spec the page renders. */}
          {/* Print sits beside Export because they answer the same question
              — "get this off the screen and send it" — and Mary's bookkeeper
              wants the sheet, not a CSV. */}
          <span data-tour="accounting:print">
            <PrintButton />
          </span>
          <ExportCsvLink
            href={
              view === "transactions"
                ? "/api/commercial/reports/transactions/export"
                : view === "tax"
                  ? "/api/commercial/reports/sales-tax/export"
                  : view === "aging"
                    ? "/api/commercial/reports/ar-aging/export"
                    : view === "costs"
                      ? "/api/commercial/reports/job-costs/export"
                      : view === "cash"
                        ? "/api/commercial/reports/cash-flow/export"
                        : EXPORTABLE_TABS.has(view)
                          ? // The AR sheet's group-by and period ride along, or
                            // the CSV silently covers all time while the screen
                            // shows 30 days.
                            view === "ar"
                            ? `/api/commercial/accounting/export?view=ar${arGroup !== 0 ? `&argroup=${arGroup}` : ""}${arPeriod !== "all" ? `&arperiod=${arPeriod}` : ""}`
                            : // And the week window rides along for the same
                              // reason: a CSV covering all time while the
                              // screen shows one week is the exact trap the AR
                              // comment above describes.
                              `/api/commercial/accounting/export?view=${view}${period !== "all" ? `&period=${period}` : ""}`
                          : "/api/commercial/reports/receivables/export"
            }
            params={view === "receivables" ? receivableQueryParams(q) : undefined}
            disabled={(view === "receivables" ? receivablesView?.rows.length ?? 0 : receivables.rows.length) === 0}
            disabledHint="Nothing to export in this view"
            label="Export"
          />
          {receivables.rows.length > 0 && (
            <form action={sendToAlexAction}>
              <input type="hidden" name="back" value={href(view)} />
              <PendingSubmitButton
                pendingLabel="Sending…"
                title={`Emails the receivables sheet to ${recipients.join(", ")}${receivablesView?.filtered ? " — the whole book, not this filter" : ""}`}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
                </svg>
                Send
              </PendingSubmitButton>
            </form>
          )}
        </div>
      </div>

      {failed.length > 0 && (
        // A tile reading $0 because its report threw is a lie. Name it.
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
          Couldn&rsquo;t load {failed.join(", ")} just now — {failed.length === 1 ? "that block is" : "those blocks are"}{" "}
          showing nothing rather than a number. The rest of this page is current.
        </div>
      )}
      {error && (
        // `break-words` because a model/API failure now names its own reason,
        // and some of those are a long unbroken string.
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800 break-words">
          {error}
        </div>
      )}
      {saved && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
          Note saved.
        </div>
      )}
      {okMessage && (
        // Recording a payment or a purchase said so via `?ok=` and NOTHING
        // rendered it — so Mary would enter a payment and get no
        // acknowledgement at all, and the one message that really matters
        // ("capped at the invoice balance", i.e. the bank and the platform
        // now disagree) was invisible.
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
          {okMessage}
        </div>
      )}
      {pickFirst(sp.notes) === "1" && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
          Reads updated. They sit in their own column, marked{" "}
          <span className="text-cc-brand-600 font-bold">✦</span> — your notes column is untouched.
        </div>
      )}
      {previewedTo && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
          Preview sent to <strong>{previewedTo}</strong> — the exact email Alex would get. Nothing was sent to him.
        </div>
      )}
      {sentTo && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
          Receivables sheet sent to <strong>{sentTo}</strong> — the figures, the notes, and the CSV attached.
        </div>
      )}

      {/* The brief used to sit here — a model-written paragraph summarising the
          book. Karan 2026-09-17: "we dont need this here either." It restated
          what the tiles and the list below already show, and it went stale the
          moment anything moved, so it carried a "written before the latest
          changes" apology more often than a current read. It still lives on the
          receivables report for anyone who wants it. */}

      {/* ── The money band — ALWAYS on screen, above the switcher. Changing view
             must never cost you the four numbers the page is opened for. ── */}
      {/* FOUR TILES, FOUR DIFFERENT FACTS — third attempt, and the first that
          actually holds on Tomco's data.

          Karan, twice: "these KPIs still suck and are like the same." He was
          right both times. The band printed $1,369,044.37 as Total outstanding
          and then printed the identical figure again as "Past due · all of it",
          because every imported invoice carries Salesforce's "Upon Receipt"
          terms so the whole book is late. A fourth tile read "No note yet: 0".
          Two of four slots were saying nothing.

          The fix is not better labels, it is different QUESTIONS. A total, a
          concentration, an age bucket and a worst case — and the past-due fact
          folded into the first tile's sub-line, where it costs no slot. All four
          come off the rows already loaded; none adds a query. */}
      {/* NOT ON THE PRINTED SHEET.
          Karan 2026-09-17, looking at a printed AR sheet: "we don't need the
          KPIs at the top." They are whole-book figures — $1,369,044.37
          outstanding — sitting above a sheet whose own total is $314,048.14.
          On screen they are the point of the page; on a sheet sent to a
          bookkeeper they are a second, larger, unrelated number at the top,
          which is the one thing a financial document must never have. */}
      <section data-print-hide className="space-y-2">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile
            label="Total outstanding"
            value={formatCentsFull(receivables.totalOpenCents)}
            tone="brand"
            sub={
              receivables.overdueCents === receivables.totalOpenCents && receivables.totalOpenCents > 0
                ? `${receivables.rows.length} open · every one past due`
                : receivables.overdueCents > 0
                  ? `${receivables.rows.length} open · ${formatCentsCompact(receivables.overdueCents)} past due`
                  : `${receivables.rows.length} open item${receivables.rows.length === 1 ? "" : "s"} · none late`
            }
          />
          <Tile
            label="Biggest GC"
            value={topGc ? formatCentsFull(topGc.cents) : "—"}
            // Concentration is the fact that actually changes what you do: at
            // 83% of the book, one GC going quiet IS the problem.
            tone={topGc && topGc.pct >= 50 ? "amber" : "navy"}
            sub={topGc ? `${topGc.name} · ${topGc.pct}% of the book` : "nothing outstanding"}
          />
          <Tile
            label="Over 90 days"
            value={formatCentsFull(over90Cents)}
            tone={over90Cents > 0 ? "rose" : "emerald"}
            sub={
              over90Cents > 0
                ? `${over90Count} item${over90Count === 1 ? "" : "s"} · ${Math.round((over90Cents / Math.max(1, receivables.totalOpenCents)) * 100)}% of the book`
                : "nothing has aged that far"
            }
          />
          {/* Days, not dollars. A fourth money tile beside three others is the
              thing people's eyes slide off; the oldest line is the one that
              gets a call made. */}
          <Tile
            label="Oldest"
            value={oldestDays > 0 ? `${oldestDays.toLocaleString()} days` : "—"}
            tone={oldestDays >= 180 ? "rose" : oldestDays > 0 ? "amber" : "neutral"}
            sub={oldestRow ? `${oldestRow.accountName} · ${formatCentsCompact(oldestRow.openCents)}` : "nothing outstanding"}
          />
        </div>
      </section>

      {/* ── The switcher. Prominent and high, because these are the surfaces
             people came for — not a footer of links. Renders in place: the URL
             stays on /commercial/accounting. ── */}
      {/* THIRTEEN TABS WAS TOO MANY TO LAND ON.
          Karan 2026-09-16: "there's so many tabs here, I don't know if we need
          all of these... the ones I mentioned and the things she needs to do
          should be there, and the other tabs we're unsure about need to be
          collapsed until tomorrow." So the six Mary works in every day stay on
          the bar, and the other seven fold behind "More" — nothing is removed,
          and anything she is already looking at stays open. */}
      <nav data-print-hide className="border-b border-ppp-charcoal-100 -mx-1 px-1">
        <div className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {VIEWS.filter((v) => v.primary).map((v) => {
            const active = v.key === view;
            return (
              <Link
                key={v.key}
                href={href(v.key)}
                aria-current={active ? "page" : undefined}
                // Stable hook for the walkthrough on /commercial/guide. Keyed on
                // the view, not the label, so renaming a tab does not silently
                // leave the tour pointing at nothing.
                data-tour={`accounting:${v.key}`}
                className={`shrink-0 px-3.5 py-2 text-[13.5px] font-bold border-b-2 min-h-[44px] inline-flex items-center touch-manipulation transition-colors ${
                  active
                    ? "border-cc-brand-600 text-ppp-charcoal"
                    : "border-transparent text-ppp-charcoal-500 hover:text-ppp-charcoal hover:border-ppp-charcoal-200"
                }`}
              >
                {v.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* The seven held back. A real disclosure — `details` so it works with no
          JavaScript — and forced open when you are already on one of them, so
          the bar can never hide where you are. */}
      <details data-print-hide className="-mt-1" open={VIEWS.some((v) => !v.primary && v.key === view)}>
        <summary className="list-none cursor-pointer inline-flex items-center gap-1 px-1 py-2 text-[12.5px] font-semibold text-ppp-charcoal-500 hover:text-ppp-charcoal min-h-[38px]">
          More
          <span className="text-ppp-charcoal-400">({VIEWS.filter((v) => !v.primary).length})</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </summary>
        <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {VIEWS.filter((v) => !v.primary).map((v) => {
            const active = v.key === view;
            return (
              <Link
                key={v.key}
                href={href(v.key)}
                aria-current={active ? "page" : undefined}
                // Same hook as the tabs on the bar. The first pass only tagged
                // the six primaries, so the walkthrough's seven More steps dimmed
                // the screen and pointed at nothing.
                data-tour={`accounting:${v.key}`}
                className={`shrink-0 px-3 rounded-lg border text-[12.5px] font-semibold min-h-[38px] inline-flex items-center ${
                  active
                    ? "border-cc-brand-300 bg-cc-brand-50 text-cc-brand-800"
                    : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
                }`}
              >
                {v.label}
              </Link>
            );
          })}
        </div>
      </details>

      {view === "overview" && (
      <>
      {/* Concentration — the risk a total hides. $500k owed is a different
          business depending on whether it's forty GCs or one, and it's the
          first thing a CEO asks after "how much". Only shown when it actually
          concentrates; below a third it's just the largest customer. */}
      {receivables.topGc && receivables.topGc.sharePct >= 34 && receivables.gcOptions.length > 1 && (
        <p className="text-[12px] rounded-lg border px-3 py-2 border-amber-200 bg-amber-50 text-amber-900">
          <strong>{receivables.topGc.sharePct}%</strong> of what&rsquo;s outstanding sits with{" "}
          <strong>{receivables.topGc.name}</strong> ({formatCentsFull(receivables.topGc.cents)}).{" "}
          <Link href={`${BASE}?view=receivables&gc=${receivables.topGc.id}`} className="font-semibold underline">
            See just them
          </Link>
        </p>
      )}

      {/* WON, NOT BILLED YET — one line, one fact.
          The three-tile "Earned, not yet billed" block was removed this
          morning for printing the same figure twice and a zero. What it stood
          on turned out to matter: the migration had marked this work as
          invoiced and overdue when Tomco had never billed it, and once that
          was corrected half a million pounds of real, billable work had
          nowhere on Mary's page to appear. So the fact comes back; the block
          does not. Every job counted here is won — checked, all 19 sit in
          pre-construction, in progress or billing. */}
      {wonNotBilledCents > 0 && (
        <Link
          href={href("unbilled")}
          className="flex items-center justify-between gap-3 rounded-xl border border-cc-brand-300 bg-cc-brand-50 px-4 py-3 hover:border-cc-brand-600 transition-colors"
        >
          <span className="min-w-0">
            <span className="block text-[10px] font-bold uppercase tracking-wider text-cc-brand-700">
              Won, not invoiced
            </span>
            <span className="block text-[11.5px] text-cc-brand-800 mt-0.5">
              Won work with no invoice raised against it — the fastest cash there is.
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-[19px] font-black text-cc-brand-900 tabular-nums leading-none">
              {formatCentsFull(wonNotBilledCents)}
            </span>
            <span className="block text-[11px] text-cc-brand-800 mt-1">
              {wonNotBilledJobs} job{wonNotBilledJobs === 1 ? "" : "s"} &rarr;
            </span>
          </span>
        </Link>
      )}

      {/* ── 3 · What came in ──────────────────────────────────────────── */}
      <section className="space-y-2">
        <SectionHead
          title="Cash in · last 6 months"
          href={href("cash")}
          hint="Payments received, not invoices raised."
        />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
            <div className="flex items-baseline justify-between gap-2 mb-2">
              <div className="flex items-baseline gap-2 min-w-0">
                <h3 className="text-[13px] font-bold text-ppp-charcoal">Collected / month</h3>
                <span className="font-condensed text-[15px] font-black tabular-nums text-emerald-700">
                  {formatCentsCompact(cash.totals.collectedCents)}
                </span>
              </div>
              <span className="text-[11px] text-ppp-charcoal-400 shrink-0">
                {cash.totals.paymentCount} payment{cash.totals.paymentCount === 1 ? "" : "s"}
              </span>
            </div>
            {hasCash ? (
              <TrendChart data={cashSeries} yFormat="currency-k" colorToken="emerald-500" area heightClassName="h-[150px]" />
            ) : (
              <p className="py-10 text-center text-[12.5px] text-ppp-charcoal-500">
                No payments recorded in the last six months.
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-1 gap-3">
            {/* Same sparse-data honesty as the Cash flow view — these are the
                same two figures, so they must not read differently here. */}
            <Tile
              label="Days to pay"
              value={cash.totals.avgDaysToPay === null ? "—" : `${cash.totals.avgDaysToPay}d`}
              tone={!thinSample && cash.totals.avgDaysToPay !== null && cash.totals.avgDaysToPay > 60 ? "amber" : "navy"}
              sub={thinSample ? `from ${cash.totals.paymentCount} payment${cash.totals.paymentCount === 1 ? "" : "s"}` : "amount-weighted average"}
            />
            <Tile
              label="Collection rate"
              value={cash.totals.collectionRatePct === null ? "—" : `${cash.totals.collectionRatePct}%`}
              tone="neutral"
              // Above 100% is normal, not a bug — older invoices landing inside
              // the window. Saying so stops it being reported as one. Below a
              // handful of payments it's an anecdote, and says that instead.
              sub={thinSample ? "early days — too few payments to read" : "collected ÷ billed · over 100% means older invoices landed"}
            />
          </div>
        </div>
      </section>

      {/* ── 4 · What's out ────────────────────────────────────────────── */}
      <section className="space-y-2">
        <SectionHead
          title="Biggest outstanding"
          href={href("receivables")}
          hint="Top items. Chase notes live on the full report."
        />
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          {topRows.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-ppp-charcoal-500">
              Nothing outstanding. Every invoice is paid and no retention is being held.
            </p>
          ) : (
            <ul className="divide-y divide-ppp-charcoal-100">
              {topRows.map((r) => (
                <li key={r.key}>
                  <Link href={r.billingHref ?? r.href} className="flex items-start gap-3 px-3.5 py-2.5 hover:bg-ppp-charcoal-50/60 transition-colors">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-ppp-charcoal leading-snug truncate">{r.jobName}</div>
                      <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9.5px] font-bold uppercase tracking-wide ${KIND_META[r.kind].cls}`}>
                          {KIND_META[r.kind].label}
                        </span>
                        <span className="text-[11px] text-ppp-charcoal-500 truncate">{r.reference}</span>
                        {r.daysOut !== null && r.daysOut > 0 && (
                          <span className="text-[11px] font-semibold text-rose-700">{r.daysOut}d late</span>
                        )}
                      </div>
                      {r.note && (
                        <p className="text-[11px] text-ppp-charcoal-500 mt-0.5 italic truncate">{r.note}</p>
                      )}
                    </div>
                    <span className="font-condensed text-[16px] font-black tabular-nums shrink-0 text-ppp-charcoal">
                      {formatCentsCompact(r.openCents)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {restCount > 0 && (
            <Link
              href={href("receivables")}
              className="flex items-center px-3.5 py-2.5 text-[12px] font-semibold text-cc-brand-700 hover:bg-ppp-charcoal-50/60 border-t border-ppp-charcoal-100 min-h-[44px]"
            >
              {restCount} more open item{restCount === 1 ? "" : "s"} — see them all →
            </Link>
          )}
        </div>
      </section>

      {/* "Earned, not yet billed" was here — three tiles, and two of them
          printed the same figure.

          Karan 2026-09-17: "we can remove this from the accounting overview."
          On Tomco's book it read $122,060.49 ready to bill, $122,060.49
          contract left to bill, and $0.00 approved COs unbilled: the first two
          are the same number whenever no approved change order is waiting,
          which is the normal case, and the third is the difference between
          them. One fact wearing three tiles.

          The figure itself is not lost — it is the "Bill the work that is done"
          row on the dashboard work list, which is where somebody can act on it,
          and Job costs carries the per-job breakdown. */}

      {/* ── 6 · Where it went ─────────────────────────────────────────── */}
      <section className="space-y-2">
        <SectionHead
          title="What the work cost"
          href={href("costs")}
          hint="Real cost against what was billed."
        />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 grid grid-cols-2 gap-3 content-start">
            <Tile
              label="Margin"
              value={jobCosts.totals.marginPct === null ? "—" : `${jobCosts.totals.marginPct}%`}
              tone={marginTone}
              sub={`${formatCentsCompact(jobCosts.totals.marginCents)} on ${formatCentsCompact(jobCosts.totals.billedCents)} billed`}
            />
            <Tile
              label="Total cost"
              value={formatCentsFull(jobCosts.totals.totalCostCents)}
              tone="navy"
              sub={`across ${jobCosts.totals.dealCount} job${jobCosts.totals.dealCount === 1 ? "" : "s"}`}
            />
            <Tile
              label={`Vendor spend · ${coRange.label}`}
              value={formatCentsFull(coVendor.vendorTotalCents)}
              tone="neutral"
              sub="materials and subs paid out"
            />
            <Tile
              label="Unpriced labor"
              value={
                jobCosts.totals.laborUnratedHours > 0
                  ? `${jobCosts.totals.laborUnratedHours.toLocaleString("en-US", { maximumFractionDigits: 0 })}h`
                  : "None"
              }
              tone={jobCosts.totals.laborUnratedHours > 0 ? "amber" : "neutral"}
              // Unpriced hours understate cost, which overstates margin. Naming
              // that is the difference between a caveat and a wrong number.
              sub={jobCosts.totals.laborUnratedHours > 0 ? "not costed yet — margin reads high" : "every hour has a rate"}
            />
          </div>
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
            <h3 className="text-[13px] font-bold text-ppp-charcoal mb-2">Cost mix</h3>
            {costSegments.length > 0 ? (
              <DonutChart
                size={132}
                segments={costSegments}
                centerValue={formatCentsCompact(jobCosts.totals.totalCostCents)}
                centerLabel="total cost"
                legend
              />
            ) : (
              <p className="py-8 text-center text-[12.5px] text-ppp-charcoal-500">No costs logged yet.</p>
            )}
          </div>
        </div>
      </section>

      </>
      )}

      {/* ── Receivables, in place ──────────────────────────────────────── */}
      {/* Money in, on the view that answers "what is owed" — Mary reads the
          list and records the check against the line she is looking at. */}
      {view === "receivables" && entry && (
        <>
          {/* WHAT THIS NUMBER IS. Karan, 2026-09-16: "the receivables tab still
              shows 1.4 million almost while the sheet I gave you was just above
              300k, I'm so confused on what's going on."
              Both are right, and they answer different questions. This page is
              every job's CONTRACT less what has been collected — Tomco's four
              AIREF buildings alone are $922,563.91 of it, because the imported
              invoice for each is the whole contract. Mary's sheet is only what
              has been formally certified and is being chased, which for AIREF
              is one line: $177,733.93. The reconciler proves this page against
              Salesforce to the cent; her sheet is the narrower list, and it
              lives on the AR SHEET tab. */}
          <p className="text-[12px] rounded-lg border border-ppp-charcoal-200 bg-ppp-charcoal-50 px-3 py-2 text-ppp-charcoal-600">
            <strong className="text-ppp-charcoal">This is every job&rsquo;s contract less what has come in</strong> &mdash;
            including work not yet billed to the GC, which is why it is far larger than the chase list. What has been
            certified and is actually being chased is on the <Link href={href("ar")} className="font-semibold text-cc-brand-700 hover:underline">AR sheet</Link> tab.{" "}
            {/* Karan 2026-09-17: "write it here so we know." Receivables and
                Deposits are the two halves of the same money and nothing on
                either page said which was which. */}
            Money that has already arrived is on{" "}
            <Link href={href("deposits")} className="font-semibold text-cc-brand-700 hover:underline">Deposits</Link>.
          </p>
          {/* Entry forms are for the screen. On paper they are empty boxes. */}
          <div data-print-hide data-tour="accounting:record-payment">
            <RecordPaymentForm action={recordPaymentAction} invoices={entry.openInvoices} />
          </div>
        </>
      )}

      {view === "receivables" && receivablesView && (
        <section className="space-y-2.5">
          <SectionHead
            title="Every open item"
            hint="Biggest first. Write a note after a chase and it stays with the job."
          />
          {/* Drafting sits WITH the list it writes into, next to the filters —
              Karan: "the button should be near … maybe next to the biggest
              first button filter". Up in the brief block it was both far from
              the rows it affects and easy to read as a label. */}
          <div data-print-hide className="flex items-center gap-2 flex-wrap">
            <ReceivablesFilterBar q={q} basePath={BASE} extraParams={{ view: "receivables" }} gcOptions={receivablesView.gcOptions} />
            {/* THE STATEMENT, WHERE THE CHASING HAPPENS.
                Katie's list asks for an open-invoice statement, and it exists —
                but only on /commercial/invoices, behind picking a GC in the
                account filter, as a small underlined link. Karan: "Mary's stuff
                is all under the accounting page keep that in mind."

                This is the tab she chases from. She rings LMJ about
                $472,699.53, they ask her to send a statement, and from here
                there was no way to produce one.

                Only shown once a single GC is selected, because a statement is
                per customer — there is no such thing as a statement for the
                whole book. Same route the invoices page uses, so the two
                cannot render different documents. */}
            {q.accountId && (
              <a
                href={`/api/commercial/accounts/${q.accountId}/statement`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12.5px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px] sm:min-h-[38px]"
                title="Open-invoice statement for this GC — every unpaid item, as a PDF to send them."
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h5" />
                </svg>
                Statement
              </a>
            )}
            {canDraftNotes && silentRows > 0 && (
              <form action={draftNotesAction}>
                <input type="hidden" name="back" value={href(view)} />
                <PendingSubmitButton
                  pendingLabel="Drafting…"
                  title="Drafts a note for each open item that hasn't got one, from its dates and figures. Never touches a note somebody wrote."
                  className="inline-flex items-center gap-1.5 px-3 rounded-lg border border-cc-brand-200 bg-cc-brand-50 text-[12.5px] font-semibold text-cc-brand-800 hover:bg-cc-brand-100 transition-colors min-h-[44px] sm:min-h-[38px]"
                >
                  <span aria-hidden className="text-cc-brand-600">✦</span>
                  {silentRows === receivables.rows.length ? "Draft" : "Update"} {silentRows} read{silentRows === 1 ? "" : "s"}
                </PendingSubmitButton>
              </form>
            )}
          </div>
      {receivablesView.noDueDateCount > 0 && (
        // "Past due $0.00 · nothing late" is a TRUE sentence that means
        // something else: an item with no due date can never age into overdue,
        // AR aging files it as Current, and the dunning reminder skips it.
        // Three surfaces quietly agreeing it's fine.
        // Karan 2026-09-17: "what is this for?" It was written for a stray
        // invoice somebody forgot to date. It now fires on all 16, because the
        // dates these carried were ones the migration INVENTED — Salesforce has
        // no invoice due date to import, only payment terms — and they were
        // removed once that came to light. So it is stated as a fact rather
        // than an alarm: nothing here is wrong, and nothing is being chased
        // automatically either way.
        <p className="text-[12px] rounded-lg border px-3 py-2 border-ppp-charcoal-200 bg-ppp-charcoal-50 text-ppp-charcoal-600">
          <strong className="text-ppp-charcoal">{formatCentsFull(receivablesView.noDueDateCents)}</strong> across{" "}
          {receivablesView.noDueDateCount} open item{receivablesView.noDueDateCount === 1 ? "" : "s"} has no due date, so
          nothing here ages into 30/60/90. Salesforce holds payment terms but no invoice date, so these came across
          without one. Put a due date on an invoice when you bill it and it starts ageing from then.
        </p>
      )}
          {receivablesView.filtered && (
            <div className="flex items-center justify-between gap-3 flex-wrap text-[11.5px]">
              <span className="text-ppp-charcoal-500">
                Showing <strong className="text-ppp-charcoal">{receivablesView.rows.length}</strong> of{" "}
                {receivablesView.unfilteredCount} open item{receivablesView.unfilteredCount === 1 ? "" : "s"}
                {activeFilter ? ` · ${activeFilter}` : ""} ·{" "}
                <strong className="text-ppp-charcoal">{formatCentsFull(receivablesView.totalOpenCents)}</strong>
                {" "}in this view
                {/* Said explicitly, because the four tiles above the switcher
                    are the WHOLE book and would otherwise look contradictory. */}
                <span className="text-ppp-charcoal-400"> (tiles above are the whole book)</span>
              </span>
              {receivablesView.undatedExcluded > 0 && (
                <span className="text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1">
                  {receivablesView.undatedExcluded} hidden — no billing date recorded
                </span>
              )}
            </div>
          )}
          <ReceivablesTable
            rows={receivablesView.rows}
            totalOpenCents={receivablesView.totalOpenCents}
            saveNoteAction={saveNoteAction}
            queryString={receivableQueryString(q, { view: "receivables" })}
            backHref={`${BASE}${receivableQueryString(q, { view: "receivables" })}`}
            oppBackView="receivables"
            emptyMessage={
              receivablesView.filtered
                ? `Nothing matches this filter${activeFilter ? ` (${activeFilter})` : ""}. The book isn't empty — clear the filters to see all ${receivablesView.unfilteredCount}.`
                : undefined
            }
          />
        </section>
      )}

      {/* ── Transactions, in place ─────────────────────────────────────
             Alex's "Payments In by Month", natively — plus money out, so each
             month can show a net. ── */}
      {view === "transactions" && transactions && (
        <section className="space-y-2.5">
          <SectionHead
            title="Every transaction"
            hint="Money in and out, by the month it moved. Tick a payment once it clears the bank."
          />

          {/* His report's headline pair — Total Records and Total Amount —
              in his position, above the list. */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Records" value={transactions.rowCount.toLocaleString()} tone="neutral" sub={`${transactions.months.length} month${transactions.months.length === 1 ? "" : "s"}`} />
            <Tile label="Money in" value={formatCentsFull(transactions.inCents)} tone="emerald" sub="payments received" />
            <Tile label="Money out" value={formatCentsFull(transactions.outCents)} tone="amber" sub="purchases logged" />
            <Tile
              label="Net"
              value={formatCentsFull(transactions.netCents)}
              tone={transactions.netCents < 0 ? "rose" : "navy"}
              sub={transactions.netCents < 0 ? "more went out than came in" : "in − out"}
            />
          </div>

          {/* Undeposited — the money sitting in the office. This is the whole
              reason his report carries a Deposited column, and no other
              surface here can produce it. */}
          {transactions.undepositedCents > 0 && (
            <p className="text-[12px] rounded-lg border px-3 py-2 border-amber-200 bg-amber-50 text-amber-900">
              <strong>{formatCentsFull(transactions.undepositedCents)}</strong> received but not marked
              deposited, across {transactions.undepositedCount} payment
              {transactions.undepositedCount === 1 ? "" : "s"}.{" "}
              <Link href={`${BASE}${txQuery({ tundep: "1", td: "in" })}`} className="font-semibold underline">
                Show just those
              </Link>
            </p>
          )}

          {/* Filters — same one-line shape as the receivables bar. */}
          <div data-print-hide className="flex items-center gap-2 flex-wrap">
            <NavSelect
              label="Period"
              value={txPeriod}
              ariaLabel="Filter transactions by period"
              choices={ACTIVITY_PRESETS.map((p): NavChoice => ({
                value: p.key,
                label: p.label,
                href: `${BASE}${txQuery({ tp: p.key === LEDGER_DEFAULT ? null : p.key })}`,
              }))}
            />
            <NavSelect
              label="Type"
              value={txDirection}
              ariaLabel="Filter by money in or out"
              choices={[
                { value: "all", label: "In and out", href: `${BASE}${txQuery({ td: null })}` },
                { value: "in", label: "Payments in", href: `${BASE}${txQuery({ td: "in" })}` },
                { value: "out", label: "Purchases out", href: `${BASE}${txQuery({ td: "out" })}` },
              ]}
            />
            {transactions.partyOptions.length > 1 && (
              <NavSelect
                label="Who"
                value={txParty ?? ""}
                ariaLabel="Filter by GC or vendor"
                choices={[
                  { value: "", label: "Everyone", href: `${BASE}${txQuery({ tparty: null })}` },
                  ...transactions.partyOptions.map((o): NavChoice => ({
                    value: o.id,
                    label: o.name,
                    href: `${BASE}${txQuery({ tparty: o.id })}`,
                  })),
                ]}
              />
            )}
            <Link
              href={`${BASE}${txQuery({ tundep: txUndeposited ? null : "1" })}`}
              aria-pressed={txUndeposited}
              className={`inline-flex items-center px-3 rounded-lg text-[12.5px] font-semibold border transition-colors min-h-[44px] sm:min-h-[38px] touch-manipulation ${
                txUndeposited
                  ? "bg-amber-600 text-white border-amber-700"
                  : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
              }`}
            >
              Not deposited
            </Link>
            {transactions.filtered && (
              <Link href={`${BASE}?view=transactions`} className="text-[12px] font-semibold text-cc-brand-700 hover:underline inline-flex items-center min-h-[44px] sm:min-h-[38px] px-1">
                Clear
              </Link>
            )}
            <ExportCsvLink
              href="/api/commercial/reports/transactions/export"
              params={{
                ...(txPeriod !== LEDGER_DEFAULT ? { tp: txPeriod } : {}),
                ...(txDirection !== "all" ? { td: txDirection } : {}),
                ...(txParty ? { tparty: txParty } : {}),
                ...(txUndeposited ? { tundep: "1" } : {}),
              }}
              label="Export ledger"
              disabled={transactions.rowCount === 0}
              disabledHint="Nothing to export in this view"
            />
          </div>

          {/* Crew labor is a COST, not a transaction — no payment row exists
              for it — so it is absent here rather than invented. Said once,
              where somebody would otherwise go looking for it. */}
          <p className="text-[11px] text-ppp-charcoal-400">
            Crew labor isn&rsquo;t listed: it&rsquo;s costed from approved hours, not paid as a
            recorded transaction. It&rsquo;s in{" "}
            <Link href={href("costs")} className="font-semibold text-cc-brand-700 hover:underline">Job costs</Link>.
          </p>

          <TransactionsLedger
            report={transactions}
            depositAction={depositAction}
            queryString={txQuery()}
            backHref={`${BASE}${txQuery()}`}
            emptyMessage={
              transactions.filtered
                ? "Nothing moved in this view. Clear the filters to see the whole ledger."
                : undefined
            }
          />
        </section>
      )}

      {/* ── AR aging, in place ─────────────────────────────────────────── */}
      {view === "aging" && aging && (
        <section className="space-y-2">
          <SectionHead
            title="Who is late"
            hint="What's owed by how far past due — invoices and AIA applications. Retention is excluded: it's held, not late."
          />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Same wording as the AR-aging report itself. Both counts are
                open ITEMS — invoices and AIA applications — since AIA landed
                in this report on 2026-08-17. */}
            <Tile label="Total AR" value={formatCentsFull(aging.totals.total)} tone="brand" sub={`${aging.customerCount} GC${aging.customerCount === 1 ? "" : "s"} · ${aging.invoiceCount} open item${aging.invoiceCount === 1 ? "" : "s"}`} />
            <Tile label="Current" value={formatCentsFull(aging.totals.current)} tone="emerald" sub="not yet due" />
            <Tile
              label="Overdue"
              value={formatCentsFull(aging.totals.total - aging.totals.current)}
              tone={aging.totals.total - aging.totals.current > 0 ? "rose" : "neutral"}
              // Was the GC count, which read as "this many GCs are overdue" —
              // it is every GC with any AR at all, overdue or not.
              sub="past the due date"
            />
            <Tile
              label="Avg age"
              value={`${aging.weightedAvgAgeDays}d`}
              tone={aging.weightedAvgAgeDays > 45 ? "amber" : "neutral"}
              sub="weighted by balance"
            />
          </div>
          {/* The same caveat the AR-aging REPORT carries, on the tab that shows
              the same four numbers. Without it "Current $X · not yet due" and
              "Avg age 0d" can describe a book that is entirely overdue: an item
              with no due date cannot age, so it sits in Current. Tomco's 92
              migrated invoices are all like that, deliberately — a due date
              would arm the daily dunning email to their GCs — so this tab was
              showing a healthy-looking aging of a book it could not age. */}
          {aging.noDueDateCents > 0 && (
            <p className="text-[12px] rounded-lg border px-3 py-2 border-amber-200 bg-amber-50 text-amber-900">
              <strong>{formatCentsFull(aging.noDueDateCents)}</strong> across {aging.noDueDateCount} open item
              {aging.noDueDateCount === 1 ? " has" : "s have"} no due date, so {aging.noDueDateCount === 1 ? "it is" : "they are"} counted as
              Current here and can never show as overdue &mdash; the ageing above is only as complete as the due dates behind it. Set one on
              the invoice to bring {aging.noDueDateCount === 1 ? "it" : "them"} into the buckets.
            </p>
          )}
          {aging.rows.length === 0 ? (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl">
              <p className="px-4 py-10 text-center text-[13px] text-ppp-charcoal-500">
                No open receivables. Nothing is aging.
              </p>
            </div>
          ) : (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px] min-w-[720px]">
                  <thead>
                    <tr className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 bg-ppp-charcoal-50/60 text-left">
                      <th className="px-3 py-2.5">GC</th>
                      <th className="px-3 py-2.5 text-right">Current</th>
                      <th className="px-3 py-2.5 text-right">1&ndash;30</th>
                      <th className="px-3 py-2.5 text-right">31&ndash;60</th>
                      <th className="px-3 py-2.5 text-right">61&ndash;90</th>
                      <th className="px-3 py-2.5 text-right">90+</th>
                      <th className="px-3 py-2.5 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ppp-charcoal-100">
                    {aging.rows.map((r) => (
                      <tr key={r.accountId} className="hover:bg-cc-brand-50/30">
                        <td className="px-3 py-2.5">
                          <Link href={`/commercial/accounts/${r.accountId}`} className="font-semibold text-ppp-charcoal hover:text-cc-brand-700 hover:underline">
                            {r.accountName}
                          </Link>
                          <span className="block text-[10.5px] text-ppp-charcoal-400">
                            {/* "invoices" undercounted: the row includes this
                                GC's AIA applications too. */}
                            {r.invoiceCount} open · oldest {Math.max(0, r.oldestDays)}d
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-ppp-charcoal-500">{formatCentsCompact(r.current)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{formatCentsCompact(r.d1_30)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-amber-700">{formatCentsCompact(r.d31_60)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-amber-800">{formatCentsCompact(r.d61_90)}</td>
                        {/* Only 90+ is red. If four buckets shout, none do. */}
                        <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-rose-700">{formatCentsCompact(r.d90_plus)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-bold">{formatCentsFull(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-ppp-charcoal-200 bg-ppp-charcoal-50/60 font-bold">
                      <td className="px-3 py-2.5">All GCs</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatCentsCompact(aging.totals.current)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatCentsCompact(aging.totals.d1_30)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatCentsCompact(aging.totals.d31_60)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatCentsCompact(aging.totals.d61_90)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatCentsCompact(aging.totals.d90_plus)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatCentsFull(aging.totals.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Cash flow, in place ────────────────────────────────────────── */}
      {view === "cash" && (
        <section className="space-y-3">
          <SectionHead
            title="What actually arrived"
            hint="Money by the month it landed — a March invoice paid in July is July's cash."
          />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {/* Both figures are INVOICES only — this report reads the payment
                ledger, and an AIA job bills through G702/G703 with no invoice
                row. Said on the tiles, because the four tiles at the top of
                this page DO include AIA and the two would otherwise look like
                a contradiction. */}
            <Tile label="Collected · 6 mo" value={formatCentsFull(cash.totals.collectedCents)} tone="emerald" sub={`${cash.totals.paymentCount} payment${cash.totals.paymentCount === 1 ? "" : "s"} · invoices only`} />
            <Tile label="Billed · 6 mo" value={formatCentsFull(cash.totals.billedCents)} tone="navy" sub="invoices only, excludes AIA" />
            <Tile
              label="Days to pay"
              value={cash.totals.avgDaysToPay === null ? "—" : `${cash.totals.avgDaysToPay}d`}
              // A lag computed from one or two payments is an anecdote. Tone it
              // neutral until there's enough to mean anything, and say what it
              // came from either way.
              tone={thinSample ? "neutral" : cash.totals.avgDaysToPay !== null && cash.totals.avgDaysToPay > 60 ? "amber" : "neutral"}
              sub={
                cash.totals.paymentCount === 0
                  ? "no payments yet"
                  : thinSample
                    ? `from ${cash.totals.paymentCount} payment${cash.totals.paymentCount === 1 ? "" : "s"} — too few to read`
                    : "weighted by amount"
              }
            />
            <Tile
              label="Collection rate"
              value={cash.totals.collectionRatePct === null ? "—" : `${cash.totals.collectionRatePct}%`}
              tone="neutral"
              // "3%" under a red-looking tile reads as a crisis when it's
              // really one payment against a month of billing. Explain which
              // one it is instead of leaving a number to be misread.
              sub={
                cash.totals.collectionRatePct === null
                  ? "nothing billed in this window"
                  : thinSample
                    ? `${formatCentsCompact(cash.totals.collectedCents)} in against ${formatCentsCompact(cash.totals.billedCents)} billed — early days`
                    : "collected ÷ billed · over 100% means older invoices landed"
              }
            />
          </div>
          {/* A one-month series is handled inside TrendChart itself — it says
              so plainly rather than drawing a lone dot. One definition, so
              every chart on the platform behaves the same. */}
          {hasCash && (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
              <h3 className="text-[13px] font-bold text-ppp-charcoal mb-2">Collected / month</h3>
              <TrendChart data={cashSeries} yFormat="currency-k" colorToken="emerald-500" area heightClassName="h-[160px]" />
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <MiniTable
              title="How they pay"
              head={["Method", "Collected", "Payments"]}
              rows={cash.byMethod.map((m) => [m.label, formatCentsFull(m.collectedCents), String(m.count)])}
              empty="No payments recorded in this window."
            />
            {/* A "slowest" list with one name in it isn't a ranking, it's a
                customer. Needs at least two to compare. */}
            <MiniTable
              title="Slowest to pay"
              head={["GC", "Avg days", "Still open"]}
              rows={
                cash.slowest.length >= 2
                  ? cash.slowest.map((sp) => [
                      sp.accountName,
                      sp.avgDaysToPay === null ? "—" : `${sp.avgDaysToPay}d`,
                      formatCentsFull(sp.openCents),
                    ])
                  : []
              }
              empty={
                cash.slowest.length === 1
                  ? `Only ${cash.slowest[0].accountName} has paid in this window — nothing to rank them against yet.`
                  : "Not enough paid invoices to rank anyone yet."
              }
            />
          </div>
          {(cash.untimedPayments > 0 || cash.paidBeforeIssued > 0) && (
            // Said out loud rather than quietly excluded — otherwise days-to-pay
            // reads as more precise than the underlying data supports.
            <p className="text-[11.5px] text-ppp-charcoal-500 bg-ppp-charcoal-50 border border-ppp-charcoal-100 rounded-lg px-3 py-2">
              {cash.untimedPayments > 0 && `${cash.untimedPayments} payment${cash.untimedPayments === 1 ? "" : "s"} had no invoice issue date, so they're excluded from days-to-pay. `}
              {cash.paidBeforeIssued > 0 && `${cash.paidBeforeIssued} arrived before the invoice was issued (deposits) and count as same-day.`}
            </p>
          )}
        </section>
      )}

      {/* ── Job costs, in place ────────────────────────────────────────── */}
      {view === "costs" && (
        <section className="space-y-3">
          <SectionHead
            title="Cost against contract"
            hint="Every job with a contract or a cost, grouped by GC."
          />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Contract" value={formatCentsFull(jobCosts.totals.contractCents)} tone="navy" sub={`${jobCosts.totals.dealCount} job${jobCosts.totals.dealCount === 1 ? "" : "s"}`} />
            <Tile label="Billed" value={formatCentsFull(jobCosts.totals.billedCents)} tone="brand" />
            <Tile label="Cost" value={formatCentsFull(jobCosts.totals.totalCostCents)} tone="amber" />
            <Tile
              label="Margin"
              value={jobCosts.totals.marginPct === null ? "—" : `${jobCosts.totals.marginPct}%`}
              tone={marginTone}
              sub={formatCentsCompact(jobCosts.totals.marginCents)}
            />
          </div>
          {jobCosts.groups.length === 0 ? (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl">
              <p className="px-4 py-10 text-center text-[13px] text-ppp-charcoal-500">
                No jobs with a contract or a logged cost yet.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {jobCosts.groups.map((g) => (
                <div key={g.accountId} className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
                  <div className="flex items-baseline justify-between gap-2 px-3.5 py-2.5 bg-ppp-charcoal-50/60 border-b border-ppp-charcoal-100 flex-wrap">
                    <Link href={`/commercial/accounts/${g.accountId}`} className="text-[13px] font-bold text-ppp-charcoal hover:text-cc-brand-700 hover:underline">
                      {g.accountName}
                    </Link>
                    <span className="text-[11.5px] text-ppp-charcoal-500 tabular-nums">
                      {formatCentsCompact(g.billedCents)} billed · {formatCentsCompact(g.totalCostCents)} cost ·{" "}
                      <strong className={g.marginPct !== null && g.marginPct < 15 ? "text-amber-700" : "text-emerald-700"}>
                        {g.marginPct === null ? "—" : `${g.marginPct}%`}
                      </strong>
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12.5px] min-w-[620px]">
                      <thead>
                        <tr className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 text-left">
                          <th className="px-3 py-2">Job</th>
                          <th className="px-3 py-2 text-right">Contract</th>
                          <th className="px-3 py-2 text-right">Billed</th>
                          <th className="px-3 py-2 text-right">Cost</th>
                          <th className="px-3 py-2 text-right">Margin</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-ppp-charcoal-100">
                        {g.deals.map((d) => (
                          <tr key={d.oppId} className="hover:bg-cc-brand-50/30">
                            <td className="px-3 py-2">
                              {/* Same one-hop rule as Purchases: the job opens
                                  the costs tool — where you actually add to
                                  what this row shows — and carries this tab
                                  back with it. */}
                              <Link href={costToolHref(d.oppId, "costs") ?? `/commercial/opportunities/${d.oppId}`} className="font-semibold text-ppp-charcoal hover:text-cc-brand-700 hover:underline">
                                {d.dealName}
                              </Link>
                              {d.laborUnratedHours > 0 && (
                                // Unpriced hours understate cost, which overstates
                                // this row's margin. Flagged on the row it distorts.
                                <span className="block text-[10.5px] text-amber-700">
                                  {d.laborUnratedHours.toLocaleString("en-US", { maximumFractionDigits: 0 })}h unpriced — margin reads high
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatCentsCompact(d.contractCents)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatCentsCompact(d.billedCents)}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-amber-700">{formatCentsCompact(d.totalCostCents)}</td>
                            <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                              d.marginPct === null ? "text-ppp-charcoal-300"
                              : d.marginPct < 0 ? "text-rose-700"
                              : d.marginPct < 15 ? "text-amber-700"
                              : "text-emerald-700"
                            }`}>
                              {d.marginPct === null ? "—" : `${d.marginPct}%`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Sales tax, in place ────────────────────────────────────────
             A filing needs the collected total; the number that COSTS money is
             the exempt one with no certificate behind it. ── */}
      {view === "tax" && salesTax && (
        <section className="space-y-2.5">
          <SectionHead
            title="Sales tax"
            hint="What was charged, and what wasn't — with the paperwork behind each exemption."
          />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Tax collected" value={formatCentsFull(salesTax.taxCollectedCents)} tone="brand" sub={`on ${formatCentsCompact(salesTax.taxableBaseCents)} taxable`} />
            <Tile label="Taxable base" value={formatCentsFull(salesTax.taxableBaseCents)} tone="navy" sub="pre-tax, invoices that carried tax" />
            <Tile label="Billed exempt" value={formatCentsFull(salesTax.exemptBaseCents)} tone="neutral" sub={`${salesTax.exemptCount} invoice${salesTax.exemptCount === 1 ? "" : "s"}`} />
            <Tile
              label="No certificate"
              value={formatCentsFull(salesTax.uncertifiedBaseCents)}
              tone={salesTax.uncertifiedCount > 0 ? "rose" : "emerald"}
              sub={salesTax.uncertifiedCount > 0 ? `${salesTax.uncertifiedCount} exempt invoice${salesTax.uncertifiedCount === 1 ? "" : "s"}` : "every exemption documented"}
            />
          </div>

          {salesTax.unmarkedCount - salesTax.unmarkedMigratedCount > 0 && (
            // The worse of the two, so it gets its own line above the other.
            // In NY everything is taxable unless an exemption is CLAIMED — so
            // an invoice that charged no tax on a job nobody marked exempt is
            // most likely under-billed, not missing a document.
            //
            // MIGRATED INVOICES ARE EXCLUDED from this count (below). Tomco
            // billed those correctly in Salesforce years ago; the exemption is
            // recorded there and the importer brought the money across, not the
            // certificates. Counting them here opened the report accusing Tomco
            // of under-billing $2.5M on work that was invoiced properly.
            <p className="text-[12px] rounded-lg border px-3 py-2 border-rose-300 bg-rose-100 text-rose-900">
              <strong>{salesTax.unmarkedCount - salesTax.unmarkedMigratedCount}</strong> invoice
              {salesTax.unmarkedCount - salesTax.unmarkedMigratedCount === 1 ? "" : "s"} charged no tax on a job that was never marked
              exempt — {formatCentsFull(salesTax.unmarkedBaseCents - salesTax.unmarkedMigratedBaseCents)} of work. That is usually tax
              that should have been billed, not a certificate that&rsquo;s missing.
            </p>
          )}
          {salesTax.unmarkedMigratedCount > 0 && (
            <p className="text-[12px] rounded-lg border px-3 py-2 border-ppp-charcoal-200 bg-ppp-charcoal-50 text-ppp-charcoal-600">
              <strong>{salesTax.unmarkedMigratedCount}</strong> invoice
              {salesTax.unmarkedMigratedCount === 1 ? " that" : "s that"} came across from Salesforce charged no tax
              ({formatCentsFull(salesTax.unmarkedMigratedBaseCents)} of work) and carry no exemption here. The
              exemption for those sits in Salesforce &mdash; the migration brought the money, not the certificates &mdash;
              so they are listed but not counted as under-billed.
            </p>
          )}
          {salesTax.noCertCount > 0 && (
            // The whole reason to build this rather than just total the tax
            // column: an exemption you can't produce a certificate for is an
            // assessment waiting to happen.
            <p className="text-[12px] rounded-lg border px-3 py-2 border-rose-200 bg-rose-50 text-rose-900">
              <strong>{salesTax.noCertCount}</strong> invoice
              {salesTax.noCertCount === 1 ? " is" : "s are"} marked exempt with no certificate on file —{" "}
              {formatCentsFull(salesTax.noCertBaseCents)} of work. NY capital-improvement exemptions are
              per-project, so the certificate belongs on the job that claimed it.{" "}
              <Link href={`${BASE}?view=tax&nocert=1${txPeriod !== LEDGER_DEFAULT ? `&tp=${txPeriod}` : ""}`} className="font-semibold underline">
                Show just those
              </Link>
            </p>
          )}

          <div data-print-hide className="flex items-center gap-2 flex-wrap">
            <NavSelect
              label="Issued"
              value={txPeriod}
              ariaLabel="Filter sales tax by period"
              choices={ACTIVITY_PRESETS.map((p): NavChoice => ({
                value: p.key,
                label: p.label,
                href: `${BASE}?view=tax${p.key === LEDGER_DEFAULT ? "" : `&tp=${p.key}`}${pickFirst(sp.nocert) === "1" ? "&nocert=1" : ""}`,
              }))}
            />
            {pickFirst(sp.nocert) === "1" && (
              <Link href={`${BASE}?view=tax${txPeriod !== LEDGER_DEFAULT ? `&tp=${txPeriod}` : ""}`} className="text-[12px] font-semibold text-cc-brand-700 hover:underline inline-flex items-center min-h-[44px] sm:min-h-[38px] px-1">
                Show all invoices
              </Link>
            )}
            <ExportCsvLink
              href="/api/commercial/reports/sales-tax/export"
              params={{
                ...(txPeriod !== LEDGER_DEFAULT ? { tp: txPeriod } : {}),
                ...(pickFirst(sp.nocert) === "1" ? { nocert: "1" } : {}),
              }}
              label="Export for filing"
              disabled={salesTax.rows.length === 0}
              disabledHint="Nothing to export in this view"
            />
          </div>

          {salesTax.byRate.length > 1 && (
            <MiniTable
              title="By rate"
              head={["Rate", "Taxable base", "Tax"]}
              rows={salesTax.byRate.map((r) => [
                `${r.taxPct.toFixed(3).replace(/\.?0+$/, "")}%`,
                formatCentsFull(r.baseCents),
                formatCentsFull(r.taxCents),
              ])}
              empty="No tax charged in this window."
            />
          )}

          {salesTax.rows.length === 0 ? (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl">
              <p className="px-4 py-10 text-center text-[13px] text-ppp-charcoal-500">
                No issued invoices in this window.
              </p>
            </div>
          ) : (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px] min-w-[760px]">
                  <thead>
                    <tr className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 bg-ppp-charcoal-50/60 text-left">
                      <th className="px-3 py-2.5">Invoice</th>
                      <th className="px-3 py-2.5">Job</th>
                      <th className="px-3 py-2.5 text-right">Taxable base</th>
                      <th className="px-3 py-2.5 text-right">Rate</th>
                      <th className="px-3 py-2.5 text-right">Tax</th>
                      <th className="px-3 py-2.5">Exemption</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ppp-charcoal-100">
                    {salesTax.rows.map((r) => (
                      <tr key={r.invoiceId} className="hover:bg-cc-brand-50/30">
                        <td className="px-3 py-2.5">
                          <Link href={r.href} className="font-semibold text-ppp-charcoal hover:text-cc-brand-700 hover:underline">{r.invoiceNumber}</Link>
                          <span className="block text-[10.5px] text-ppp-charcoal-400 tabular-nums">{r.issuedYmd}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="text-ppp-charcoal">{r.jobName}</span>
                          <span className="block text-[10.5px] text-ppp-charcoal-400">{r.accountName}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{formatCentsFull(r.subtotalCents)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-ppp-charcoal-500">
                          {r.exempt ? "—" : `${r.taxPct.toFixed(3).replace(/\.?0+$/, "")}%`}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{r.exempt ? "—" : formatCentsFull(r.taxCents)}</td>
                        <td className="px-3 py-2.5">
                          {!r.exempt ? (
                            <span className="text-ppp-charcoal-400">Taxed</span>
                          ) : r.certNumber ? (
                            <span className="text-emerald-700">
                              Cert #{r.certNumber}
                              <span className="block text-[10px] text-ppp-charcoal-400">
                                {r.exemptSource === "opportunity" ? "on the job" : "on the account"}
                              </span>
                            </span>
                          ) : r.exemptKind === "unmarked" ? (
                            <span className="text-rose-700 font-semibold">
                              Never marked exempt
                              <span className="block text-[10px] font-normal text-rose-700">
                                no tax charged
                              </span>
                            </span>
                          ) : (
                            <span className="text-rose-700 font-semibold">No certificate</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-ppp-charcoal-200 bg-ppp-charcoal-50/60 font-bold">
                      <td className="px-3 py-2.5" colSpan={2}>Total</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatCentsFull(salesTax.taxableBaseCents + salesTax.exemptBaseCents)}</td>
                      <td />
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatCentsFull(salesTax.taxCollectedCents)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── Reimbursements, in place ───────────────────────────────────
             His report lists what was PAID. What's still OWED is the half
             nobody has: nobody chases the company for $40 of caulk. ── */}
      {view === "reimbursements" && reimbursements && (
        <section className="space-y-2.5">
          <SectionHead
            title="Reimbursements"
            hint="Money someone fronted for a job. Outstanding first — nobody chases the company for it."
          />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile
              label="Owed out"
              value={formatCentsFull(reimbursements.owedCents)}
              tone={reimbursements.owedCents > 0 ? "amber" : "emerald"}
              sub={reimbursements.owed.length > 0 ? `${reimbursements.owed.length} item${reimbursements.owed.length === 1 ? "" : "s"}` : "everyone's square"}
            />
            <Tile label="People owed" value={String(reimbursements.byPerson.length)} tone="navy" sub={reimbursements.byPerson[0] ? `longest ${reimbursements.byPerson[0].oldestDays}d` : "none"} />
            <Tile label="Paid back" value={formatCentsFull(reimbursements.settledCents)} tone="emerald" sub={`${reimbursements.settled.length} in this window`} />
            <Tile
              label="No receipt"
              value={String(reimbursements.noReceiptCount)}
              tone={reimbursements.noReceiptCount > 0 ? "amber" : "neutral"}
              sub={reimbursements.noReceiptCount > 0 ? "attach before paying" : "all documented"}
            />
          </div>

          <div data-print-hide className="flex items-center gap-2 flex-wrap">
            <NavSelect
              label="Paid back"
              value={txPeriod}
              ariaLabel="Filter settled reimbursements by period"
              choices={ACTIVITY_PRESETS.map((p): NavChoice => ({
                value: p.key,
                label: p.label,
                href: `${BASE}?view=reimbursements${p.key === LEDGER_DEFAULT ? "" : `&tp=${p.key}`}`,
              }))}
            />
            <span className="text-[11px] text-ppp-charcoal-400">
              {/* Said out loud: the period narrows the settled list only. */}
              Narrows what was paid back — everything still owed always shows.
            </span>
          </div>

          {reimbursements.byPerson.length > 0 && (
            <MiniTable
              title="Owed, by person"
              head={["Person", "Owed", "Waiting"]}
              rows={reimbursements.byPerson.map((p) => [
                p.person,
                formatCentsFull(p.owedCents),
                `${p.oldestDays}d`,
              ])}
              empty="Nobody is owed anything."
            />
          )}

          <ReimbursementList
            title="Still owed"
            rows={reimbursements.owed}
            settleAction={settleReimbursementAction}
            empty="Nothing outstanding — everyone has been paid back."
            settled={false}
          />
          <ReimbursementList
            title="Paid back"
            rows={reimbursements.settled}
            settleAction={settleReimbursementAction}
            empty="Nothing was paid back in this window."
            settled
          />
        </section>
      )}

      {/* ── Mary's four Tomco reports ──────────────────────────────────
             Each is the same object: records grouped, subtotalled, totalled —
             the shape she reads in Salesforce. The definitions live in
             lib/commercial/reports/tomco/ and are shared, so the numbers here
             and anywhere else they appear cannot drift apart. ── */}
      {view === "ar" && arRows && (
        <section className="space-y-3">
          <SectionHead
            title={AR_APPLICATIONS_SPEC.title}
            hint="What is certified and waiting to be paid. Retention on its own line."
          />
        {/* GROUP BY + PERIOD. Karan 2026-09-17: "AR sheet filters such as 30
            days, 90 days etc" and "give us like views by account or something."

            Both already existed in the data and neither was reachable: the spec
            has declared four groupings (Job · Source · GC · Month) since it was
            written, and the page passed no `groupingIndex` and no `controls`,
            so it was permanently stuck on the first one.

            ALL TIME IS THE DEFAULT, and that is not a preference. Every one of
            Mary's 23 carried-over lines has `issuedYmd = null` — she writes the
            job by hand and they are not linked to a certificate — so a period
            filter that dropped undated rows would today show an EMPTY AR sheet
            worth $0 against a real $314,048.14. Undated lines are kept in every
            period and counted in the total; the period narrows the dated ones. */}
        <GroupedReport
          spec={AR_APPLICATIONS_SPEC}
          rows={arRowsFiltered ?? arRows}
          groupingIndex={arGroup}
          controls={
            <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Group by</span>
                {AR_APPLICATIONS_SPEC.groupings.map((g, i) => (
                  <Link
                    key={g[0]?.key ?? i}
                    href={arControlHref({ group: i })}
                    aria-current={i === arGroup ? "true" : undefined}
                    className={`inline-flex items-center px-2.5 rounded-lg text-[12px] font-semibold min-h-[36px] border transition-colors ${
                      i === arGroup
                        ? "bg-cc-brand-600 text-white border-cc-brand-600"
                        : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
                    }`}
                  >
                    {g[0]?.label ?? `View ${i + 1}`}
                  </Link>
                ))}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Period</span>
                {AR_PERIODS.map((p) => (
                  <Link
                    key={p.key}
                    href={arControlHref({ period: p.key })}
                    aria-current={p.key === arPeriod ? "true" : undefined}
                    className={`inline-flex items-center px-2.5 rounded-lg text-[12px] font-semibold min-h-[36px] border transition-colors ${
                      p.key === arPeriod
                        ? "bg-cc-brand-600 text-white border-cc-brand-600"
                        : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"
                    }`}
                  >
                    {p.label}
                  </Link>
                ))}
              </div>
              {arUndatedKept > 0 && arPeriod !== "all" && (
                <span className="text-[11px] text-ppp-charcoal-500">
                  Includes {arUndatedKept} undated {arUndatedKept === 1 ? "line" : "lines"} from Mary&rsquo;s sheet — they have no
                  certificate date to filter on.
                </span>
              )}
            </div>
          }
          emptyHint="Nothing is certified and waiting. Raise an application on a job, or add a line below."
        />

        {/* HER SHEET STAYS HERS. Every line can be corrected or removed, and a
            line can be added before its certificate exists here. A copied line
            removed is the signal that its real certificate has been raised —
            which is what stops the two ever counting twice. */}
        <details className="bg-surface border border-ppp-charcoal-100 rounded-xl">
          <summary className="list-none cursor-pointer px-4 py-3 text-[13px] font-bold text-ppp-charcoal min-h-[44px] flex items-center gap-1.5">
            Edit the sheet
            <span className="font-semibold text-ppp-charcoal-400">— correct a line, remove one, or add one</span>
          </summary>
          <div className="px-4 pb-4 space-y-4">
            <form action={editArRowAction} className="grid grid-cols-1 sm:grid-cols-[1fr_9rem_1fr_auto] gap-2 items-end">
              <input type="hidden" name="intent" value="add" />
              <label className="block">
                <span className={LABEL_CLS}>Job *</span>
                <input name="job" required placeholder="As you write it" className={INPUT_CLS} />
              </label>
              <label className="block">
                <span className={LABEL_CLS}>Billed / open *</span>
                <input name="amount" required inputMode="decimal" placeholder="0.00" className={INPUT_CLS} />
              </label>
              <label className="block">
                <span className={LABEL_CLS}>Notes</span>
                <input name="note" placeholder="AIA#4 - 7/22/26 — revision sent" className={INPUT_CLS} />
              </label>
              <PendingSubmitButton
                pendingLabel="Adding…"
                className="inline-flex items-center justify-center px-3 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px]"
              >
                Add line
              </PendingSubmitButton>
            </form>

            {arRows.filter((r) => r.carriedOver).length > 0 && (
              <ul className="divide-y divide-ppp-charcoal-100 border-t border-ppp-charcoal-100">
                {arRows
                  .filter((r) => r.carriedOver)
                  .map((r) => (
                    <li key={r.id} className="py-2.5">
                      <form action={editArRowAction} className="grid grid-cols-1 sm:grid-cols-[1fr_9rem_1fr_auto_auto] gap-2 items-end">
                        <input type="hidden" name="id" value={r.id} />
                        <label className="block">
                          <span className={LABEL_CLS}>Job</span>
                          <input name="job" defaultValue={r.jobName} className={INPUT_CLS} />
                        </label>
                        <label className="block">
                          <span className={LABEL_CLS}>Billed / open</span>
                          <input name="amount" defaultValue={(r.openCents / 100).toFixed(2)} inputMode="decimal" className={INPUT_CLS} />
                        </label>
                        <label className="block">
                          <span className={LABEL_CLS}>Notes</span>
                          <input name="note" defaultValue={r.notes ?? ""} className={INPUT_CLS} />
                        </label>
                        <PendingSubmitButton
                          pendingLabel="Saving…"
                          className="inline-flex items-center justify-center px-3 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12.5px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 min-h-[44px]"
                        >
                          Save
                        </PendingSubmitButton>
                        {/* Its own form: PendingSubmitButton carries no name/value,
                            and a second submit in the same form would post the
                            edit fields as a removal. */}
                      </form>
                      <form action={editArRowAction} className="mt-1.5">
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="intent" value="clear" />
                        <PendingSubmitButton
                          pendingLabel="Removing…"
                          title="Remove this line — do this once its certificate is raised here"
                          className="inline-flex items-center justify-center px-3 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12px] font-semibold text-ppp-charcoal-500 hover:border-rose-300 hover:text-rose-700 min-h-[38px]"
                        >
                          Remove
                        </PendingSubmitButton>
                      </form>
                    </li>
                  ))}
              </ul>
            )}

            {/* REMOVED LINES — the undo that never existed.
                Remove used to be one-way: the line vanished from the sheet,
                the AR total dropped, and the only way to notice was
                remembering it had been there. `clearedCarryoverRows` was
                written for exactly this list and had no caller.
                Hand-added lines are not here — `removeAddedArRow` deletes
                them outright, so promising them back would be a lie. */}
            {arClearedRows.length > 0 && (
              <details className="mt-4 border-t border-ppp-charcoal-100 pt-3">
                <summary className="cursor-pointer text-[12.5px] font-semibold text-ppp-charcoal-600 hover:text-ppp-charcoal select-none min-h-[44px] sm:min-h-0 flex items-center">
                  Removed lines · {arClearedRows.length}
                </summary>
                <p className="mt-1.5 text-[12px] text-ppp-charcoal-500">
                  Ticked off the sheet. Put one back if it was removed by mistake
                  or the certificate hasn&rsquo;t actually been raised yet.
                </p>
                <ul className="mt-2 divide-y divide-ppp-charcoal-100">
                  {arClearedRows.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium text-ppp-charcoal truncate">{r.jobName}</div>
                        <div className="text-[11.5px] text-ppp-charcoal-500 truncate">
                          {/* Exact, not fmtMoneyK: this is a receivable being
                              put back on a sheet Mary reconciles to the cent. */}
                          {(r.openCents / 100).toLocaleString("en-US", {
                            style: "currency",
                            currency: "USD",
                          })}
                          {r.notes ? ` · ${r.notes}` : ""}
                        </div>
                      </div>
                      <form action={editArRowAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <input type="hidden" name="intent" value="restore" />
                        <PendingSubmitButton
                          pendingLabel="Putting back…"
                          className="inline-flex items-center justify-center px-3 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50 min-h-[38px]"
                        >
                          Put back
                        </PendingSubmitButton>
                      </form>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </details>
        </section>
      )}

      {view === "owed" && owedRows && (
        <section className="space-y-3">
          <SectionHead title={BALANCE_OWED_SPEC.title} hint={BALANCE_OWED_SPEC.blurb ?? ""} />
        <GroupedReport
          spec={BALANCE_OWED_SPEC}
          rows={[...owedRows].sort((a, b) => b.balanceCents - a.balanceCents)}
          emptyHint="Nothing is finished-and-unpaid right now."
        />
        </section>
      )}

      {view === "purchases" && entry && (
        <div data-print-hide data-tour="accounting:record-purchase">
          <RecordPurchaseForm action={recordSpendAction} jobs={entry.jobs} vendors={entry.vendors} />
        </div>
      )}

      {view === "purchases" && spendRows && (
        <section className="space-y-3" id="register" style={{ scrollMarginTop: "1rem" }}>
          <SectionHead title={PURCHASES_BY_VENDOR_SPEC.title} hint={PURCHASES_BY_VENDOR_SPEC.blurb ?? ""} />
        <SpendPeriodBar
          active={period}
          hrefFor={(k) => periodHref("purchases", k)}
          rowCount={filterToSpendPeriod(purchaseRows(spendRows), period).length}
          undated={undatedCount(purchaseRows(spendRows))}
        />
        <GroupedReport
          spec={PURCHASES_BY_VENDOR_SPEC}
          rows={filterToSpendPeriod(purchaseRows(spendRows), period)}
          emptyHint="No purchases in this period."
        />
        </section>
      )}

      {view === "payroll" && payroll && (
        <section className="space-y-3" id="register" style={{ scrollMarginTop: "1rem" }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionHead
              title="Payroll"
              hint="Hours to Gusto, the real cost back, split across jobs by hours."
            />
            <PayrollWeekHeader
              startDate={payroll.week.startDate}
              endDate={payroll.week.endDate}
              prevHref={`${BASE}?view=payroll&week=${shiftWeek(payroll.start, -7)}#register`}
              nextHref={`${BASE}?view=payroll&week=${shiftWeek(payroll.start, 7)}#register`}
              todayHref={`${BASE}?view=payroll&week=${payroll.thisWeek}#register`}
              isThisWeek={payroll.start === payroll.thisWeek}
            />
          </div>
          <PayrollWeekPanels
            week={payroll.week}
            saveCostsAction={savePayrollCostsAction}
            postAction={postPayrollAction}
            selectedJobId={pickFirst(sp.job) ?? null}
            basePath={`${BASE}?view=payroll&week=${payroll.start}`}
            // Same reason as the period links: the detail panel is below the fold.
            lastHoursWeekHref={
              // The raw day, not its Monday — the page normalises any `week`
              // to a Monday on the way in, so there is one place that does it.
              payroll.week.lastW2HoursDate
                ? `${BASE}?view=payroll&week=${payroll.week.lastW2HoursDate}`
                : null
            }
            // Carries the exact week back, so approving an hour does not cost
            // her the trip through Accounting → Payroll → find the week again.
            approvalsHref={`/commercial/field-ops/approvals?return=${encodeURIComponent(
              `${BASE}?view=payroll&week=${payroll.start}`,
            )}`}
            laborPaymentsHref={`${BASE}?view=labor-out`}
          />
        </section>
      )}

      {view === "labor-out" && entry && (
        <div data-print-hide data-tour="accounting:record-labor">
          <RecordLaborPaymentForm action={recordSpendAction} jobs={entry.jobs} payees={entry.payees} />
        </div>
      )}

      {view === "labor-out" && spendRows && (
        <section className="space-y-3" id="register" style={{ scrollMarginTop: "1rem" }}>
          <SectionHead title={LABOR_PAYMENTS_SPEC.title} hint={LABOR_PAYMENTS_SPEC.blurb ?? ""} />
        <SpendPeriodBar
          active={period}
          hrefFor={(k) => periodHref("labor-out", k)}
          rowCount={filterToSpendPeriod(laborPaymentRows(spendRows), period).length}
          undated={undatedCount(laborPaymentRows(spendRows))}
        />
        <GroupedReport
          spec={LABOR_PAYMENTS_SPEC}
          rows={filterToSpendPeriod(laborPaymentRows(spendRows), period)}
          emptyHint="No crew payments in this period."
        />
        </section>
      )}

      {/* WON, NOT INVOICED — the jobs behind the line on the Overview.
          Karan 2026-09-17: "when I click the 19 it brings me to the dashboard
          — can we have all those jobs go in there." A figure you cannot open
          is a figure you cannot act on. */}
      {view === "unbilled" && (
        <section className="space-y-3">
          <SectionHead
            title="Won, not invoiced"
            hint="Won work with no invoice raised against it. Open a job to raise one — it is the fastest cash there is."
          />
          {wonNotBilled.length === 0 ? (
            <div className="text-center py-14 px-4 bg-surface border border-ppp-charcoal-100 rounded-xl">
              <p className="text-sm font-semibold text-ppp-charcoal">Everything won has been invoiced</p>
              <p className="text-[12px] text-ppp-charcoal-500 mt-1">Nothing is sitting unbilled.</p>
            </div>
          ) : (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse">
                  <thead>
                    <tr className="bg-ppp-charcoal-50 border-b border-ppp-charcoal-100">
                      <th scope="col" className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500">Job</th>
                      <th scope="col" className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 hidden sm:table-cell">GC</th>
                      <th scope="col" className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500">Stage</th>
                      <th scope="col" className="px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500">Contract</th>
                      <th scope="col" className="px-3 py-2 text-right text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500">Not invoiced</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...wonNotBilled]
                      .sort((a, b) => b.draftedCents - a.draftedCents)
                      .map((p) => (
                        <tr key={p.opp.id} className="border-t border-ppp-charcoal-50 hover:bg-ppp-charcoal-50/40">
                          <td className="px-3 py-2 text-[12.5px]">
                            <Link
                              href={`/commercial/opportunities/${p.opp.id}?tab=project&sub=invoices`}
                              className="font-semibold text-cc-brand-700 hover:underline"
                            >
                              {derivedOppName({ ...p.opp, title: p.opp.title ?? "" }, p.accountName)}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-[12.5px] text-ppp-charcoal-600 hidden sm:table-cell">{p.accountName}</td>
                          <td className="px-3 py-2 text-[12.5px] text-ppp-charcoal-600">
                            {oppStatusDisplayLabel(p.opp.status, p.opp.sub_status)}
                          </td>
                          <td className="px-3 py-2 text-[12.5px] text-right tabular-nums">{formatCentsFull(p.contractToDateCents)}</td>
                          <td className="px-3 py-2 text-[12.5px] text-right tabular-nums font-bold text-ppp-charcoal">
                            {formatCentsFull(p.draftedCents)}
                          </td>
                        </tr>
                      ))}
                    <tr className="bg-ppp-charcoal-100/80 border-t-2 border-ppp-charcoal-300">
                      <td className="px-3 py-2 text-[12px] font-black text-ppp-charcoal">Total ({wonNotBilledJobs})</td>
                      <td className="hidden sm:table-cell" />
                      <td />
                      <td />
                      <td className="px-3 py-2 text-[12.5px] text-right tabular-nums font-black text-ppp-charcoal">
                        {formatCentsFull(wonNotBilledCents)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {view === "deposits" && depositRows && (
        <section className="space-y-3" id="register" style={{ scrollMarginTop: "1rem" }}>
          <SectionHead title={DEPOSIT_HISTORY_SPEC.title} hint={DEPOSIT_HISTORY_SPEC.blurb ?? ""} />
        <SpendPeriodBar
          active={period}
          hrefFor={(k) => periodHref("deposits", k)}
          rowCount={filterToSpendPeriod(depositRows, period).length}
          undated={undatedCount(depositRows)}
        />
        <GroupedReport
          spec={DEPOSIT_HISTORY_SPEC}
          rows={filterToSpendPeriod(depositRows, period)}
          emptyHint="No payments in yet."
          // Tick it off HERE. This is the tab you open with a bank statement;
          // the Mark button used to live only on Transactions, behind "More".
          rowAction={{
            header: "Cleared",
            // A checkbox, not a form. It ticks instantly and confirms in the
            // background — a server action here would revalidate the whole page
            // on every one of thirty ticks.
            render: (r) => <DepositCheckbox paymentId={r.id} initial={!!r.depositedYmd} />,
          }}
        />
        </section>
      )}

      {/* "Recurring reports to Alex" moved to Settings › Recurring Reports.
          Karan 2026-09-17: "put this in settings, make a new tab for it."
          It is a setting, not a figure, and one you touch once — so every day
          it was taking a block of the page Mary works in for a control nobody
          was going to press. */}


      {/* The footer of links is gone.
          
          It offered "Invoices →" and "All reports →". Reports is already one
          item down the sidebar, so that was a second door to the same room.
          And `/commercial/invoices` has NO sidebar entry — this page was the
          only thing sending you there, which meant landing on a surface with
          no nav highlight and no way back except the browser button. Karan,
          2026-08-19: *"it brings me to pages i cant normally acess … we coi;d
          porlly take these buttons out"*.
          
          Nothing is lost: an invoice is reached from the receivable or from
          its deal's Invoices tab, which is where Katie's restructure put
          invoice work in the first place. */}
    </div>
  );
}

/**
 * One reimbursement list — owed or paid back, same shape.
 *
 * The settle control is a single click with no navigation, like the deposit
 * tick: paying out a list of these is several in a row, and a page that jumps
 * to the top after each one doesn't get used.
 */
function ReimbursementList({
  title,
  rows,
  settleAction,
  empty,
  settled,
}: {
  title: string;
  rows: Awaited<ReturnType<typeof getReimbursementsReport>>["owed"];
  settleAction: (formData: FormData) => Promise<void>;
  empty: string;
  settled: boolean;
}) {
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <h3 className="text-[13px] font-bold text-ppp-charcoal px-3.5 py-2.5 border-b border-ppp-charcoal-100 flex items-baseline gap-2">
        {title}
        <span className="text-[11px] font-normal text-ppp-charcoal-500">
          {rows.length} item{rows.length === 1 ? "" : "s"}
        </span>
      </h3>
      {rows.length === 0 ? (
        <p className="px-3.5 py-8 text-center text-[12.5px] text-ppp-charcoal-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-ppp-charcoal-100">
          {rows.map((r) => (
            <li key={r.purchaseId} className="px-3.5 py-2.5 flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-ppp-charcoal">
                  {r.person}
                  <span className="ml-2 font-normal text-ppp-charcoal-500">{r.description ?? r.category}</span>
                </div>
                <div className="text-[11px] text-ppp-charcoal-400">
                  {r.purchasedYmd}
                  {r.jobName ? ` · ${r.jobName}` : " · no job"}
                  {settled
                    ? r.settledYmd
                      ? ` · paid ${r.settledYmd}`
                      : ""
                    : ` · ${r.ageDays}d waiting`}
                  {/* Flagged on the row it affects: paying without a receipt
                      is the one that gets argued about later. */}
                  {!r.hasReceipt && !settled && (
                    <span className="text-amber-700 font-semibold"> · no receipt</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-condensed text-[15px] font-black tabular-nums">
                  {formatCentsFull(r.amountCents)}
                </span>
                <form action={settleAction}>
                  <input type="hidden" name="purchase_id" value={r.purchaseId} />
                  <input type="hidden" name="settled" value={settled ? "0" : "1"} />
                  <PendingSubmitButton
                    pendingLabel="…"
                    className={`inline-flex items-center px-2.5 rounded-md border text-[11.5px] font-semibold min-h-[44px] sm:min-h-[32px] ${
                      settled
                        ? "border-ppp-charcoal-200 text-ppp-charcoal-500 hover:bg-ppp-charcoal-50"
                        : "border-emerald-300 text-emerald-800 bg-emerald-50 hover:bg-emerald-100"
                    }`}
                  >
                    {settled ? "Undo" : "Mark paid"}
                  </PendingSubmitButton>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A small two/three-column table with a title and an honest empty state. */
function MiniTable({
  title, head, rows, empty,
}: { title: string; head: string[]; rows: string[][]; empty: string }) {
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <h3 className="text-[13px] font-bold text-ppp-charcoal px-3.5 py-2.5 border-b border-ppp-charcoal-100">{title}</h3>
      {rows.length === 0 ? (
        <p className="px-3.5 py-8 text-center text-[12.5px] text-ppp-charcoal-500">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 text-left">
                {head.map((h, i) => (
                  <th key={h} className={`px-3 py-2 ${i > 0 ? "text-right" : ""}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ppp-charcoal-100">
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} className={`px-3 py-2 ${ci > 0 ? "text-right tabular-nums" : "font-semibold text-ppp-charcoal"}`}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** `href` is optional: on a view that already shows everything there is
 *  nothing to link to, and a "Full report →" that leaves the page is exactly
 *  what this restructure removed. */
/** Move a yyyy-mm-dd by whole days without a timezone turning it into the day
 *  before. Payroll weeks are calendar blocks, not instants. */
function shiftWeek(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function SectionHead({
  title, hint, href, linkLabel = "See all",
}: { title: string; hint: string; href?: string; linkLabel?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 flex-wrap">
      <div className="flex items-baseline gap-2 flex-wrap min-w-0">
        <h2 className="text-[14px] font-bold text-ppp-charcoal">{title}</h2>
        <span className="text-[11.5px] text-ppp-charcoal-500">{hint}</span>
      </div>
      {href && (
        <Link href={href} className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline shrink-0">
          {linkLabel} →
        </Link>
      )}
    </div>
  );
}

function Tile({ label, value, tone, sub }: { label: string; value: string; tone: Tone; sub?: string }) {
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-3.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-[22px] sm:text-[24px] font-black tabular-nums leading-tight mt-0.5 ${toneText[tone]}`}>
        {value}
      </div>
      {sub && <div className="text-[10.5px] text-ppp-charcoal-400 mt-0.5 leading-snug">{sub}</div>}
    </div>
  );
}
