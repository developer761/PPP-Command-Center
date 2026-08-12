/**
 * Project Costs & Job P&L — shared tool body (Phase 2).
 *
 * The cost side of a deal (materials/labor/subs/equipment/permits) + the Job P&L
 * (Contract − Costs = Gross Margin). Lives inline under the deal's Project
 * sub-tab AND on a standalone route, one source of truth (mirrors ChangeOrdersTool).
 * Revenue stays on the invoices; nothing here ever changes what we bill the GC.
 */
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { transactionRecordId } from "@/lib/commercial/record-ids";
import { UUID_RE } from "@/lib/commercial/uuid";
import { parseDollarsToCents, formatCentsFull, fmtEtDate } from "@/lib/commercial/invoices/format";
import { getProjectFinancials, dealMargin } from "@/lib/commercial/projects/financials";
import { fieldOpsLaborByWorkerForOpp } from "@/lib/commercial/field-ops/labor-cost";
import {
  listPurchasesForProject,
  addPurchase,
  updatePurchase,
  deletePurchase,
  attachPurchaseReceipt,
  recentVendorsForAccount,
  recentWorkersForAccount,
  laborByWorkerForProject,
} from "@/lib/commercial/purchases/db";
import { PURCHASE_CATEGORIES, PURCHASE_CATEGORY_META, purchaseCategoryLabel } from "@/lib/commercial/purchases/constants";
import { getDocumentsByIds } from "@/lib/commercial/documents/db";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { ToolBackHeader } from "@/components/commercial/tool-back-header";
import PurchaseForm from "@/components/commercial/purchase-form";
import { DonutChart, GaugeRing, type ChartTone, type DonutSegment } from "@/components/commercial/charts";
import { formatCentsCompact } from "@/lib/commercial/invoices/format";
import Link from "next/link";

const COST_CATEGORY_TONE: Record<string, ChartTone> = {
  materials: "blue", labor: "brand", subcontractor: "navy", equipment: "amber", permit: "neutral", other: "neutral",
};
// Field-ops crew labor (Option A) — its own donut slice, distinct from the
// manual "Subcontract labor" purchase category.
const CREW_LABOR_TONE: ChartTone = "emerald";

export type CostsSP = {
  cost_ok?: string;
  error?: string;
  heads_up?: string;
  edit_purchase?: string;
  back?: string;
  // Preserved add-form inputs after a validation error (audit M3).
  pu_cat?: string;
  pu_vendor?: string;
  pu_amt?: string;
  pu_hours?: string;
  pu_date?: string;
  pu_desc?: string;
};

/** Parse a loose hours string ("40", "37.5") → number or null (server guard;
 *  the db also clamps). */
function parseHours(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function requireCommercialUser(): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return user.id;
}

function costsBase(accountId: string, oppId: string, origin?: string): string {
  // Return you to WHERE you are: the standalone tool page when opened directly,
  // the account's deal (Project sub-tab) view when embedded there. Never jump
  // between the two.
  return `/commercial/opportunities/${oppId}?tab=project&sub=transactions`;
}
function costsRedirect(accountId: string, oppId: string, params: Record<string, string>, back = "", origin = ""): never {
  const p = { ...params };
  // Preserve a valid back-target (the sidebar tool index OR the invoices deal
  // page) across the redirect so the header arrow survives a form action.
  if (back && (back.startsWith("/commercial/post-job/") || back.startsWith("/commercial/invoices/new?opp="))) p.back = back;
  const qs = new URLSearchParams(p).toString();
  const b = costsBase(accountId, oppId, origin);
  redirect(qs ? `${b}${b.includes("?") ? "&" : "?"}${qs}` : b);
}

function revalidateCostSurfaces(accountId: string, oppId: string) {
  // The deal's own page — where Transactions now renders, and the surface the
  // person who just saved is looking at. It was never revalidated: this tool
  // only ever invalidated the account and the projects list, so a saved cost
  // could show stale on the very page that saved it. Found in the step-3 sweep.
  revalidatePath(`/commercial/opportunities/${oppId}`);
  revalidatePath(`/commercial/accounts/${accountId}`);
  revalidatePath("/commercial/projects");
  revalidatePath("/commercial");
}

/** Ownership guard for every cost action (audit H1/M2): the deal must exist +
 *  belong to the claimed account, else bounce — so a forged opp/account pair
 *  can't drive a redirect/revalidate for a deal the row doesn't belong to. */
