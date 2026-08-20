import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { normalizeRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getReceivablesReport } from "@/lib/commercial/reports/receivables";
import { getCashFlowReport } from "@/lib/commercial/reports/cash-flow";
import { getJobCostsReport, COST_BUCKET_COLUMNS, type CostBuckets } from "@/lib/commercial/reports/job-costs";
import { getChangeOrderVendorReport } from "@/lib/commercial/reports/change-orders-vendors";
import { listProjects, summarizeProduction } from "@/lib/commercial/projects/db";
import { getArAging } from "@/lib/commercial/reports/ar-aging";
import { getTransactionsReport, setPaymentDeposited, type TxnFilters, type TxnDirection } from "@/lib/commercial/reports/transactions";
import { getSalesTaxReport } from "@/lib/commercial/reports/sales-tax";
import { getReimbursementsReport, setReimbursementSettled } from "@/lib/commercial/reports/reimbursements";
import { TransactionsLedger } from "@/components/commercial/transactions-ledger";
import { ACTIVITY_PRESETS, ACTIVITY_DEFAULT, activityRange, resolvePreset, type ActivityPreset } from "@/lib/commercial/reports/presets";
import { NavSelect, type NavChoice } from "@/components/commercial/nav-select";
import { setReceivableNote } from "@/lib/commercial/reports/receivables";
import { ReceivablesTable } from "@/components/commercial/receivables-table";
import { ReceivablesFilterBar } from "@/components/commercial/receivables-filter-bar";
import {
  parseReceivableQuery, filtersFor, receivableQueryParams, receivableQueryString,
  describeReceivableQuery,
} from "@/lib/commercial/reports/receivables-filters";
import { ExportCsvLink } from "@/components/commercial/export-csv-link";
import { sendReceivablesToAlex, receivablesRecipients } from "@/lib/commercial/reports/receivables-email";
import { getCachedBrief, generateBrief, briefAvailable } from "@/lib/commercial/reports/receivables-brief";
import { formatCentsFull, formatCentsCompact, fmtEtDate } from "@/lib/commercial/invoices/format";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { DonutChart, type DonutSegment, type ChartTone } from "@/components/commercial/charts";
import {
  cashFlowRange, CASH_FLOW_DEFAULT, changeOrderRange, CHANGE_ORDER_DEFAULT,
} from "@/lib/commercial/reports/presets";
import TrendChart from "@/components/trend-chart";

export const dynamic = "force-dynamic";

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
  materials: "brand", crewLabor: "emerald", subLabor: "blue", subcontractor: "navy",
  equipment: "amber", permit: "neutral", other: "neutral",
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

const KIND_META: Record<string, { label: string; cls: string }> = {
  invoice: { label: "Invoice", cls: "bg-ppp-blue-50 text-ppp-blue-800 border-ppp-blue-200" },
  aia: { label: "AIA", cls: "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200" },
  // Grey, never red: retention isn't late, it's held to close-out.
  retainage: { label: "Retention", cls: "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200" },
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

/** Rewrite the brief. Its own action so a slow model call never delays the page.
 *  Shared cache with the receivables report — write it here, it shows there.
 *
 *  Returns to the VIEW you pressed it from. It used to land on `?brief=1`,
 *  which dropped you out of Receivables (or AR aging, or Job costs) back to
 *  Overview — the exact navigate-away this page was restructured to remove. */
async function refreshBriefAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const res = await generateBrief(await getReceivablesReport());
  revalidatePath(BASE);
  revalidatePath("/commercial/reports/receivables");
  const back = safeBack(formData.get("back"));
  const sep = back.includes("?") ? "&" : "?";
  redirect(res.ok ? `${back}${sep}brief=1` : `${back}${sep}error=${encodeURIComponent(res.error)}`);
}

/** Save a chase note without leaving Accounting. Revalidates BOTH surfaces —
 *  the note is one record and it must not appear on one page and not the other. */
