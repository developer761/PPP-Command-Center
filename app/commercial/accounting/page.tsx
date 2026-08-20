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
import { getCachedBrief, generateBrief, briefAvailable } from "@/lib/commercial/reports/receivables-brief";
import { formatCentsFull, formatCentsCompact, fmtEtDate } from "@/lib/commercial/invoices/format";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { DonutChart, type DonutSegment, type ChartTone } from "@/components/commercial/charts";
import { etTodayIso } from "@/lib/date-et";
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

/** Rewrite the brief. Its own action so a slow model call never delays the page.
 *  Shared cache with the receivables report — write it here, it shows there. */
async function refreshBriefAction() {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const res = await generateBrief(await getReceivablesReport());
  revalidatePath(BASE);
  revalidatePath("/commercial/reports/receivables");
  redirect(res.ok ? `${BASE}?brief=1` : `${BASE}?error=${encodeURIComponent(res.error)}`);
}

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

  const today = etTodayIso();
  const year = today.slice(0, 4);
  // Six months back, matching the cash-flow report's own default so the figure
  // here and the figure there are the same window.
  const fromTotal = Number(year) * 12 + (Number(today.slice(5, 7)) - 1) - 5;
  const cashRange = {
    fromYmd: `${Math.floor(fromTotal / 12)}-${String((fromTotal % 12) + 1).padStart(2, "0")}-01`,
    toYmd: today,
  };

  const [receivables, cash, jobCosts, coVendor, projects] = await Promise.all([
    getReceivablesReport(),
    getCashFlowReport(cashRange),
    getJobCostsReport(),
    getChangeOrderVendorReport({ fromYmd: `${year}-01-01`, toYmd: today }),
    listProjects(),
  ]);
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
        <Link
          href="/commercial/reports"
          className="text-[12px] font-semibold text-cc-brand-700 hover:underline min-h-[44px] inline-flex items-center"
        >
          All reports →
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12.5px] text-rose-800">
          {error}
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

      {/* ── 2 · What's owed to us ─────────────────────────────────────── */}
      <section className="space-y-2">
        <SectionHead
          title="Owed to us"
          href="/commercial/reports/receivables"
          hint="Invoices and AIA applications together."
        />
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

      {/* ── 3 · What came in ──────────────────────────────────────────── */}
      <section className="space-y-2">
        <SectionHead
          title="Cash in · last 6 months"
          href="/commercial/reports/cash-flow"
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
          href="/commercial/reports/receivables"
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
              href="/commercial/reports/receivables"
              className="flex items-center px-3.5 py-2.5 text-[12px] font-semibold text-cc-brand-700 hover:bg-ppp-charcoal-50/60 border-t border-ppp-charcoal-100 min-h-[44px]"
            >
              {restCount} more open item{restCount === 1 ? "" : "s"} — see the full report →
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
          href="/commercial/reports/job-costs"
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
            <Link href="/commercial/reports/job-costs" className="font-semibold underline">Check the jobs</Link>
          </p>
        )}
      </section>

      {/* ── 6 · Where it went ─────────────────────────────────────────── */}
      <section className="space-y-2">
        <SectionHead
          title="What the work cost"
          href="/commercial/reports/job-costs"
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
              label="Vendor spend · YTD"
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

      {/* ── Go deeper ─────────────────────────────────────────────────── */}
      <section className="border-t border-ppp-charcoal-100 pt-4">
        <h2 className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500 mb-2">Go deeper</h2>
        <div className="flex flex-wrap gap-2">
          {[
            { href: "/commercial/reports/receivables", label: "Receivables" },
            { href: "/commercial/reports/ar-aging", label: "AR aging" },
            { href: "/commercial/reports/cash-flow", label: "Cash flow" },
            { href: "/commercial/invoices", label: "Invoices" },
            { href: "/commercial/reports/job-costs", label: "Job costs & profit" },
            { href: "/commercial/reports/change-orders", label: "Change orders & vendors" },
          ].map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="inline-flex items-center min-h-[38px] px-3 rounded-lg border border-ppp-charcoal-200 bg-surface text-[12px] font-semibold text-ppp-charcoal hover:border-cc-brand-300 hover:text-cc-brand-700 transition-colors"
            >
              {l.label}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

function SectionHead({ title, href, hint }: { title: string; href: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 flex-wrap">
      <div className="flex items-baseline gap-2 flex-wrap min-w-0">
        <h2 className="text-[14px] font-bold text-ppp-charcoal">{title}</h2>
        <span className="text-[11.5px] text-ppp-charcoal-500">{hint}</span>
      </div>
      <Link href={href} className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline shrink-0">
        Full report →
      </Link>
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
