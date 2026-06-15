import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getCommercialOpportunity,
  opportunityStatusLabel,
  opportunitySourceLabel,
  opportunityLossReasonLabel,
  formatBidRange,
  weightedPipelineCents,
  type CommercialOpportunity,
  type OpportunityStatus,
} from "@/lib/commercial/opportunities/db";
import { getCommercialAccount, type CommercialAccount } from "@/lib/commercial/accounts/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";

export const dynamic = "force-dynamic";

type PP = Promise<{ id: string }>;
type SP = Promise<{ tab?: string; error?: string }>;

const TABS = [
  { key: "info", label: "Info" },
  { key: "team", label: "Team" },
  { key: "plans", label: "Plans & Specs" },
  { key: "notes", label: "Notes" },
  { key: "tasks", label: "Tasks" },
  { key: "timeline", label: "Timeline" },
] as const;

export default async function OpportunityDetailPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const sp = await searchParams;
  const tab = (sp.tab && TABS.some((t) => t.key === sp.tab) ? sp.tab : "info") as
    | "info"
    | "team"
    | "plans"
    | "notes"
    | "tasks"
    | "timeline";

  const opp = await getCommercialOpportunity(id);
  if (!opp) notFound();
  const account = await getCommercialAccount(opp.account_id);

  return (
    <div className="space-y-5">
      <header>
        <Link
          href="/commercial/opportunities"
          className="inline-flex items-center gap-1.5 text-sm text-emerald-700 hover:text-emerald-800"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          All opportunities
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal truncate">
              {opp.title}
            </h1>
            <div className="text-sm text-ppp-charcoal-500 mt-1 flex items-center gap-2 flex-wrap">
              {account && (
                <Link
                  href={`/commercial/accounts/${account.id}`}
                  className="text-emerald-700 hover:text-emerald-800 underline underline-offset-2"
                >
                  {account.company_name}
                </Link>
              )}
              <span aria-hidden>·</span>
              <StatusPill status={opp.status} />
            </div>
          </div>
        </div>
      </header>

      {/* Compact KPI strip — bid range, probability, weighted, decision
          countdown if a due date is set. */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiTile
          label="Bid"
          value={formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents)}
        />
        <KpiTile
          label="Probability"
          value={`${opp.probability_pct}%`}
        />
        <KpiTile
          label="Weighted"
          value={formatCentsCompact(weightedPipelineCents(opp))}
        />
        <KpiTile
          label="Decision in"
          value={daysUntilDisplay(opp.proposal_due_at)}
        />
      </section>

      {/* Tab bar */}
      <nav className="border-b border-ppp-charcoal-100">
        <ul className="flex gap-1 sm:gap-2 -mb-px overflow-x-auto">
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <li key={t.key}>
                <Link
                  href={`/commercial/opportunities/${opp.id}?tab=${t.key}`}
                  className={`inline-block px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 transition-colors touch-manipulation whitespace-nowrap ${
                    active
                      ? "border-emerald-600 text-ppp-charcoal"
                      : "border-transparent text-ppp-charcoal-500 hover:text-ppp-charcoal hover:border-ppp-charcoal-100"
                  }`}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {tab === "info" && <InfoTab opp={opp} account={account} errorMessage={pickFirst(sp.error)} />}
      {tab !== "info" && <ComingSoonTab label={TABS.find((t) => t.key === tab)?.label ?? tab} />}
    </div>
  );
}

