import { NextResponse, type NextRequest } from "next/server";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";
import { getReportAccess } from "@/lib/commercial/reports/access";
import { roleAllowsReport } from "@/lib/commercial/reports/access-rule";
import { createClient } from "@/lib/supabase/server";
import { getJobReport, spendTotal } from "@/lib/commercial/reports/jobs";
import { ACTIVITY_PRESETS, ACTIVITY_DEFAULT, activityRange, resolvePreset } from "@/lib/commercial/reports/presets";
import { deriveInvoiceStatus, invoiceStatusLabel } from "@/lib/commercial/invoices/constants";
import { CHANGE_ORDER_STATUS_META, formatChangeOrderNumber } from "@/lib/commercial/change-orders/constants";
import { purchaseCategoryLabel } from "@/lib/commercial/purchases/constants";
import { proposalStatusLabel } from "@/lib/commercial/proposals/constants";
import { proposalDisplayId } from "@/lib/commercial/proposals/db";
import { SIGNATURE_STATUS_LABEL } from "@/lib/commercial/esign/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ONE job, as a spreadsheet — the same sections the page shows, in blocks.
 *
 * Per-person pay is dropped for anyone who can't see it on the page. The export
 * URL must not be the way around the page's own gate: that is exactly the hole
 * `guardExport`'s `people` flag exists to close, and it applies here at section
 * granularity rather than to the whole file, so a field user still gets the job
 * report — just without the crew's rates.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ oppId: string }> }) {
  const guard = await guardExport({ report: "jobs" });
  if (!guard.ok) return guard.response;

  const { oppId } = await params;
  if (!UUID_RE.test(oppId)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  // Memoised for this request — guardExport already resolved it.
  const access = await getReportAccess(guard.userId, auth?.user?.email);
  const canSeePay = roleAllowsReport({ requires: "people" }, access.role);

  const preset = resolvePreset(req.nextUrl.searchParams.get("preset") ?? undefined, ACTIVITY_PRESETS, ACTIVITY_DEFAULT);
  const range = activityRange(preset);
  const r = await getJobReport(oppId, range);
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });

  const windowLabel = range ? `${range.label} (${range.fromYmd} to ${range.toYmd})` : "Whole job";
  const d = (cents: number) => (cents / 100).toFixed(2);
  const L: string[] = [];
  const row = (...cells: (string | number | null | undefined)[]) => L.push(cells.map((c) => csv(c ?? "")).join(","));
  const blank = () => row("");

  // ── Header ──
  row("Job", r.jobName);
  row("GC", r.accountName);
  row("Address", r.address ?? "");
  row("Project no.", r.opp.project_number ?? "");
  row("Deal no.", r.opp.deal_number ?? "");
  row("Status", r.opp.status, r.opp.sub_status ?? "");
  row("Created", (r.opp.created_at ?? "").slice(0, 10));
  row("Decided (won/lost)", (r.opp.decided_at ?? "").slice(0, 10));
  row("Planned start", (r.opp.proposed_start_at ?? "").slice(0, 10));
  row("Planned finish", (r.opp.proposed_end_at ?? "").slice(0, 10));
  row("Closed out", (r.opp.closed_out_at ?? "").slice(0, 10));
  row("Estimator", r.opp.estimator_name ?? "");
  if (r.failed.length > 0) row("INCOMPLETE", `These sections could not be loaded and are empty here: ${r.failed.join(", ")}`);
  blank();

  // ── Money (whole job, never narrowed) ──
  row("MONEY", "whole job, as of today — the period below applies to the lists, not to these");
  if (!r.financials) {
    row("(unavailable)", "the money block could not be loaded");
  } else {
    const f = r.financials;
    row("Contract (incl. approved COs)", f.hasContract ? d(f.contractCents) : "");
    row("Billed (pre-tax, incl. AIA)", d(f.billedPreTaxCents));
    row("Invoiced (with tax)", d(f.invoicedCents));
    row("Collected", d(f.collectedCents));
    row("Open balance", d(f.openBalanceCents));
    row("Retainage held", d(f.retainageHeldCents));
    row("Credits (overpaid)", d(f.creditCents));
    row("Cost (purchases + crew labor)", d(f.totalCostCents));
    row("  of which crew labor", d(f.fieldOpsLaborCents));
    row("  of which purchases", d(f.costs.total));
    if (r.margin) {
      row(r.margin.label, d(r.margin.cents), "Margin %", r.margin.pct === null ? "" : r.margin.pct, r.margin.caveat ?? "");
      if (r.margin.vsContract) row(r.margin.vsContract.label, d(r.margin.vsContract.cents), "%", r.margin.vsContract.pct);
    }
    if (f.laborUnratedHours > 0) row("WARNING", `${f.laborUnratedHours} crew hours have no cost rate — cost and margin are understated.`);
  }
  blank();

  row("PERIOD", windowLabel, "applies to every section below");
  blank();

  // ── Invoices ──
  row(`INVOICES (${r.invoices.length})`);
  row("Invoice", "Status", "Issued", "Due", "Subtotal", "Total", "Paid", "Balance");
  for (const i of r.invoices) {
    row(i.invoice_number, invoiceStatusLabel(deriveInvoiceStatus(i)), (i.issued_at ?? "").slice(0, 10), (i.due_at ?? "").slice(0, 10), d(i.subtotal_cents), d(i.total_cents), d(i.paid_cents), d(i.balance_cents));
  }
  blank();

  // ── AIA ──
  row(`AIA APPLICATIONS (${r.aiaApps.length})`);
  row("App #", "Status", "Period from", "Period to", "Contract sum", "Retainage %");
  for (const a of r.aiaApps) {
    row(a.application_number, a.status, (a.period_from ?? "").slice(0, 10), (a.period_to ?? "").slice(0, 10), d(a.contract_sum_frozen_cents ?? a.original_contract_cents), a.retainage_pct);
  }
  blank();

  // ── Change orders ──
  row(`CHANGE ORDERS (${r.changeOrders.length})`);
  row("CO", "Title", "Status", "Sent", "Decided", "Amount");
  for (const c of r.changeOrders) {
    row(formatChangeOrderNumber(c.co_number), c.title, CHANGE_ORDER_STATUS_META[c.status]?.label ?? c.status, (c.sent_at ?? "").slice(0, 10), (c.decided_at ?? "").slice(0, 10), d(c.amount_cents));
  }
  blank();

  // ── Costs ──
  row(`COSTS — BY CATEGORY (${r.byCategory.length})`, "total", d(spendTotal(r.byCategory)));
  row("Category", "Items", "Amount");
  for (const c of r.byCategory) row(c.label, c.count, d(c.cents));
  blank();

  row(`COSTS — BY VENDOR (${r.byVendor.length})`);
  row("Vendor", "Items", "Amount");
  for (const v of r.byVendor) row(v.vendor, v.count, d(v.cents));
  blank();

  row(`COSTS — EVERY PURCHASE (${r.purchases.length})`);
  row("Date", "Category", "Vendor", "Description", "Hours", "Amount");
  for (const p of r.purchases) {
    row((p.purchased_at ?? "").slice(0, 10), purchaseCategoryLabel(p.category), p.vendor ?? "", p.description ?? "", p.hours ?? "", d(p.amount_cents));
  }
  blank();

  // ── Labor ──
  row(
    `LABOR — IN-HOUSE CREW (${r.crew.workers.length})`,
    "days on site",
    r.crew.days.length,
    "hours",
    r.crew.totalHours,
    ...(canSeePay ? (["cost", d(r.crew.costCents)] as const) : [])
  );
  if (canSeePay) {
    row("Worker", "Days", "Hours", "Priced hours", "Unpriced hours", "Current rate", "Cost");
    for (const w of r.crew.workers) row(w.name, w.days, w.hours, w.ratedHours, w.unratedHours, w.currentRateCents != null ? d(w.currentRateCents) : "", d(w.costCents));
  } else {
    row("Worker", "Days", "Hours");
    for (const w of r.crew.workers) row(w.name, w.days, w.hours);
    row("(pay withheld)", "per-person cost is admin / account-manager only");
  }
  blank();

  row(`LABOR — SUBCONTRACT (purchases, whole job) (${r.subLabor.length})`);
  if (canSeePay) {
    row("Worker", "Hours", "Entries", "Cost");
    for (const w of r.subLabor) row(w.worker, w.hours, w.count, d(w.cost_cents));
  } else {
    row("Worker", "Hours", "Entries");
    for (const w of r.subLabor) row(w.worker, w.hours, w.count);
  }
  blank();

  // ── Attendance days ──
  row(`DAYS ON SITE (${r.crew.days.length})`);
  for (const day of r.crew.days) row(day);
  blank();

  // ── Proposals + signatures ──
  row(`PROPOSALS & SIGNATURES (${r.proposals.length})`);
  row("Proposal", "Status", "Sent", "Total", "Signer", "Signature status", "Signed at");
  for (const { proposal, signatures } of r.proposals) {
    const total = d(proposal.final_price_override_cents ?? proposal.total_cents);
    if (signatures.length === 0) {
      row(proposalDisplayId(proposal), proposalStatusLabel(proposal.status), (proposal.sent_at ?? "").slice(0, 10), total, "", "never sent for signature", "");
    } else {
      for (const s of signatures) {
        row(proposalDisplayId(proposal), proposalStatusLabel(proposal.status), (proposal.sent_at ?? "").slice(0, 10), total, s.signer_name ?? s.signer_email, SIGNATURE_STATUS_LABEL[s.status], (s.customer_signed_at ?? "").slice(0, 10));
      }
    }
  }
  blank();

  // ── Documents ──
  row(`DOCUMENTS (${r.documents.length})`);
  row("File", "Category", "Filed", "Size (bytes)");
  for (const doc of r.documents) row(doc.file_name, String(doc.category), (doc.uploaded_at ?? "").slice(0, 10), doc.size_bytes);
  blank();

  // ── Notes ──
  row(`NOTES (${r.notes.length})`);
  row("When", "Who", "Kind", "Note");
  for (const n of r.notes) row((n.created_at ?? "").slice(0, 10), n.author_full_name ?? n.author_email ?? "", n.kind, n.body);

  const slug = (r.opp.project_number || r.jobName).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "job";
  const stamp = range ? `${range.fromYmd}_to_${range.toYmd}` : "whole-job";
  return csvResponse(L.join("\r\n") + "\r\n", `Job_${slug}_${stamp}.csv`, `Job report — ${r.jobName}`, windowLabel);
}