async function assertDealOwned(opp_id: string, account_id: string) {
  const opp = await getCommercialOpportunity(opp_id);
  if (!opp || opp.account_id !== account_id) redirect("/commercial/accounts");
}

const CATEGORY_OPTIONS: [string, string][] = PURCHASE_CATEGORIES.map((c) => [c, PURCHASE_CATEGORY_META[c].label]);

const COST_OK_MESSAGES: Record<string, string> = {
  added: "Purchase logged.",
  saved: "Purchase updated.",
  deleted: "Purchase removed.",
};

async function readReceiptFile(formData: FormData): Promise<{ file_name: string; mime_type: string; data: Uint8Array } | null> {
  const f = formData.get("receipt");
  if (!(f instanceof File) || f.size === 0) return null;
  return { file_name: f.name || "receipt.pdf", mime_type: f.type || "application/octet-stream", data: new Uint8Array(await f.arrayBuffer()) };
}

/** Today's ET calendar date (YYYY-MM-DD) — used to anchor a blank purchase date
 *  at 16:00Z so display + edit-prefill agree (audit L6). */
function etToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
const RECEIPT_FAILED_NOTE = "Purchase saved, but the receipt didn't upload — add it from Edit.";

async function addPurchaseAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id)) redirect("/commercial/accounts");
  await assertDealOwned(opp_id, account_id);
  const category = String(formData.get("category") ?? "materials");
  const vendor = String(formData.get("vendor") ?? "");
  const rawAmount = String(formData.get("amount") ?? "");
  const rawHours = String(formData.get("hours") ?? "");
  const rawDate = String(formData.get("purchased_at") ?? "");
  const description = String(formData.get("description") ?? "");
  // Round-trip the typed values on a validation error (audit M3).
  const preserve = { pu_cat: category, pu_vendor: vendor.slice(0, 200), pu_amt: rawAmount.slice(0, 40), pu_hours: rawHours.slice(0, 20), pu_date: rawDate.slice(0, 10), pu_desc: description.slice(0, 1000) };
  const cents = parseDollarsToCents(rawAmount);
  if (cents === null || cents <= 0) {
    costsRedirect(account_id, opp_id, { error: "Enter a transaction amount greater than $0.", ...preserve }, back, origin);
  }
  // Blank date → today's ET date at 16:00Z (stable, matches the edit prefill).
  const purchased_at = new Date(`${rawDate || etToday()}T16:00:00Z`).toISOString();
  const res = await addPurchase({
    opportunity_id: opp_id,
    category,
    vendor: vendor || null,
    amount_cents: cents!,
    // Hours only stored for labor (db enforces the same rule).
    hours: category === "labor" ? parseHours(rawHours) : null,
    purchased_at,
    description: description || null,
    created_by_user_id: userId,
  });
  if (!res.ok) costsRedirect(account_id, opp_id, { error: res.error, ...preserve }, back, origin);
  // Optional receipt — best-effort, never blocks the purchase; warn if it fails.
  const receipt = await readReceiptFile(formData);
  let receiptFailed = false;
  if (receipt) {
    const r = await attachPurchaseReceipt({ purchaseId: res.value.id, ...receipt, actorUserId: userId }).catch(() => ({ ok: false as const }));
    receiptFailed = !r.ok;
  }
  revalidateCostSurfaces(account_id, opp_id);
  costsRedirect(account_id, opp_id, { cost_ok: "added", ...(receiptFailed ? { heads_up: RECEIPT_FAILED_NOTE } : {}) }, back, origin);
}