async function saveNoteAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const purchaseId = String(formData.get("purchase_id") ?? "");
  if (!purchaseId) return;
  const res = await setReimbursementSettled(purchaseId, String(formData.get("settled")) === "1");
  revalidatePath(BASE);
  if (!res.ok) {
    redirect(`${BASE}?view=reimbursements&error=${encodeURIComponent(res.error)}`);
  }
}

/** Email the sheet to Alex. Explicit click only — no auto-send from here.
 *  Stays on the view you sent it from; it used to force `?view=receivables`,
 *  so pressing Send from Overview silently switched tabs underneath you. */
async function sendToAlexAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
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

/**
 * The in-page views.
 *
 * Karan, 2026-08-19: *"I don't want it to bring me to the reports page but just
 * keep me on the same page."* The old bottom "Go deeper" row navigated away, so
 * the money desk was really a launcher — you left it to do anything. These
 * render inline instead: the URL stays /commercial/accounting, the headline
 * figures stay on screen above the switcher, and nothing is lost on a switch.
 *
 * Receivables is deliberately FIRST after Overview and carries the actions
 * (export, send) — it's the one Alex asked for by name.
 *
 * Invoices is the one thing still a real link: it is a workspace where records
 * get created and edited, not a read-only view, and embedding it would mean two
 * places that can create an invoice.
 */
