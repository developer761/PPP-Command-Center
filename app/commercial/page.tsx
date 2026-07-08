/**
 * `/commercial` — Commercial Command Center landing.
 *
 * Live executive dashboard: KPI strip pulled from actual DB tables
 * (open opps count, weighted pipeline $, active accounts, wins this
 * month), quick-action grid pointing at the primary surfaces, and a
 * condensed roadmap at the bottom so Alex sees "what's shipped vs
 * queued" at a glance without it dominating the page.
 *
 * Karan 2026-07-05: "make the UI/UX better and more inviting like the
 * PPP command center, this still looks blandish and boring." Landing
 * gained the KPI strip + quick actions cards.
 */
import Link from "next/link";
import {
  listCommercialOpportunities,
  weightedPipelineCents,
} from "@/lib/commercial/opportunities/db";
import { OPEN_OPP_STATUSES, TERMINAL_STATUSES } from "@/lib/commercial/opportunities/constants";
import { listCommercialAccounts } from "@/lib/commercial/accounts/db";
import { listCommercialInvoices } from "@/lib/commercial/invoices/db";
import { BILLABLE_INVOICE_STATUSES, deriveInvoiceStatus } from "@/lib/commercial/invoices/constants";

export const dynamic = "force-dynamic";

// Roadmap statuses. Keep in sync with what's actually been merged on main.
const PHASES = [
  { num: 1, name: "Account Management", status: "Shipped", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { num: 2, name: "Opportunity (Preconstruction)", status: "Shipped", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { num: "2.5", name: "Submittals & Finish Schedule", status: "Shipped", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { num: 3, name: "Invoicing & Revenue", status: "Shipped", color: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  { num: 4, name: "Contract Award", status: "Up next", color: "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200" },
  { num: 5, name: "Project Setup", status: "Queued", color: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200" },
  { num: 6, name: "Project Execution", status: "Queued", color: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200" },
  { num: 7, name: "Change Management", status: "Queued", color: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200" },
  { num: 9, name: "Closeout", status: "Queued", color: "bg-ppp-charcoal-50 text-ppp-charcoal-600 border-ppp-charcoal-200" },
];

function formatCentsCompact(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0";
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars).toLocaleString()}`;
}

export default async function CommercialDashboardPage() {
  // Kick off both queries in parallel — the landing must feel snappy.
  // Both list helpers already fail-soft to [] on error so a partial
  // failure just shows zeros, not an error state.
  const [opps, accounts, invoices] = await Promise.all([
    listCommercialOpportunities({}),
    listCommercialAccounts({}),
    listCommercialInvoices({}),
  ]);
  // Outstanding AR: sum of balance across all currently-billable invoices
  // (sent + viewed + partial + overdue). Excludes drafts (not sent yet)
  // and paid/void (settled). Overdue is a derived state (due_at < now +
  // balance > 0), so we route the click to the overdue-filtered list
  // when any overdue exists — otherwise to the sent list.
  const arOutstandingCents = invoices
    .filter((i) => BILLABLE_INVOICE_STATUSES.has(deriveInvoiceStatus(i)))
    .reduce((acc, i) => acc + i.balance_cents, 0);
  const arOverdueCount = invoices.filter((i) => deriveInvoiceStatus(i) === "overdue").length;

  const openOpps = opps.filter((o) => OPEN_OPP_STATUSES.includes(o.status));
  const wonOpps = opps.filter((o) => o.status === "won");
  const decidedOpps = opps.filter((o) => TERMINAL_STATUSES.has(o.status));
  const weightedPipeline = openOpps.reduce((acc, o) => acc + weightedPipelineCents(o), 0);

  // "This month" = anything decided (decided_at) within the current
  // calendar month in America/New_York. Simple + matches how Alex
  // will report to Ari.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const wonThisMonth = wonOpps.filter((o) => (o.decided_at ?? "") >= monthStart);

  // Win rate over decided opps (won / decided). Renders "—" when
  // there's no history yet so the tile doesn't lie with 0%.
  const winRatePct =
    decidedOpps.length > 0 ? Math.round((wonOpps.length / decidedOpps.length) * 100) : null;

  return (
    <div className="space-y-8">
      {/* Hero — same clean shape as PageHeader (3px×40px red accent bar
          → title → subtitle) so the landing sits inside the same visual
          vocabulary as every other Commercial CC surface. */}
      <header>
        <span aria-hidden className="block h-[3px] w-10 rounded-full mb-3 bg-cc-brand-600" />
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ppp-charcoal">
            Commercial Command Center
          </h1>
          <span className="inline-flex items-center text-[10px] font-bold tracking-widest uppercase text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded">
            Phase 3 · Invoicing Live
          </span>
        </div>
        <p className="text-sm text-ppp-charcoal-500">
          From bid intake to closeout, all in one record. Real numbers below — live from Postgres.
        </p>
      </header>

      {/* Live KPI strip. Red-accent tile = primary metric (open pipeline
          motion). Blue = supporting (accounts / wins). Left accent stripe
          + subtle gradient background gives visual weight without shouting. */}
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiTile
          tone="cc-brand"
          value={openOpps.length.toLocaleString()}
          label="Open deals"
          sub={`${decidedOpps.length} decided`}
          href="/commercial/opportunities"
          icon={<IconTarget />}
        />
        <KpiTile
          tone="cc-brand"
          value={formatCentsCompact(weightedPipeline)}
          label="Weighted pipeline"
          sub="Σ midpoint × probability"
          href="/commercial/opportunities?view=list"
          icon={<IconChart />}
        />
        <KpiTile
          tone={arOverdueCount > 0 ? "rose" : "blue"}
          value={formatCentsCompact(arOutstandingCents)}
          label="Outstanding AR"
          sub={
            arOutstandingCents === 0
              ? "nothing unpaid"
              : arOverdueCount > 0
              ? `${arOverdueCount} overdue`
              : "unpaid balance"
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
          label="Active accounts"
          sub={accounts.length === 1 ? "customer of record" : "customers of record"}
          href="/commercial/accounts"
          icon={<IconBuilding />}
        />
        <KpiTile
          tone="blue"
          value={wonThisMonth.length.toLocaleString()}
          label="Wins this month"
          sub={winRatePct !== null ? `${winRatePct}% overall win rate` : "no history yet"}
          href="/commercial/reports/win-loss"
          icon={<IconTrophy />}
        />
      </section>

      {/* Quick actions — the four moves Alex uses daily. Big, tap-friendly
          cards with icon + label + sub-copy. Red primary card = the top
          action (start a new bid); the rest are supporting entry points
          in white with a colored icon puck. */}
      <section>
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2">
          <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
          Quick actions
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <QuickAction
            primary
            href={`/commercial/accounts?status_error=${encodeURIComponent("Pick the customer first — deals live under their account.")}`}
            title="Start a bid"
            sub="Pick a customer to log the deal under."
            icon={<IconPlus />}
          />
          <QuickAction
            href="/commercial/accounts/new"
            title="Add customer"
            sub="Create a commercial account."
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

      {/* Roadmap — Karan 2026-07-08 Batch 3: collapsed into a <details>
          so it stops burning above-the-fold real estate. A working
          operator doesn't need to see the build plan every session; a
          product/stakeholder viewer can click to expand. */}
      <details className="group/roadmap bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
        <summary className="list-none cursor-pointer flex items-center justify-between gap-2 px-4 py-3 min-h-[44px] hover:bg-ppp-charcoal-50/60 touch-manipulation focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30">
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />
            <span className="text-sm font-bold text-ppp-charcoal">Build roadmap</span>
            <span className="text-[11px] text-ppp-charcoal-500">
              — {PHASES.filter((p) => p.status === "Shipped").length}/{PHASES.length} phases live
            </span>
          </span>
          <span aria-hidden className="text-ppp-charcoal-400 transition-transform group-open/roadmap:rotate-180">▾</span>
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

// ─────────────── Reusable tiles ───────────────

function KpiTile({
  tone,
  value,
  label,
  sub,
  href,
  icon,
}: {
  tone: "cc-brand" | "blue" | "rose";
  value: string;
  label: string;
  sub: string;
  href: string;
  icon: React.ReactNode;
}) {
  // Left accent stripe + soft-tinted gradient background. The stripe
  // is the "signature" — same shape as PageHeader's 3px accent bar.
  // Rose tone reserved for "attention needed" (overdue AR) so the eye
  // catches it without shouting like an error banner would.
  const ring =
    tone === "cc-brand"
      ? "border-cc-brand-200 bg-gradient-to-br from-white to-cc-brand-50/60"
      : tone === "rose"
      ? "border-rose-200 bg-gradient-to-br from-white to-rose-50/60"
      : "border-blue-200 bg-gradient-to-br from-white to-blue-50/60";
  const stripe =
    tone === "cc-brand" ? "bg-cc-brand-600" : tone === "rose" ? "bg-rose-500" : "bg-blue-500";
  const iconCls =
    tone === "cc-brand"
      ? "bg-cc-brand-100 text-cc-brand-700"
      : tone === "rose"
      ? "bg-rose-100 text-rose-700"
      : "bg-blue-100 text-blue-700";
  return (
    <Link
      href={href}
      className={`relative block border rounded-xl px-4 py-4 overflow-hidden shadow-sm transition-all hover:shadow-md hover:-translate-y-0.5 touch-manipulation ${ring}`}
    >
      <span aria-hidden className={`absolute left-0 top-0 bottom-0 w-[3px] ${stripe}`} />
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
          {label}
        </span>
        <span aria-hidden className={`inline-flex items-center justify-center h-7 w-7 rounded-lg ${iconCls}`}>
          {icon}
        </span>
      </div>
      <div className="text-2xl sm:text-3xl font-bold text-ppp-charcoal leading-none">
        {value}
      </div>
      <div className="mt-1.5 text-[11px] text-ppp-charcoal-500 leading-snug">
        {sub}
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
  // Karan 2026-07-07: primary card was too bold as solid red — softened
  // to a white card with a red left-stripe + red icon puck. Still reads
  // as "the main action" (icon color, subtle red glow) but doesn't
  // dominate the row. Matches the KPI-tile signature above.
  const shell = primary
    ? "bg-white border-cc-brand-200 text-ppp-charcoal hover:border-cc-brand-300 shadow-sm shadow-cc-brand-100/40 relative overflow-hidden"
    : "bg-white border-ppp-charcoal-100 text-ppp-charcoal hover:border-cc-brand-200";
  const iconCls = primary
    ? "bg-cc-brand-100 text-cc-brand-700"
    : "bg-cc-brand-50 text-cc-brand-700";
  const subCls = "text-ppp-charcoal-500";
  return (
    <Link
      href={href}
      className={`block border rounded-xl px-4 py-4 transition-all hover:shadow-md hover:-translate-y-0.5 touch-manipulation ${shell}`}
    >
      {primary && (
        <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px] bg-cc-brand-600" />
      )}
      <span aria-hidden className={`inline-flex items-center justify-center h-9 w-9 rounded-lg mb-3 ${iconCls}`}>
        {icon}
      </span>
      <div className="text-sm font-bold leading-tight">{title}</div>
      <div className={`mt-1 text-[12px] leading-snug ${subCls}`}>{sub}</div>
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
