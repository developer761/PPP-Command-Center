/**
 * `/commercial` — Commercial Command Center landing.
 *
 * Karan 2026-07-20 rebuild: whole dashboard redesigned around what Alex
 * actually needs to see when he opens the platform in the morning.
 *
 * Layout, top-to-bottom:
 *   1. Hero: weighted pipeline $ + wins-this-month card
 *   2. NEEDS ATTENTION strip: overdue proposals, cold RFPs, follow-ups
 *      due, wins awaiting debrief — every card links straight into the
 *      filtered list so Alex triages in one click.
 *   3. KPI strip: open opps · outstanding AR · active GCs · all-time wins
 *   4. Two-column: Top 5 open deals (by weighted $) + Recent activity
 *      (last 5 opps by updated_at)
 *   5. Quick actions grid
 *   6. Roadmap (collapsed <details>)
 *
 * Zero-new-query rebuild: reuses the same three list fetches the prior
 * dashboard already ran (opps, accounts, invoices) — everything else is
 * derived JS-side. Preserves KpiTile + QuickAction primitives from the
 * prior version so styling stays consistent with earlier design tokens.
 */
import Link from "next/link";
import {
  derivedOppName,
  formatOpportunityNumber,
  listCommercialOpportunities,
  opportunityStatusLabel,
  weightedPipelineCents,
  type CommercialOpportunity,
} from "@/lib/commercial/opportunities/db";
import { OPEN_OPP_STATUSES, TERMINAL_STATUSES, isWon } from "@/lib/commercial/opportunities/constants";
import { listCommercialAccounts } from "@/lib/commercial/accounts/db";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { deriveInvoiceStatus } from "@/lib/commercial/invoices/constants";

export const dynamic = "force-dynamic";

const SHIPPED = "bg-emerald-50 text-emerald-700 border-emerald-200";
const UP_NEXT = "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200";
const PHASES = [
  { num: 1, name: "Account Management", status: "Shipped", color: SHIPPED },
  { num: 2, name: "Opportunity Pipeline", status: "Shipped", color: SHIPPED },
  { num: "2.5", name: "Submittals & Finish Schedule", status: "Shipped", color: SHIPPED },
  { num: 3, name: "Invoicing & Revenue", status: "Shipped", color: SHIPPED },
  { num: "3+", name: "Win/Loss Debrief", status: "Shipped", color: SHIPPED },
  { num: "A", name: "Sidebar split + Deal→Opp rename", status: "Shipped", color: SHIPPED },
  { num: "B", name: "Structural fields + estimator", status: "Shipped", color: SHIPPED },
  { num: "C", name: "Documents (polymorphic + versions)", status: "Shipped", color: SHIPPED },
  { num: "D", name: "Product Library + Tomco prices", status: "Shipped", color: SHIPPED },
  { num: "E", name: "Exclusions Library", status: "Shipped", color: SHIPPED },
  { num: "F", name: "Proposal Builder + PDF export", status: "Shipped", color: SHIPPED },
  { num: "G", name: "Deal IDs + archive + lifecycle dates", status: "Shipped", color: SHIPPED },
  { num: "H", name: "Project (post-sale) + Won→Project", status: "Up next", color: UP_NEXT },
];