async function updatePurchaseAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const purchase_id = String(formData.get("purchase_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(purchase_id)) redirect("/commercial/accounts");
  await assertDealOwned(opp_id, account_id);
  const category = String(formData.get("category") ?? "materials");
  const vendor = String(formData.get("vendor") ?? "");
  const rawAmount = String(formData.get("amount") ?? "");
  const rawHours = String(formData.get("hours") ?? "");
  const rawDate = String(formData.get("purchased_at") ?? "");
  const description = String(formData.get("description") ?? "");
  const cents = parseDollarsToCents(rawAmount);
  if (cents === null || cents <= 0) {
    costsRedirect(account_id, opp_id, { error: "Enter a transaction amount greater than $0.", edit_purchase: purchase_id }, back, origin);
  }
  const res = await updatePurchase(
    purchase_id,
    {
      category,
      vendor: vendor || null,
      amount_cents: cents!,
      // Always send hours so the db can null it on a category flip away from labor.
      hours: category === "labor" ? parseHours(rawHours) : null,
      purchased_at: rawDate ? new Date(`${rawDate}T16:00:00Z`).toISOString() : undefined,
      description: description || null,
    },
    userId,
    opp_id,
  );
  if (!res.ok) costsRedirect(account_id, opp_id, { error: res.error, edit_purchase: purchase_id }, back, origin);
  const receipt = await readReceiptFile(formData);
  let receiptFailed = false;
  if (receipt) {
    const r = await attachPurchaseReceipt({ purchaseId: purchase_id, ...receipt, actorUserId: userId }).catch(() => ({ ok: false as const }));
    receiptFailed = !r.ok;
  }
  revalidateCostSurfaces(account_id, opp_id);
  costsRedirect(account_id, opp_id, { cost_ok: "saved", ...(receiptFailed ? { heads_up: RECEIPT_FAILED_NOTE } : {}) }, back, origin);
}

async function deletePurchaseAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const purchase_id = String(formData.get("purchase_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(purchase_id)) redirect("/commercial/accounts");
  await assertDealOwned(opp_id, account_id);
  const res = await deletePurchase(purchase_id, userId, opp_id);
  if (!res.ok) costsRedirect(account_id, opp_id, { error: res.error }, back, origin);
  revalidateCostSurfaces(account_id, opp_id);
  costsRedirect(account_id, opp_id, { cost_ok: "deleted" }, back, origin);
}

function marginTone(pct: number | null): { text: string; bar: string; label: string } {
  if (pct == null) return { text: "text-ppp-charcoal-400", bar: "bg-ppp-charcoal-200", label: "—" };
  if (pct < 0) return { text: "text-rose-700", bar: "bg-rose-500", label: "over budget" };
  if (pct < 15) return { text: "text-amber-700", bar: "bg-amber-500", label: "thin margin" };
  return { text: "text-emerald-700", bar: "bg-emerald-500", label: "healthy" };
}

export async function ProjectCostsTool({
  id,
  dealId,
  sp,
  variant,
}: {
  id: string;
  dealId: string;
  sp: CostsSP;
  variant: "route" | "inline";
}) {
  await requireCommercialUser();
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();

  const [account, opp] = await Promise.all([getCommercialAccount(id), getCommercialOpportunity(dealId)]);
  if (!account || !opp) notFound();
  if (opp.account_id !== id) notFound();

  const dealName = derivedOppName(opp, account.company_name);
  const [fin, purchases, recentVendors, recentWorkers, laborByWorker, crewLabor] = await Promise.all([
    getProjectFinancials(dealId),
    listPurchasesForProject(dealId),
    recentVendorsForAccount(id),
    recentWorkersForAccount(id),
    laborByWorkerForProject(dealId),
    fieldOpsLaborByWorkerForOpp(dealId),
  ]);
  const crewLaborTotalCents = fin.fieldOpsLaborCents;
  const crewLaborHours = crewLabor.reduce((s, w) => s + w.hours, 0);
  // Receipt docs for the purchases that have one (one batched query).
  const receiptDocs = await getDocumentsByIds(
    purchases.map((p) => p.receipt_document_id).filter((x): x is string => !!x),
  );

  const editId = sp.edit_purchase ?? null;
  // Total cost = purchases (fin.costs.total) + field-ops crew labor (Option A).
  // Everything below (margin, %-of-contract, net, donut) uses the TOTAL so this
  // tab reconciles with the deal Overview, account rollup, and platform P&L.
  const totalCostCents = fin.totalCostCents;
  // True % (may exceed 100 when over budget) for the label; bar width clamps.
  const truePctOfContract = fin.hasContract ? Math.round((totalCostCents / fin.contractCents) * 100) : 0;
  const barPctOfContract = Math.min(100, truePctOfContract);
  // ONE margin, same basis as every other surface (billed − costs, decision
  // D2). This tile used to read the contract-based grossMarginPct while the
  // gauge below it read the billed one — two different numbers under the same
  // word, on one screen.
  const dm = dealMargin(fin);
  const mt = marginTone(dm.provisional ? null : dm.pct);
  const laborTotalHours = laborByWorker.reduce((s, w) => s + w.hours, 0);
  // Revenue framing (Gross = billed, Net = billed − costs) — matches the Revenue page.
  const netProfitCents = fin.billedPreTaxCents - totalCostCents;
  const billedMarginPct = dm.pct;
  const costSegments: DonutSegment[] = [
    ...PURCHASE_CATEGORIES.filter((c) => fin.costs[c] > 0).map((c) => ({
      label: PURCHASE_CATEGORY_META[c].label,
      value: fin.costs[c],
      tone: COST_CATEGORY_TONE[c] ?? "neutral",
      valueLabel: formatCentsCompact(fin.costs[c]),
    })),
    ...(crewLaborTotalCents > 0
      ? [{ label: "Crew labor", value: crewLaborTotalCents, tone: CREW_LABOR_TONE, valueLabel: formatCentsCompact(crewLaborTotalCents) }]
      : []),
  ];

  const panel = (
    <div className="space-y-3">
      {sp.cost_ok && COST_OK_MESSAGES[sp.cost_ok] ? (
        <div className="rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3 bg-emerald-50 border border-emerald-200 text-emerald-800">
          <span>{COST_OK_MESSAGES[sp.cost_ok]}</span>
          <Link href={costsBase(id, dealId, variant)} className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center">Dismiss</Link>
        </div>
      ) : null}
      {sp.error ? (
        <div className="rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3 bg-rose-50 border border-rose-200 text-rose-700">
          <span>{sp.error}</span>
          <Link href={costsBase(id, dealId, variant)} className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center">Dismiss</Link>
        </div>
      ) : null}
      {sp.heads_up ? (
        <div className="rounded-lg px-4 py-2.5 text-[12.5px] flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-900">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          <span>{sp.heads_up}</span>
        </div>
      ) : null}

      {/* ── Job P&L ── */}
      <section className="bg-gradient-to-br from-cc-brand-50/60 to-surface border border-cc-brand-100 rounded-xl p-4 sm:p-5">
        <div className="flex items-center gap-2 mb-3">
          <span aria-hidden className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-cc-brand-600 text-white">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
          </span>
          <div>
            <h2 className="text-sm font-bold text-ppp-charcoal leading-tight">Job P&amp;L</h2>
            <p className="text-[11px] text-ppp-charcoal-500 leading-snug">Contract minus job costs. What we bill the customer never changes with cost.</p>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <PLTile label="Contract" value={fin.hasContract ? formatCentsFull(fin.contractCents) : "—"} hint={fin.hasContract ? undefined : "Set a proposal/bid"} />
          <PLTile label="Invoiced" value={formatCentsFull(fin.invoicedCents)} />
          <PLTile label="Collected" value={formatCentsFull(fin.collectedCents)} tone="emerald" />
          <PLTile label="Costs" value={formatCentsFull(totalCostCents)} tone={totalCostCents > 0 ? "rose" : "neutral"} />
          <PLTile
            label={dm.cents < 0 ? "Margin (loss)" : dm.label}
            value={formatCentsFull(dm.cents)}
            sub={
              dm.overBudget
                ? "over budget"
                : dm.pct != null
                  ? `${dm.pct}%${dm.provisional ? "" : ` · ${mt.label}`}${dm.vsContract ? ` · ${dm.vsContract.pct}% vs contract` : ""}`
                  : (dm.caveat ?? undefined)
            }
            tone={dm.provisional || dm.pct == null ? "neutral" : dm.cents < 0 ? "rose" : dm.pct < 15 ? "amber" : "emerald"}
            emphasize
          />
        </div>
        {fin.hasContract && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[10.5px] text-ppp-charcoal-500 mb-1">
              <span>Costs vs contract</span>
              <span className={`font-semibold ${mt.text}`}>{truePctOfContract}% spent</span>
            </div>
            <div className="h-2.5 rounded-full bg-ppp-charcoal-100 overflow-hidden">
              <div className={`h-full rounded-full ${mt.bar}`} style={{ width: `${barPctOfContract}%` }} />
            </div>
          </div>
        )}
        {/* Per-category cost breakdown — where the money went (purchases + the
            auto crew-labor line). % is of TOTAL cost so the chips sum to 100. */}
        {totalCostCents > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {PURCHASE_CATEGORIES.filter((c) => fin.costs[c] > 0).map((c) => (
              <span key={c} className="inline-flex items-center gap-1.5 rounded-lg border border-ppp-charcoal-100 bg-surface px-2.5 py-1 text-[11px]">
                <span className="font-semibold text-ppp-charcoal-600">{PURCHASE_CATEGORY_META[c].label}</span>
                <span className="tabular-nums font-bold text-ppp-charcoal">{formatCentsFull(fin.costs[c])}</span>
                <span className="text-ppp-charcoal-400 tabular-nums">{Math.round((fin.costs[c] / totalCostCents) * 100)}%</span>
              </span>
            ))}
            {crewLaborTotalCents > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px]">
                <span className="font-semibold text-emerald-800">Crew labor</span>
                <span className="tabular-nums font-bold text-ppp-charcoal">{formatCentsFull(crewLaborTotalCents)}</span>
                <span className="text-ppp-charcoal-400 tabular-nums">{Math.round((crewLaborTotalCents / totalCostCents) * 100)}%</span>
              </span>
            )}
          </div>
        )}
      </section>

      {/* ── Revenue & margin ── cost-by-category donut + billed-based margin gauge
          (Gross = billed, Net = billed − costs — matches the Revenue page). */}
      {(totalCostCents > 0 || fin.billedPreTaxCents > 0) && (
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <h3 className="text-[13px] font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            Revenue &amp; margin
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 items-center">
            <div className="flex items-center justify-center">
              {costSegments.length > 0 ? (
                <DonutChart size={148} segments={costSegments} centerValue={formatCentsCompact(totalCostCents)} centerLabel="job costs" />
              ) : (
                <p className="text-[12px] text-ppp-charcoal-400 text-center">No costs logged yet — add one below.</p>
              )}
            </div>
            <div className="flex items-center gap-4">
              <GaugeRing
                pct={dm.overBudget ? 0 : (billedMarginPct ?? 0)}
                tone={dm.provisional || billedMarginPct === null ? "neutral" : billedMarginPct < 0 ? "rose" : billedMarginPct < 15 ? "amber" : "emerald"}
                value={dm.overBudget ? "Over budget" : billedMarginPct === null ? "—" : `${billedMarginPct}%`}
                label="margin"
                size={112}
              />
              <div className="min-w-0 text-[12px] space-y-1">
                <div><span className="text-ppp-charcoal-500">Gross (billed): </span><strong className="tabular-nums text-ppp-charcoal">{formatCentsCompact(fin.billedPreTaxCents)}</strong></div>
                <div><span className="text-ppp-charcoal-500">Costs: </span><strong className="tabular-nums text-ppp-charcoal">{formatCentsCompact(totalCostCents)}</strong></div>
                <div className="pt-1 border-t border-ppp-charcoal-100"><span className="text-ppp-charcoal-500">Net profit: </span><strong className={`tabular-nums ${netProfitCents < 0 ? "text-rose-700" : "text-emerald-700"}`}>{netProfitCents < 0 ? "−" : ""}{formatCentsCompact(Math.abs(netProfitCents))}</strong></div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Crew labor by worker (Option A — auto, from approved time entries) ──
          The in-house W-2 crew cost, computed from Field Ops (hours × burdened
          cost rate). Distinct from "Subcontract labor" below, which is manual
          1099/sub purchases. */}
      {crewLabor.length > 0 && (
        <section className="bg-surface border border-emerald-100 rounded-xl p-4 sm:p-5">
          <div className="flex items-start justify-between gap-2 mb-1.5">
            <div>
              <h3 className="text-[13px] font-bold text-ppp-charcoal flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                Crew labor
              </h3>
              <p className="text-[11px] text-ppp-charcoal-400 leading-snug mt-0.5">Auto from approved time entries — no re-typing.</p>
            </div>
            <span className="text-[11px] text-ppp-charcoal-500 tabular-nums text-right shrink-0">
              {formatCentsFull(crewLaborTotalCents)} total
              {crewLaborHours > 0 ? ` · ${crewLaborHours.toLocaleString("en-US", { maximumFractionDigits: 2 })} hrs` : ""}
            </span>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {crewLabor.map((w) => (
              <li key={w.employeeId} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ppp-charcoal truncate">{w.name}</div>
                  <div className="text-[11px] text-ppp-charcoal-400 tabular-nums">
                    {w.hours.toLocaleString("en-US", { maximumFractionDigits: 2 })} hrs
                    {w.currentRateCents != null ? ` · ${formatCentsFull(w.currentRateCents)}/hr` : ""}
                    {w.unratedHours > 0 && (
                      <span className="text-amber-700"> · {w.unratedHours.toLocaleString("en-US", { maximumFractionDigits: 2 })} hrs unrated</span>
                    )}
                  </div>
                </div>
                <div className="text-[13px] font-bold tabular-nums text-ppp-charcoal shrink-0">{formatCentsFull(w.costCents)}</div>
              </li>
            ))}
          </ul>
          {crewLabor.some((w) => w.unratedHours > 0) && (
            <p className="mt-2.5 text-[11.5px] text-amber-700 leading-snug">
              Some crew hours have no cost rate set, so labor cost and margin are understated. Set rates on the{" "}
              <Link href="/commercial/field-ops/employees" className="font-semibold underline">Crew</Link> page.
            </p>
          )}
        </section>
      )}

      {/* ── Subcontract labor by worker (manual "labor" purchases) ── */}
      {laborByWorker.length > 0 && (
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <h3 className="text-[13px] font-bold text-ppp-charcoal">Subcontract labor by worker</h3>
            <span className="text-[11px] text-ppp-charcoal-500 tabular-nums">
              {formatCentsFull(fin.costs.labor)} total
              {laborTotalHours > 0 ? ` · ${laborTotalHours.toLocaleString("en-US", { maximumFractionDigits: 2 })} hrs` : ""}
            </span>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {laborByWorker.map((w) => (
              <li key={w.worker} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ppp-charcoal truncate">{w.worker}</div>
                  <div className="text-[11px] text-ppp-charcoal-400 tabular-nums">
                    {w.hours > 0 ? `${w.hours.toLocaleString("en-US", { maximumFractionDigits: 2 })} hrs` : "hours not logged"}
                    {w.rate_cents_per_hour != null ? ` · ${formatCentsFull(w.rate_cents_per_hour)}/hr` : ""}
                    <span className="text-ppp-charcoal-300"> · </span>
                    {w.count} {w.count === 1 ? "entry" : "entries"}
                  </div>
                </div>
                <div className="text-[13px] font-bold tabular-nums text-ppp-charcoal shrink-0">{formatCentsFull(w.cost_cents)}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Add + list ── */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        {purchases.length === 0 && (
          <p className="text-[12px] text-ppp-charcoal-500 mb-3">No costs logged yet. Add materials, labor, subs, equipment or permits below to see this job&rsquo;s margin.</p>
        )}
        <details className="group mb-3 rounded-lg" open={!!sp.error && !editId || purchases.length === 0}>
          {/* Filled primary button (not a faint text row) — logging a cost/
              receipt is the whole reason a field crew is on this page, so it
              reads unmistakably as THE button to tap (2026-08 field walk). */}
          <summary className="cursor-pointer list-none px-4 py-3 min-h-[48px] flex items-center justify-center gap-2 text-[14px] font-bold text-white bg-cc-brand-600 hover:bg-cc-brand-700 rounded-lg select-none touch-manipulation shadow-sm shadow-cc-brand-600/30">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="group-open:rotate-45 transition-transform"><path d="M12 5v14 M5 12h14" /></svg>
            <span className="group-open:hidden">Log a transaction</span>
            <span className="hidden group-open:inline">Close</span>
          </summary>
          <PurchaseForm action={addPurchaseAction} oppId={dealId} accountId={id} back={sp.back ?? ""} origin={variant} categories={CATEGORY_OPTIONS} recentVendors={recentVendors} recentWorkers={recentWorkers} submitLabel="Add transaction" preserve={{ cat: sp.pu_cat, vendor: sp.pu_vendor, amt: sp.pu_amt, hours: sp.pu_hours, date: sp.pu_date, desc: sp.pu_desc }} />
        </details>

        {purchases.length > 0 && (
          <ul className="space-y-2.5">
            {purchases.map((pu, puIdx) => {
              const isEditing = editId === pu.id;
              // TRANS-#### shares the project's number (Karan 2026-08). Numbered
              // oldest-first so a transaction's id never changes as new ones are
              // logged — the list renders newest-first, hence the flip.
              const transId = transactionRecordId(
                opp?.project_number,
                purchases.length - puIdx
              );
              const receipt = pu.receipt_document_id ? receiptDocs.get(pu.receipt_document_id) ?? null : null;
              const meta = PURCHASE_CATEGORY_META[pu.category] ?? PURCHASE_CATEGORY_META.other;
              return (
                <li key={pu.id} className="border border-ppp-charcoal-100 rounded-lg p-3 sm:p-3.5">
                  {isEditing ? (
                    <PurchaseForm action={updatePurchaseAction} oppId={dealId} accountId={id} back={sp.back ?? ""} origin={variant} categories={CATEGORY_OPTIONS} recentVendors={recentVendors} recentWorkers={recentWorkers} submitLabel="Save" purchase={pu} cancelHref={costsBase(id, dealId, variant)} />
                  ) : (
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {transId && (
                            <span className="text-[9.5px] font-mono text-ppp-navy-600" title="Transaction ID — shares this project's number">{transId}</span>
                          )}
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-ppp-charcoal-200 bg-ppp-charcoal-50 text-[11px] font-semibold text-ppp-charcoal-700">{purchaseCategoryLabel(pu.category)}</span>
                          {pu.vendor && <span className="text-sm font-semibold text-ppp-charcoal break-words">{pu.vendor}</span>}
                        </div>
                        {pu.description && <div className="text-[12px] text-ppp-charcoal-500 mt-0.5 break-words whitespace-pre-wrap">{pu.description}</div>}
                        <div className="text-[11px] text-ppp-charcoal-400 mt-1 flex items-center gap-2 flex-wrap">
                          <span>{fmtEtDate(pu.purchased_at)}</span>
                          {pu.category === "labor" && pu.hours != null && pu.hours > 0 && (
                            <span className="tabular-nums">
                              {pu.hours.toLocaleString("en-US", { maximumFractionDigits: 2 })} hrs
                              {` · ${formatCentsFull(Math.round(pu.amount_cents / pu.hours))}/hr`}
                            </span>
                          )}
                          {receipt && (
                            <a href={`/api/commercial/documents/${receipt.id}/download`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-cc-brand-700 hover:text-cc-brand-800 min-h-[44px]">
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" /></svg>
                              Receipt
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <div className={`text-base font-bold tabular-nums text-ppp-charcoal`}>−{formatCentsFull(pu.amount_cents)}</div>
                        <div className="flex items-center gap-1">
                          <Link href={`${costsBase(id, dealId, variant)}&edit_purchase=${pu.id}`} className="inline-flex items-center px-2.5 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px]">Edit</Link>
                          <form action={deletePurchaseAction}>
                            <input type="hidden" name="opp_id" value={dealId} />
                            <input type="hidden" name="account_id" value={id} />
                            <input type="hidden" name="back" value={sp.back ?? ""} />
                            <input type="hidden" name="origin" value={variant} />
                            <input type="hidden" name="purchase_id" value={pu.id} />
                            <ConfirmSubmitButton message={`Delete this ${purchaseCategoryLabel(pu.category).toLowerCase()} transaction? This can't be undone.`} pendingLabel="Deleting…" className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-ppp-charcoal-400 hover:text-rose-700 hover:bg-rose-50 min-h-[44px]">Delete</ConfirmSubmitButton>
                          </form>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );

  if (variant === "inline") return <div className="space-y-4">{panel}</div>;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <ToolBackHeader accountId={id} dealId={dealId} accountName={account.company_name} dealName={dealName} back={sp.back} />
      <div>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Transactions &amp; Job P&amp;L</h1>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">{dealName}</p>
      </div>
      {panel}
    </div>
  );
}

function PLTile({
  label,
  value,
  sub,
  hint,
  tone = "neutral",
  emphasize = false,
}: {
  label: string;
  value: string;
  sub?: string;
  hint?: string;
  tone?: "neutral" | "emerald" | "rose" | "amber";
  emphasize?: boolean;
}) {
  const valueCls =
    tone === "emerald" ? "text-emerald-700" : tone === "rose" ? "text-rose-700" : tone === "amber" ? "text-amber-700" : "text-ppp-charcoal";
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${emphasize ? "border-cc-brand-300 bg-surface" : "border-ppp-charcoal-100 bg-surface/70"}`}>
      <div className="text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-lg sm:text-xl font-black tabular-nums leading-none mt-0.5 ${valueCls}`}>{value}</div>
      {sub && <div className={`text-[11px] mt-0.5 ${valueCls}`}>{sub}</div>}
      {hint && <div className="text-[11px] text-ppp-charcoal-500 mt-0.5">{hint}</div>}
    </div>
  );
}