const VIEWS = [
  { key: "overview", label: "Overview" },
  { key: "receivables", label: "Receivables" },
  // Alex's ledger. Sits next to Receivables on purpose: one answers "what is
  // owed", the other "what actually moved", and he reads them together.
  { key: "transactions", label: "Transactions" },
  { key: "aging", label: "AR aging" },
  { key: "cash", label: "Cash flow" },
  { key: "costs", label: "Job costs" },
  // The last two of Alex's reports the platform didn't carry.
  { key: "tax", label: "Sales tax" },
  { key: "reimbursements", label: "Reimbursements" },
] as const;
type View = (typeof VIEWS)[number]["key"];

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
  const saved = pickFirst(sp.saved) === "1";
  const sentTo = pickFirst(sp.sent);
  const rawView = pickFirst(sp.view);
  const view: View = (VIEWS.some((v) => v.key === rawView) ? rawView : "overview") as View;
  const recipients = receivablesRecipients();
  const q = parseReceivableQuery((k) => sp[k]);
  const activeFilter = describeReceivableQuery(q);

  // ── The ledger's own filters ──────────────────────────────────────────
  // Its own query keys (`tp`/`td`/`tparty`/`tundep`) so switching between the
  // Receivables view and this one never carries a filter across and quietly
  // narrows a different list.
  const txPeriod = resolvePreset(pickFirst(sp.tp), ACTIVITY_PRESETS, ACTIVITY_DEFAULT);
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
    set("tp", txPeriod === ACTIVITY_DEFAULT ? null : txPeriod);
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
  const href = (v: View) => {
    if (v === "overview") return BASE;
    // The ledger carries its own filters back, so leaving it and returning
    // doesn't silently reset the month you were reconciling.
    if (v === "transactions") return `${BASE}${txQuery()}`;
    // Carry the period across — these three read the same window, and losing
    // it on a tab switch means re-picking the month every time.
    if (v === "tax" || v === "reimbursements") {
      const p = new URLSearchParams({ view: v });
      if (txPeriod !== ACTIVITY_DEFAULT) p.set("tp", txPeriod);
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

  const [receivables, cash, jobCosts, coVendor, projects] = await Promise.all([
    getReceivablesReport(),
    getCashFlowReport(cashRange),
    getJobCostsReport(),
    getChangeOrderVendorReport(coRange),
    listProjects(),
  ]);
  // Only fetched for the view that renders it — the money band above doesn't
  // use aging, so paying for it on every page load would be waste.
  const aging = view === "aging" ? await getArAging() : null;
  // A second, filtered read for the Receivables view. Cheap relative to a wrong
  // number: reusing the unfiltered `receivables` would ignore the filter bar.
  const receivablesView =
    view === "receivables" ? await getReceivablesReport(Date.now(), filtersFor(q)) : null;
  // Same rule as aging: only paid for on the view that renders it.
  const transactions = view === "transactions" ? await getTransactionsReport(txFilters) : null;
  // Both windowed by the same shared activity preset the ledger uses, so a
  // period means the same thing on every view of this page.
  const salesTax =
    view === "tax"
      ? await getSalesTaxReport({
          fromYmd: txRange?.fromYmd,
          toYmd: txRange?.toYmd,
          uncertifiedOnly: pickFirst(sp.nocert) === "1" || undefined,
        })
      : null;
  const reimbursements =
    view === "reimbursements"
      ? await getReimbursementsReport({ fromYmd: txRange?.fromYmd, toYmd: txRange?.toYmd })
      : null;
  const production = summarizeProduction(projects);
  const { brief, stale } = await getCachedBrief(receivables);
  const canBrief = briefAvailable();

  // Cash actually collected, per month. Deliberately COLLECTED rather than
  // billed: the reports index already charts billing, and the question this
  // page exists to answer is what arrived in the bank.
  const cashSeries = cash.months.map((m) => ({ label: m.label, value: m.collectedCents / 100_000 }));
  const hasCash = cash.months.some((m) => m.collectedCents > 0);

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
  const readyToBillCents = unbilledContractCents + unbilledCoCents;

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
    <div className="max-w-[1400px] mx-auto px-3 sm:px-6 py-6 space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">
            Accounting
          </h1>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-2xl">
            Where the money stands — what&rsquo;s owed to us, what came in, what&rsquo;s still to bill,
            and what the work cost. Open any block for the full report.
          </p>
        </div>
        {/* Export + Send live in the page header, not buried at the bottom:
            they are the two things this page exists to let somebody DO. */}
        <div className="flex items-center gap-2 flex-wrap">
          <ExportCsvLink
            href="/api/commercial/reports/receivables/export"
            params={view === "receivables" ? receivableQueryParams(q) : undefined}
            disabled={(view === "receivables" ? receivablesView?.rows.length ?? 0 : receivables.rows.length) === 0}
            disabledHint="Nothing to export in this view"
            label="Export receivables"
          />
          {receivables.rows.length > 0 && (
            <form action={sendToAlexAction} className="flex flex-col items-end gap-0.5">
              <input type="hidden" name="back" value={href(view)} />
              <PendingSubmitButton
                pendingLabel="Sending…"
                className="inline-flex items-center min-h-[44px] px-3.5 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 transition-colors"
              >
                Send to Alex
              </PendingSubmitButton>
              <span className="text-[10px] text-ppp-charcoal-400">
                {receivablesView?.filtered ? "sends the whole book" : recipients.join(", ")}
              </span>
            </form>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800">
          {error}
        </div>
      )}
      {saved && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
          Note saved.
        </div>
      )}
      {sentTo && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
          Sent to {sentTo} — the figures, the notes, and the sheet attached.
        </div>
      )}

      {/* ── 1 · The brief ─────────────────────────────────────────────────
          Same cached brief the receivables report shows — one shared read, so
          the two pages can never tell Alex different stories. */}
      {canBrief && (
        <section className="bg-surface border border-ppp-charcoal-100 border-l-4 border-l-cc-brand-500 rounded-xl p-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1.5">
            <h2 className="text-[10px] font-bold uppercase tracking-widest text-cc-brand-700">The brief</h2>
            <form action={refreshBriefAction}>
              <input type="hidden" name="back" value={href(view)} />
              <PendingSubmitButton
                pendingLabel="Writing…"
                className="text-[11.5px] font-semibold text-ppp-charcoal-500 hover:text-ppp-charcoal min-h-[32px] inline-flex items-center"
              >
                {brief ? "Rewrite" : "Write the brief"}
              </PendingSubmitButton>
            </form>
          </div>
          {brief ? (
            <>
              <p className="text-[13.5px] text-ppp-charcoal leading-relaxed">{brief.text}</p>
              <p className="text-[10.5px] text-ppp-charcoal-400 mt-2">
                {stale
                  ? "Written before the latest changes — rewrite for a current read."
                  : `Written ${fmtEtDate(brief.generatedAt)}`}
              </p>
            </>
          ) : (
            <p className="text-[12.5px] text-ppp-charcoal-500">
              A short read on where the money is and what to chase first.
            </p>
          )}
        </section>
      )}

      {/* ── The money band — ALWAYS on screen, above the switcher. Changing view
             must never cost you the four numbers the page is opened for. ── */}
      <section className="space-y-2">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Tile
            label="Total outstanding"
            value={formatCentsFull(receivables.totalOpenCents)}
            tone="brand"
            sub={`${receivables.rows.length} open item${receivables.rows.length === 1 ? "" : "s"}`}
          />
          <Tile label="Collectible now" value={formatCentsFull(receivables.dueNowCents)} tone="navy" sub="excludes retention" />
          <Tile
            label="Past due"
            value={formatCentsFull(receivables.overdueCents)}
            tone={receivables.overdueCents > 0 ? "rose" : "neutral"}
            sub={receivables.overdueCents > 0 ? "chase these first" : "nothing late"}
          />
          <Tile label="Retention held" value={formatCentsFull(receivables.retainageCents)} tone="neutral" sub="released at close-out" />
        </div>
      </section>

      {/* ── The switcher. Prominent and high, because these are the surfaces
             people came for — not a footer of links. Renders in place: the URL
             stays on /commercial/accounting. ── */}
      <nav className="flex gap-1 overflow-x-auto border-b border-ppp-charcoal-100 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {VIEWS.map((v) => {
          const active = v.key === view;
          return (
            <Link
              key={v.key}
              href={href(v.key)}
              aria-current={active ? "page" : undefined}
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
      </nav>

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
            <Tile
              label="Days to pay"
              value={cash.totals.avgDaysToPay === null ? "—" : `${cash.totals.avgDaysToPay}d`}
              tone={cash.totals.avgDaysToPay !== null && cash.totals.avgDaysToPay > 60 ? "amber" : "navy"}
              sub="amount-weighted average"
            />
            <Tile
              label="Collection rate"
              value={cash.totals.collectionRatePct === null ? "—" : `${cash.totals.collectionRatePct}%`}
              tone="neutral"
              // Above 100% is normal, not a bug — older invoices landing inside
              // the window. Saying so stops it being reported as one.
              sub="collected ÷ billed · over 100% means older invoices landed"
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

      {/* ── 5 · Not yet billed ────────────────────────────────────────────
          Money already earned that no one has invoiced. It appears on no other
          surface, and it is the fastest cash in the building — you don't have
          to chase anyone for it, you just have to send it. */}
      <section className="space-y-2">
        <SectionHead
          title="Earned, not yet billed"
          href={href("costs")}
          hint="Signed work with no invoice against it — the fastest cash there is."
        />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Tile
            label="Ready to bill"
            value={formatCentsFull(readyToBillCents)}
            tone={readyToBillCents > 0 ? "amber" : "neutral"}
            sub={readyToBillCents > 0 ? "contract + approved change orders" : "everything signed has been invoiced"}
          />
          <Tile
            label="Contract left to bill"
            value={formatCentsFull(unbilledContractCents)}
            tone="neutral"
            sub={`of ${formatCentsCompact(production.contractValueCents)} signed`}
          />
          <Tile
            label="Approved COs unbilled"
            value={formatCentsFull(unbilledCoCents)}
            tone={unbilledCoCents > 0 ? "amber" : "neutral"}
            sub={unbilledCoCents > 0 ? "approved scope, never invoiced" : "all approved COs billed"}
          />
        </div>
        {production.overBilledProjects > 0 && (
          // A warning, not a block (the never-reject rule): over-billing is
          // usually an approved CO invoiced before it was logged. Saying so
          // beats letting it net away invisibly inside "left to bill".
          <p className="text-[11.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {production.overBilledProjects} job{production.overBilledProjects === 1 ? " is" : "s are"} billed
            past contract by {formatCentsCompact(production.overBilledCents)} — usually a change order
            invoiced before it was logged.{" "}
            <Link href={href("costs")} className="font-semibold underline">Check the jobs</Link>
          </p>
        )}
      </section>

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
              label="Unpriced labour"
              value={
                jobCosts.totals.laborUnratedHours > 0
                  ? `${jobCosts.totals.laborUnratedHours.toLocaleString("en-US", { maximumFractionDigits: 0 })}h`
                  : "None"
              }
              tone={jobCosts.totals.laborUnratedHours > 0 ? "amber" : "neutral"}
              // Unpriced hours understate cost, which overstates margin. Naming
              // that is the difference between a caveat and a wrong number.
              sub={jobCosts.totals.laborUnratedHours > 0 ? "no cost rate — margin reads high" : "every hour has a rate"}
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
      {view === "receivables" && receivablesView && (
        <section className="space-y-2.5">
          <SectionHead
            title="Every open item"
            hint="Biggest first. Write a note after a chase and it stays with the job."
          />
          <ReceivablesFilterBar q={q} basePath={BASE} extraParams={{ view: "receivables" }} gcOptions={receivablesView.gcOptions} />
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
          <div className="flex items-center gap-2 flex-wrap">
            <NavSelect
              label="Period"
              value={txPeriod}
              ariaLabel="Filter transactions by period"
              choices={ACTIVITY_PRESETS.map((p): NavChoice => ({
                value: p.key,
                label: p.label,
                href: `${BASE}${txQuery({ tp: p.key === ACTIVITY_DEFAULT ? null : p.key })}`,
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
                ...(txPeriod !== ACTIVITY_DEFAULT ? { tp: txPeriod } : {}),
                ...(txDirection !== "all" ? { td: txDirection } : {}),
                ...(txParty ? { tparty: txParty } : {}),
                ...(txUndeposited ? { tundep: "1" } : {}),
              }}
              label="Export ledger"
              disabled={transactions.rowCount === 0}
              disabledHint="Nothing to export in this view"
            />
          </div>

          {/* Crew labour is a COST, not a transaction — no payment row exists
              for it — so it is absent here rather than invented. Said once,
              where somebody would otherwise go looking for it. */}
          <p className="text-[11px] text-ppp-charcoal-400">
            Crew labour isn&rsquo;t listed: it&rsquo;s costed from approved hours, not paid as a
            recorded transaction. It&rsquo;s in{" "}
            <Link href={href("costs")} className="font-semibold text-cc-brand-700 hover:underline">Job costs</Link>.
          </p>

          <TransactionsLedger
            report={transactions}
            depositAction={depositAction}
            queryString={txQuery()}
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
            <Tile label="Collected · 6 mo" value={formatCentsFull(cash.totals.collectedCents)} tone="emerald" sub={`${cash.totals.paymentCount} payment${cash.totals.paymentCount === 1 ? "" : "s"}`} />
            <Tile label="Billed · 6 mo" value={formatCentsFull(cash.totals.billedCents)} tone="navy" />
            <Tile
              label="Days to pay"
              value={cash.totals.avgDaysToPay === null ? "—" : `${cash.totals.avgDaysToPay}d`}
              tone={cash.totals.avgDaysToPay !== null && cash.totals.avgDaysToPay > 60 ? "amber" : "neutral"}
              sub="weighted by amount"
            />
            <Tile
              label="Collection rate"
              value={cash.totals.collectionRatePct === null ? "—" : `${cash.totals.collectionRatePct}%`}
              tone="neutral"
              sub="over 100% = older invoices landed"
            />
          </div>
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
            <MiniTable
              title="Slowest to pay"
              head={["GC", "Avg days", "Still open"]}
              rows={cash.slowest.map((sp) => [
                sp.accountName,
                sp.avgDaysToPay === null ? "—" : `${sp.avgDaysToPay}d`,
                formatCentsFull(sp.openCents),
              ])}
              empty="Not enough paid invoices to rank anyone yet."
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
                              <Link href={`/commercial/opportunities/${d.oppId}`} className="font-semibold text-ppp-charcoal hover:text-cc-brand-700 hover:underline">
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

          {salesTax.uncertifiedCount > 0 && (
            // The whole reason to build this rather than just total the tax
            // column: an exemption you can't produce a certificate for is an
            // assessment waiting to happen.
            <p className="text-[12px] rounded-lg border px-3 py-2 border-rose-200 bg-rose-50 text-rose-900">
              <strong>{salesTax.uncertifiedCount}</strong> exempt invoice
              {salesTax.uncertifiedCount === 1 ? "" : "s"} — {formatCentsFull(salesTax.uncertifiedBaseCents)} —
              have no exemption certificate on file. NY capital-improvement exemptions are
              per-project, so the certificate belongs on the job that claimed it.{" "}
              <Link href={`${BASE}?view=tax&nocert=1${txPeriod !== ACTIVITY_DEFAULT ? `&tp=${txPeriod}` : ""}`} className="font-semibold underline">
                Show just those
              </Link>
            </p>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <NavSelect
              label="Issued"
              value={txPeriod}
              ariaLabel="Filter sales tax by period"
              choices={ACTIVITY_PRESETS.map((p): NavChoice => ({
                value: p.key,
                label: p.label,
                href: `${BASE}?view=tax${p.key === ACTIVITY_DEFAULT ? "" : `&tp=${p.key}`}${pickFirst(sp.nocert) === "1" ? "&nocert=1" : ""}`,
              }))}
            />
            {pickFirst(sp.nocert) === "1" && (
              <Link href={`${BASE}?view=tax${txPeriod !== ACTIVITY_DEFAULT ? `&tp=${txPeriod}` : ""}`} className="text-[12px] font-semibold text-cc-brand-700 hover:underline inline-flex items-center min-h-[44px] sm:min-h-[38px] px-1">
                Show all invoices
              </Link>
            )}
            <ExportCsvLink
              href="/api/commercial/reports/sales-tax/export"
              params={{
                ...(txPeriod !== ACTIVITY_DEFAULT ? { tp: txPeriod } : {}),
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

          <div className="flex items-center gap-2 flex-wrap">
            <NavSelect
              label="Paid back"
              value={txPeriod}
              ariaLabel="Filter settled reimbursements by period"
              choices={ACTIVITY_PRESETS.map((p): NavChoice => ({
                value: p.key,
                label: p.label,
                href: `${BASE}?view=reimbursements${p.key === ACTIVITY_DEFAULT ? "" : `&tp=${p.key}`}`,
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

      {/* Invoices is the one destination still a link: it's a workspace where
          records are created and edited, not a read-only view. */}
      <section className="border-t border-ppp-charcoal-100 pt-4 flex flex-wrap items-center gap-2">
        <span className="text-[11.5px] text-ppp-charcoal-500">Create or edit invoices:</span>
        <Link
          href="/commercial/invoices"
          className="inline-flex items-center min-h-[38px] px-3 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12px] font-semibold text-ppp-charcoal hover:border-cc-brand-300 hover:text-cc-brand-700 transition-colors"
        >
          Invoices →
        </Link>
        <Link
          href="/commercial/reports"
          className="inline-flex items-center min-h-[38px] px-3 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12px] font-semibold text-ppp-charcoal hover:border-cc-brand-300 hover:text-cc-brand-700 transition-colors"
        >
          All reports →
        </Link>
      </section>
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