function InfoTab({
  opp,
  account,
  errorMessage,
}: {
  opp: CommercialOpportunity;
  account: CommercialAccount | null;
  errorMessage?: string;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {errorMessage && (
        <div className="lg:col-span-2 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      <Card title="Deal">
        <Field label="Title" value={opp.title} />
        <Field label="Status" value={opportunityStatusLabel(opp.status)} />
        <Field label="Source" value={opp.source ? opportunitySourceLabel(opp.source) : "—"} />
        <Field label="Probability" value={`${opp.probability_pct}%`} />
      </Card>
      <Card title="Bid + dates">
        <Field
          label="Bid range"
          value={formatBidRange(opp.bid_value_low_cents, opp.bid_value_high_cents)}
        />
        <Field
          label="Weighted"
          value={formatCentsCompact(weightedPipelineCents(opp))}
        />
        <Field label="Proposal due" value={opp.proposal_due_at?.slice(0, 10) ?? "—"} />
        <Field label="Decided" value={opp.decided_at?.slice(0, 10) ?? "—"} />
        <Field label="Proposed start" value={opp.proposed_start_at?.slice(0, 10) ?? "—"} />
        <Field label="Proposed end" value={opp.proposed_end_at?.slice(0, 10) ?? "—"} />
      </Card>
      <Card title="Account">
        {account ? (
          <>
            <Field label="Company" value={account.company_name} />
            <Field label="Industry" value={account.industry ?? "—"} />
            <Field label="Rating" value={account.rating ?? "—"} />
            <p className="text-[12px] mt-2">
              <Link
                href={`/commercial/accounts/${account.id}`}
                className="text-emerald-700 hover:text-emerald-800 underline"
              >
                Open account →
              </Link>
            </p>
          </>
        ) : (
          <p className="text-sm text-ppp-charcoal-500">Account not found.</p>
        )}
      </Card>
      <Card title="Loss tracking">
        <Field
          label="Loss reason"
          value={opp.loss_reason ? opportunityLossReasonLabel(opp.loss_reason) : "—"}
        />
        {opp.loss_notes && (
          <p className="text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed mt-2">
            {opp.loss_notes}
          </p>
        )}
      </Card>
      {opp.description && (
        <Card title="Description" className="lg:col-span-2">
          <p className="text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">
            {opp.description}
          </p>
        </Card>
      )}
    </div>
  );
}

function ComingSoonTab({ label }: { label: string }) {
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
      <div className="text-sm text-ppp-charcoal-500">
        <strong className="text-ppp-charcoal">{label}</strong> tab — ships in a later Phase 2 batch.
      </div>
      <div className="text-[12px] text-ppp-charcoal-500 mt-2">
        Team (Batch 3) · Plans & Specs (Batch 4) · Notes / Tasks / Timeline (Batch 3)
      </div>
    </div>
  );
}

function Card({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white border border-ppp-charcoal-100 rounded-xl p-5 ${className ?? ""}`}>
      <h2 className="text-sm font-bold text-ppp-charcoal mb-3">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 shrink-0 w-32">
        {label}
      </span>
      <span className="text-sm text-ppp-charcoal-700 min-w-0 break-words">
        {value || "—"}
      </span>
    </div>
  );
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-ppp-charcoal-100 rounded-lg px-3 py-2.5 bg-white">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
        {label}
      </div>
      <div className="text-base sm:text-lg font-bold text-ppp-charcoal mt-1 truncate">
        {value}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: OpportunityStatus }) {
  const map: Record<OpportunityStatus, string> = {
    inquiry: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-100",
    site_visit_scheduled: "bg-blue-50 text-blue-700 border-blue-200",
    site_visit_done: "bg-blue-50 text-blue-700 border-blue-200",
    estimating: "bg-amber-50 text-amber-800 border-amber-200",
    proposal_sent: "bg-amber-50 text-amber-800 border-amber-200",
    negotiating: "bg-amber-50 text-amber-800 border-amber-200",
    on_hold: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-100",
    won: "bg-emerald-50 text-emerald-700 border-emerald-200",
    lost: "bg-rose-50 text-rose-700 border-rose-200",
    no_bid: "bg-rose-50 text-rose-700 border-rose-200",
    reopened: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${map[status]}`}>
      {opportunityStatusLabel(status)}
    </span>
  );
}

function formatCentsCompact(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return "$0";
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars).toLocaleString()}`;
}

function daysUntilDisplay(iso: string | null): string {
  if (!iso) return "—";
  const target = new Date(iso.slice(0, 10) + "T00:00:00").getTime();
  if (!Number.isFinite(target)) return "—";
  const days = Math.ceil((target - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `${days}d`;
}