function formatCentsCompact(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0";
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars).toLocaleString()}`;
}

/** Days between two ISO dates (positive = a before b). Null-safe. */
function daysBetween(fromIso: string | null | undefined, toIso: string): number | null {
  if (!fromIso) return null;
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86_400_000);
}

/** "3 days ago" / "in 2 weeks" / "today". */
function relativeLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const days = daysBetween(iso, new Date().toISOString());
  if (days === null) return "—";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days === -1) return "tomorrow";
  if (days > 0) return `${days}d ago`;
  return `in ${-days}d`;
}

export default async function CommercialDashboardPage() {
  const [opps, accounts, invoices] = await Promise.all([
    listCommercialOpportunities({}),
    listCommercialAccounts({}),
    listCommercialInvoices({}),
  ]);

  // ─── AR ───
  const arOutstandingCents = invoices
    .filter((i) => i.status !== "void")
    .reduce((acc, i) => acc + i.balance_cents, 0);
  const arOverdueCount = invoices.filter((i) => deriveInvoiceStatus(i) === "overdue").length;

  // ─── Opp buckets ───
  const openOpps = opps.filter((o) => OPEN_OPP_STATUSES.includes(o.status));
  const wonOpps = opps.filter((o) => isWon(o));
  const decidedOpps = opps.filter((o) => TERMINAL_STATUSES.has(o.status));
  const weightedPipeline = openOpps.reduce((acc, o) => acc + weightedPipelineCents(o), 0);
  const winRatePct =
    decidedOpps.length > 0 ? Math.round((wonOpps.length / decidedOpps.length) * 100) : null;

  // ─── This month ───
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const wonThisMonth = wonOpps.filter((o) => (o.decided_at ?? "") >= monthStart);
  const wonThisMonthCents = wonThisMonth.reduce((acc, o) => {
    const lo = o.bid_value_low_cents ?? 0;
    const hi = o.bid_value_high_cents ?? lo;
    return acc + Math.round((lo + hi) / 2);
  }, 0);
  const totalDecidedForMonth = decidedOpps.filter(
    (o) => (o.decided_at ?? "") >= monthStart
  ).length;
  const monthWinPct =
    totalDecidedForMonth > 0
      ? Math.round((wonThisMonth.length / totalDecidedForMonth) * 100)
      : null;

  // ─── NEEDS ATTENTION signals ───
  const nowIso = new Date().toISOString();
  const todayEt = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const todayEtIso = todayEt.toISOString();
  // Overdue proposals: open opp, proposal_due_at is in the past, and
  // no proposal was ever sent (heuristic: status still in Proposal-*
  // or earlier). We approximate by counting any open opp whose
  // proposal_due_at is past-due.
  const overdueProposals = openOpps.filter(
    (o) => o.proposal_due_at && o.proposal_due_at < nowIso
  );
  // Cold RFPs: RFP received > 7 days ago, deal still open. Signal
  // that we're sitting on a request without responding.
  const coldRfps = openOpps.filter((o) => {
    const days = daysBetween(o.rfp_received_at, nowIso);
    return days !== null && days > 7;
  });
  // Follow-ups due today or overdue: follow_up_at ≤ today.
  const followupsDue = openOpps.filter(
    (o) => o.follow_up_at && o.follow_up_at <= todayEtIso
  );
  // Wins awaiting debrief: terminal + won + win_loss_debriefed_at NULL.
  const winsAwaitingDebrief = wonOpps.filter((o) => !o.win_loss_debriefed_at);

  // ─── TOP 5 OPEN DEALS by weighted value ───
  const accountNameById = new Map(accounts.map((a) => [a.id, a.company_name]));
  const topOpenDeals = openOpps
    .slice()
    .sort((a, b) => weightedPipelineCents(b) - weightedPipelineCents(a))
    .slice(0, 5);

  // ─── RECENT ACTIVITY (last 5 opps by updated_at) ───
  const recentOpps = opps
    .slice()
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, 5);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Hero — unchanged structure, high-density KPIs at the top. */}
      <header className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2 relative bg-white border border-cc-brand-100 rounded-xl p-4 sm:p-5 shadow-sm overflow-hidden">
          <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-cc-brand-600 via-cc-brand-500 to-cc-brand-400" />
          <span aria-hidden className="pointer-events-none absolute -top-12 -right-12 h-40 w-40 rounded-full bg-cc-brand-100/60 blur-2xl" />
          <div className="relative pl-2">
            <div className="flex flex-wrap items-center gap-2 mb-1.5">
              <div className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
                Commercial Command Center
              </div>
              <span className="inline-flex items-center gap-1 text-[9px] font-bold tracking-widest uppercase text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-full">
                <span aria-hidden className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live
              </span>
            </div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <div className="font-condensed text-3xl sm:text-4xl font-black text-ppp-charcoal leading-none tracking-tight">
                {formatCentsCompact(weightedPipeline)}
              </div>
              <div className="text-[12px] text-ppp-charcoal-500">
                weighted pipeline · {openOpps.length} open
              </div>
            </div>
          </div>
        </div>
        <div className="relative bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 shadow-sm overflow-hidden">
          <span aria-hidden className="pointer-events-none absolute -top-8 -right-8 h-24 w-24 rounded-full bg-emerald-100/40 blur-2xl" />
          <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-emerald-600 via-emerald-500 to-emerald-400" />
          <div className="relative">
            <div className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500 mb-1.5">
              Wins this month
            </div>
            <div className="flex items-baseline gap-2">
              <div className="font-condensed text-3xl sm:text-4xl font-black text-ppp-charcoal leading-none tracking-tight">
                {wonThisMonth.length}
              </div>
              {monthWinPct !== null && (
                <div className="text-[12px] text-emerald-700 font-semibold">
                  {monthWinPct}% win rate
                </div>
              )}
            </div>
            <div className="mt-1.5 text-[11px] text-ppp-charcoal-500 truncate">
              {wonThisMonthCents > 0
                ? `${formatCentsCompact(wonThisMonthCents)} awarded value`
                : wonThisMonth.length === 0
                ? "No wins recorded yet this month"
                : "Awarded value not set on wins"}
            </div>
          </div>
        </div>
      </header>

      {/* ─── NEEDS ATTENTION strip ─── */}
      {(overdueProposals.length > 0 ||
        coldRfps.length > 0 ||
        followupsDue.length > 0 ||
        winsAwaitingDebrief.length > 0) && (
        <section>
          <h2 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            Needs your attention
          </h2>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <AttentionCard
              count={overdueProposals.length}
              label="Overdue proposals"
              sub={overdueProposals.length === 1 ? "1 bid past its due date" : `${overdueProposals.length} bids past due date`}
              href="/commercial/opportunities?stale=1"
              tone="rose"
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 6v6 M12 16.5v.5" />
                </svg>
              }
            />
            <AttentionCard
              count={coldRfps.length}
              label="Cold RFPs (>7d)"
              sub={coldRfps.length === 0 ? "None sitting cold" : "Sitting on the bid request"}
              href="/commercial/opportunities"
              tone="amber"
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 2v6a6 6 0 0 0 12 0V2 M6 22v-6a6 6 0 0 1 12 0v6 M4 2h16 M4 22h16" />
                </svg>
              }
            />
            <AttentionCard
              count={followupsDue.length}
              label="Follow-ups due"
              sub={followupsDue.length === 0 ? "Nothing scheduled" : "Check in today"}
              href="/commercial/opportunities"
              tone="cc-brand"
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 8v4l3 3" />
                  <circle cx="12" cy="12" r="10" />
                </svg>
              }
            />
            <AttentionCard
              count={winsAwaitingDebrief.length}
              label="Awaiting debrief"
              sub={winsAwaitingDebrief.length === 0 ? "All debriefed" : "Won deals need debrief"}
              href="/commercial/reports/win-loss"
              tone="emerald"
              icon={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              }
            />
          </div>
        </section>
      )}

      {/* ─── KPI strip ─── */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiTile
          tone="cc-brand"
          value={openOpps.length.toLocaleString()}
          label="Open opportunities"
          sub={`${decidedOpps.length} decided all-time`}
          href="/commercial/opportunities"
          icon={<IconTarget />}
        />
        <KpiTile
          tone={arOutstandingCents > 0 && arOverdueCount > 0 ? "rose" : "blue"}
          value={formatCentsCompact(arOutstandingCents)}
          label="Outstanding AR"
          sub={
            arOutstandingCents === 0
              ? "Nothing unpaid"
              : arOverdueCount > 0
              ? `${arOverdueCount} overdue`
              : "Unpaid balance"
          }
          href={
            arOverdueCount > 0
              ? "/commercial/invoices?status=overdue"
              : "/commercial/invoices?status=sent"
          }
          icon={<IconDollar />}
        />
        <KpiTile
          tone="blue"
          value={accounts.length.toLocaleString()}
          label="Active GCs"
          sub={accounts.length === 1 ? "GC of record" : "GCs of record"}
          href="/commercial/accounts"
          icon={<IconBuilding />}
        />
        <KpiTile
          tone="emerald"
          value={wonOpps.length.toLocaleString()}
          label="All-time wins"
          sub={winRatePct !== null ? `${winRatePct}% overall win rate` : "No history yet"}
          href="/commercial/reports/win-loss"
          icon={<IconTrophy />}
        />
      </section>

      {/* ─── Two-column: Top 5 open + Recent activity ─── */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <TopOpenDealsCard opps={topOpenDeals} accountNameById={accountNameById} />
        <RecentActivityCard opps={recentOpps} accountNameById={accountNameById} />
      </section>

      {/* ─── Quick actions ─── */}
      <section>
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Quick actions
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <QuickAction
            primary
            href={`/commercial/accounts?status_error=${encodeURIComponent("Pick the GC (account) first — deals live under the GC.")}`}
            title="Start a bid"
            sub="Pick a GC to log the deal under."
            icon={<IconPlus />}
          />
          <QuickAction
            href="/commercial/accounts/new"
            title="Add GC (account)"
            sub="Create a new commercial GC account."
            icon={<IconBuilding />}
          />
          <QuickAction
            href="/commercial/opportunities"
            title="Pipeline board"
            sub="Drag deals through stages."
            icon={<IconKanban />}
          />
          <QuickAction
            href="/commercial/reports/win-loss"
            title="Win/Loss report"
            sub="Quarterly debrief numbers."
            icon={<IconChart />}
          />
        </div>
      </section>

      {/* Roadmap */}
      <details className="group/roadmap bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
        <summary className="list-none cursor-pointer flex items-center justify-between gap-2 px-4 py-3 min-h-[44px] hover:bg-ppp-charcoal-50/60 touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            <span className="text-sm font-bold text-ppp-charcoal">Build roadmap</span>
            <span className="text-[11px] text-ppp-charcoal-500">
              — {PHASES.filter((p) => p.status === "Shipped").length}/{PHASES.length} phases live
            </span>
          </span>
          <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-ppp-charcoal-400 transition-transform group-open/roadmap:rotate-180">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </summary>
        <div className="p-4 border-t border-ppp-charcoal-100">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {PHASES.map((p) => (
              <div key={String(p.num)} className="rounded-lg border border-ppp-charcoal-100 bg-white px-3 py-2.5">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full bg-ppp-charcoal text-white text-[10px] font-bold">
                    {p.num}
                  </span>
                  <span className={`text-[9px] font-bold tracking-widest uppercase border px-1.5 py-0.5 rounded ${p.color}`}>
                    {p.status}
                  </span>
                </div>
                <div className="text-[12px] font-semibold text-ppp-charcoal leading-snug">{p.name}</div>
              </div>
            ))}
          </div>
        </div>
      </details>
    </div>
  );
}

// ─────────────── Attention card ───────────────

function AttentionCard({
  count,
  label,
  sub,
  href,
  tone,
  icon,
}: {
  count: number;
  label: string;
  sub: string;
  href: string;
  tone: "rose" | "amber" | "cc-brand" | "emerald";
  icon: React.ReactNode;
}) {
  const isZero = count === 0;
  // Zero-state = neutral / low-emphasis; non-zero = tone-colored + hoverable.
  const ring = isZero
    ? "border-ppp-charcoal-100 bg-white hover:border-ppp-charcoal-200"
    : tone === "rose"
    ? "border-rose-200 bg-rose-50/40 hover:border-rose-400 hover:bg-rose-50/70"
    : tone === "amber"
    ? "border-amber-200 bg-amber-50/40 hover:border-amber-400 hover:bg-amber-50/70"
    : tone === "cc-brand"
    ? "border-cc-brand-200 bg-cc-brand-50/40 hover:border-cc-brand-400 hover:bg-cc-brand-50/70"
    : "border-emerald-200 bg-emerald-50/40 hover:border-emerald-400 hover:bg-emerald-50/70";
  const numberCls = isZero
    ? "text-ppp-charcoal-300"
    : tone === "rose"
    ? "text-rose-700"
    : tone === "amber"
    ? "text-amber-700"
    : tone === "cc-brand"
    ? "text-cc-brand-700"
    : "text-emerald-700";
  const iconCls = isZero
    ? "bg-ppp-charcoal-50 text-ppp-charcoal-400"
    : tone === "rose"
    ? "bg-rose-100 text-rose-700"
    : tone === "amber"
    ? "bg-amber-100 text-amber-700"
    : tone === "cc-brand"
    ? "bg-cc-brand-100 text-cc-brand-700"
    : "bg-emerald-100 text-emerald-700";
  return (
    <Link
      href={href}
      aria-disabled={isZero}
      tabIndex={isZero ? -1 : 0}
      className={`group/att relative block border rounded-xl px-4 py-3 min-h-[92px] transition-all hover:shadow-md touch-manipulation ${ring} ${isZero ? "pointer-events-none opacity-70" : ""}`}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
          {label}
        </span>
        <span aria-hidden className={`inline-flex items-center justify-center h-7 w-7 rounded-lg ${iconCls}`}>
          {icon}
        </span>
      </div>
      <div className={`font-condensed text-3xl font-black leading-none tracking-tight tabular-nums ${numberCls}`}>
        {count}
      </div>
      <div className="mt-1 text-[11px] text-ppp-charcoal-500 leading-snug">
        {sub}
      </div>
    </Link>
  );
}

// ─────────────── Top 5 open deals ───────────────

function TopOpenDealsCard({
  opps,
  accountNameById,
}: {
  opps: CommercialOpportunity[];
  accountNameById: Map<string, string>;
}) {
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-ppp-charcoal-100">
        <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Top 5 open deals
        </h3>
        <Link
          href="/commercial/opportunities"
          className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[24px] inline-flex items-center"
        >
          Full pipeline →
        </Link>
      </header>
      {opps.length === 0 ? (
        <div className="p-6 text-center text-[12.5px] text-ppp-charcoal-400">
          Nothing open. Log your next bid to see it here.
        </div>
      ) : (
        <ol className="divide-y divide-ppp-charcoal-100">
          {opps.map((o, idx) => {
            const acct = accountNameById.get(o.account_id) ?? null;
            const display = derivedOppName(o, acct);
            const weighted = weightedPipelineCents(o);
            const oppCode = formatOpportunityNumber(o.project_number);
            return (
              <li key={o.id}>
                <Link
                  href={`/commercial/accounts/${o.account_id}?tab=opportunities&deal=${o.id}#deal-row-${o.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 min-h-[52px] hover:bg-ppp-charcoal-50/60 touch-manipulation"
                >
                  <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-cc-brand-100 text-cc-brand-700 text-[11px] font-bold tabular-nums shrink-0">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold text-ppp-charcoal truncate">
                      {display}
                    </div>
                    <div className="text-[10.5px] text-ppp-charcoal-500 truncate flex items-center gap-1.5 mt-0.5">
                      {oppCode && <span className="font-mono text-ppp-navy-600">{oppCode}</span>}
                      {oppCode && <span aria-hidden>·</span>}
                      <span>{opportunityStatusLabel(o.status)}</span>
                      {o.proposal_due_at && (
                        <>
                          <span aria-hidden>·</span>
                          <span>Due {relativeLabel(o.proposal_due_at)}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[12.5px] font-bold text-ppp-charcoal tabular-nums">
                      {formatCentsCompact(weighted)}
                    </div>
                    <div className="text-[9.5px] text-ppp-charcoal-400 uppercase tracking-wider">
                      weighted
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ─────────────── Recent activity ───────────────

function RecentActivityCard({
  opps,
  accountNameById,
}: {
  opps: CommercialOpportunity[];
  accountNameById: Map<string, string>;
}) {
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 border-b border-ppp-charcoal-100">
        <h3 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Recent activity
        </h3>
        <Link
          href="/commercial/opportunities?sort=updated"
          className="text-[11.5px] font-semibold text-cc-brand-700 hover:underline min-h-[24px] inline-flex items-center"
        >
          All deals →
        </Link>
      </header>
      {opps.length === 0 ? (
        <div className="p-6 text-center text-[12.5px] text-ppp-charcoal-400">
          No deals yet. Start your first bid to see activity here.
        </div>
      ) : (
        <ol className="divide-y divide-ppp-charcoal-100">
          {opps.map((o) => {
            const acct = accountNameById.get(o.account_id) ?? null;
            const display = derivedOppName(o, acct);
            const oppCode = formatOpportunityNumber(o.project_number);
            const relative = relativeLabel(o.updated_at);
            return (
              <li key={o.id}>
                <Link
                  href={`/commercial/accounts/${o.account_id}?tab=opportunities&deal=${o.id}#deal-row-${o.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 min-h-[52px] hover:bg-ppp-charcoal-50/60 touch-manipulation"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold text-ppp-charcoal truncate">
                      {display}
                    </div>
                    <div className="text-[10.5px] text-ppp-charcoal-500 truncate flex items-center gap-1.5 mt-0.5">
                      {oppCode && <span className="font-mono text-ppp-navy-600">{oppCode}</span>}
                      {oppCode && <span aria-hidden>·</span>}
                      <span>{opportunityStatusLabel(o.status)}</span>
                    </div>
                  </div>
                  <div className="text-[11px] text-ppp-charcoal-500 shrink-0 tabular-nums whitespace-nowrap">
                    {relative}
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ─────────────── Reusable tiles ───────────────

function KpiTile({
  tone,
  value,
  label,
  sub,
  href,
  icon,
}: {
  tone: "cc-brand" | "blue" | "rose" | "emerald";
  value: string;
  label: string;
  sub: string;
  href: string;
  icon: React.ReactNode;
}) {
  const ring =
    tone === "cc-brand"
      ? "border-cc-brand-100/70 bg-white hover:border-cc-brand-300"
      : tone === "rose"
      ? "border-rose-100/70 bg-white hover:border-rose-300"
      : tone === "emerald"
      ? "border-emerald-100/70 bg-white hover:border-emerald-300"
      : "border-blue-100/70 bg-white hover:border-blue-300";
  const glow =
    tone === "cc-brand"
      ? "bg-cc-brand-100/60"
      : tone === "rose"
      ? "bg-rose-100/60"
      : tone === "emerald"
      ? "bg-emerald-100/60"
      : "bg-blue-100/50";
  const stripe =
    tone === "cc-brand" ? "bg-gradient-to-b from-cc-brand-600 via-cc-brand-500 to-cc-brand-400"
    : tone === "rose" ? "bg-gradient-to-b from-rose-600 via-rose-500 to-rose-400"
    : tone === "emerald" ? "bg-gradient-to-b from-emerald-600 via-emerald-500 to-emerald-400"
    : "bg-gradient-to-b from-blue-600 via-blue-500 to-blue-400";
  const iconCls =
    tone === "cc-brand"
      ? "bg-gradient-to-br from-cc-brand-100 to-cc-brand-50 text-cc-brand-700 group-hover/kpi:from-cc-brand-600 group-hover/kpi:to-cc-brand-500 group-hover/kpi:text-white"
      : tone === "rose"
      ? "bg-gradient-to-br from-rose-100 to-rose-50 text-rose-700 group-hover/kpi:from-rose-600 group-hover/kpi:to-rose-500 group-hover/kpi:text-white"
      : tone === "emerald"
      ? "bg-gradient-to-br from-emerald-100 to-emerald-50 text-emerald-700 group-hover/kpi:from-emerald-600 group-hover/kpi:to-emerald-500 group-hover/kpi:text-white"
      : "bg-gradient-to-br from-blue-100 to-blue-50 text-blue-700 group-hover/kpi:from-blue-600 group-hover/kpi:to-blue-500 group-hover/kpi:text-white";
  return (
    <Link
      href={href}
      className={`group/kpi relative block border rounded-xl px-4 py-4 overflow-hidden shadow-sm transition-all hover:shadow-lg hover:-translate-y-0.5 touch-manipulation ${ring}`}
    >
      <span aria-hidden className={`pointer-events-none absolute -top-10 -right-10 w-28 h-28 rounded-full blur-2xl opacity-80 ${glow}`} />
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-1 ${stripe}`} />
      <div className="relative pl-1">
        <div className="flex items-start justify-between gap-2 mb-2.5">
          <span className="text-[9.5px] font-bold uppercase tracking-widest text-ppp-charcoal-500">
            {label}
          </span>
          <span aria-hidden className={`inline-flex items-center justify-center h-9 w-9 rounded-xl shadow-sm transition-all group-hover/kpi:shadow-md ${iconCls}`}>
            {icon}
          </span>
        </div>
        <div className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal leading-none tracking-tight">
          {value}
        </div>
        <div className="mt-1.5 text-[11px] text-ppp-charcoal-500 leading-snug">
          {sub}
        </div>
      </div>
    </Link>
  );
}

function QuickAction({
  primary,
  href,
  title,
  sub,
  icon,
}: {
  primary?: boolean;
  href: string;
  title: string;
  sub: string;
  icon: React.ReactNode;
}) {
  const shell = primary
    ? "group/qa bg-gradient-to-br from-cc-brand-100/40 via-white to-white border-cc-brand-200 text-ppp-charcoal hover:border-cc-brand-400 shadow-sm shadow-cc-brand-100/40 relative overflow-hidden"
    : "group/qa bg-white border-ppp-charcoal-100 text-ppp-charcoal hover:border-cc-brand-300 shadow-sm relative overflow-hidden";
  const iconCls = primary
    ? "bg-gradient-to-br from-cc-brand-500 to-cc-brand-600 text-white shadow-md shadow-cc-brand-200 group-hover/qa:from-cc-brand-600 group-hover/qa:to-cc-brand-700"
    : "bg-gradient-to-br from-cc-brand-100 to-cc-brand-50 text-cc-brand-700 group-hover/qa:from-cc-brand-600 group-hover/qa:to-cc-brand-500 group-hover/qa:text-white group-hover/qa:shadow-md group-hover/qa:shadow-cc-brand-200";
  return (
    <Link
      href={href}
      className={`block border rounded-xl px-4 py-4 transition-all hover:shadow-lg hover:-translate-y-0.5 touch-manipulation ${shell}`}
    >
      {primary ? (
        <span aria-hidden className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-cc-brand-600 via-cc-brand-500 to-cc-brand-400" />
      ) : null}
      <span aria-hidden className={`pointer-events-none absolute -top-8 -right-8 w-24 h-24 rounded-full blur-2xl opacity-70 ${primary ? "bg-cc-brand-100/60" : "bg-cc-brand-50/60 group-hover/qa:bg-cc-brand-100/70"}`} />
      <div className={`relative ${primary ? "pl-1" : ""}`}>
        <span aria-hidden className={`inline-flex items-center justify-center h-11 w-11 rounded-xl mb-3 transition-all ${iconCls}`}>
          {icon}
        </span>
        <div className="text-sm font-bold leading-tight tracking-tight flex items-center gap-1.5">
          {title}
          <span aria-hidden className="text-cc-brand-400 opacity-0 group-hover/qa:opacity-100 group-hover/qa:translate-x-1 transition-all">→</span>
        </div>
        <div className="mt-1 text-[12px] leading-snug text-ppp-charcoal-500">{sub}</div>
      </div>
    </Link>
  );
}

// ─────────────── Icons ───────────────

function IconTarget() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}
function IconChart() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 3v18h18 M7 14l4-4 4 4 5-5" />
    </svg>
  );
}
function IconBuilding() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="2" width="16" height="20" rx="1" />
      <path d="M9 22v-4h6v4 M8 6h2 M14 6h2 M8 10h2 M14 10h2 M8 14h2 M14 14h2" />
    </svg>
  );
}
function IconTrophy() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 21h8 M12 17v4 M17 5h3v3a4 4 0 0 1-4 4M7 5H4v3a4 4 0 0 0 4 4 M7 3h10v9a5 5 0 0 1-10 0V3z" />
    </svg>
  );
}
function IconDollar() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14 M5 12h14" />
    </svg>
  );
}
function IconKanban() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7" height="18" rx="1" />
      <rect x="14" y="3" width="7" height="12" rx="1" />
    </svg>
  );
}
