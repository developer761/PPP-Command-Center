import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  getCommercialOpportunity,
  opportunityStatusLabel,
  opportunitySourceLabel,
  opportunityLossReasonLabel,
  formatBidRange,
  weightedPipelineCents,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_LOSS_REASONS,
  type CommercialOpportunity,
  type OpportunityStatus,
  type OpportunityLossReason,
} from "@/lib/commercial/opportunities/db";
import { getCommercialAccount, type CommercialAccount } from "@/lib/commercial/accounts/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import {
  allowedNextStatuses,
  changeOpportunityStatus,
  shouldWarnTransition,
} from "@/lib/commercial/opportunities/status";

export const dynamic = "force-dynamic";

type PP = Promise<{ id: string }>;
type SP = Promise<{ tab?: string; error?: string; action?: string; to?: string; status_ok?: string }>;

async function changeStatusAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const opp_id = String(formData.get("opp_id") ?? "");
  const to_status = String(formData.get("to_status") ?? "");
  if (!UUID_RE.test(opp_id)) redirect("/commercial/opportunities");
  if (!(OPPORTUNITY_STATUSES as readonly string[]).includes(to_status)) {
    redirect(`/commercial/opportunities/${opp_id}?error=` + encodeURIComponent("Invalid status."));
  }
  const lossReasonRaw = String(formData.get("loss_reason") ?? "").trim();
  const noteRaw = String(formData.get("note") ?? "").trim();
  const loss_reason =
    lossReasonRaw && (OPPORTUNITY_LOSS_REASONS as readonly string[]).includes(lossReasonRaw)
      ? (lossReasonRaw as OpportunityLossReason)
      : null;
  const result = await changeOpportunityStatus({
    opp_id,
    to_status: to_status as OpportunityStatus,
    acting_user_id: user.id,
    note: noteRaw || null,
    loss_reason,
  });
  if (!result.ok) {
    redirect(`/commercial/opportunities/${opp_id}?error=` + encodeURIComponent(result.error));
  }
  redirect(`/commercial/opportunities/${opp_id}?tab=info&status_ok=1`);
}

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
          className="inline-flex items-center gap-1.5 text-sm text-emerald-700 hover:text-emerald-800 min-h-[44px] touch-manipulation -ml-1 px-1"
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
          tooltip={weightedTooltip(opp)}
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
                  className={`inline-flex items-center px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 transition-colors touch-manipulation whitespace-nowrap min-h-[44px] ${
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

      {tab === "info" && (
        <InfoTab
          opp={opp}
          account={account}
          errorMessage={pickFirst(sp.error)}
          statusOk={pickFirst(sp.status_ok) === "1"}
          preselectTo={pickFirst(sp.to) as OpportunityStatus | undefined}
        />
      )}
      {tab !== "info" && <ComingSoonTab label={TABS.find((t) => t.key === tab)?.label ?? tab} />}
    </div>
  );
}

function InfoTab({
  opp,
  account,
  errorMessage,
  statusOk,
  preselectTo,
}: {
  opp: CommercialOpportunity;
  account: CommercialAccount | null;
  errorMessage?: string;
  statusOk?: boolean;
  preselectTo?: OpportunityStatus;
}) {
  // Filter the DAG-allowed next statuses by what we actually want to
  // expose in this surface. Detail page allows ALL valid transitions,
  // including terminal ones (won/lost/no_bid) because we have room for
  // the loss-reason picker. List-page quick-flip hides terminals.
  const nextStatuses = allowedNextStatuses(opp.status);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {errorMessage && (
        <div className="lg:col-span-2 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}
      {statusOk && (
        <div className="lg:col-span-2 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-700 flex items-start justify-between gap-3">
          <span>Status updated to <strong>{opportunityStatusLabel(opp.status)}</strong>.</span>
          <Link
            href={`/commercial/opportunities/${opp.id}`}
            className="text-[12px] text-emerald-700 hover:text-emerald-900 underline shrink-0 min-h-[24px] inline-flex items-center"
          >
            Dismiss
          </Link>
        </div>
      )}
      <ChangeStatusCard
        opp={opp}
        nextStatuses={nextStatuses}
        preselectTo={preselectTo}
        className="lg:col-span-2"
      />
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

function ChangeStatusCard({
  opp,
  nextStatuses,
  preselectTo,
  className,
}: {
  opp: CommercialOpportunity;
  nextStatuses: ReadonlyArray<OpportunityStatus>;
  preselectTo?: OpportunityStatus;
  className?: string;
}) {
  // Render the pre-selected status (from list-page quick-flip's
  // "open detail to reopen" handoff, e.g. ?to=lost) as the default
  // so the user lands on the right form without re-picking. Only
  // honor preselectTo if it's actually a valid next status.
  const defaultTo =
    preselectTo && nextStatuses.includes(preselectTo) ? preselectTo : "";
  // The picker tracks state in URL, but the actual form is server-
  // action driven. We render the loss-reason picker ALWAYS so a user
  // who picks 'lost' from the dropdown sees the required fields
  // without an extra page nav. Native HTML required attr enforces it
  // for the lost case (we mirror server-side validation in the lib).
  return (
    <section className={`bg-white border border-ppp-charcoal-100 rounded-xl p-5 ${className ?? ""}`}>
      <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-ppp-charcoal">Change status</h2>
          <p className="text-[11px] text-ppp-charcoal-500 mt-0.5">
            Currently <strong>{opportunityStatusLabel(opp.status)}</strong>. Pick the next state.
            Lost requires a reason + note.
          </p>
        </div>
      </div>
      {nextStatuses.length === 0 ? (
        <p className="text-[12px] text-ppp-charcoal-500 italic">
          This status has no outbound transitions. Move to <em>reopened</em> first to re-engage.
        </p>
      ) : (
        <form action={changeStatusAction} className="space-y-3">
          <input type="hidden" name="opp_id" value={opp.id} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1">
              <label htmlFor="to_status" className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
                Next status <span className="text-rose-700">*</span>
              </label>
              <select
                id="to_status"
                name="to_status"
                required
                defaultValue={defaultTo}
                className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0 bg-white"
              >
                <option value="" disabled>
                  Pick a status
                </option>
                {nextStatuses.map((s) => (
                  <option key={s} value={s}>
                    {opportunityStatusLabel(s)}
                    {shouldWarnTransition(opp.status, s) ? " (warn)" : ""}
                  </option>
                ))}
              </select>
              {defaultTo && shouldWarnTransition(opp.status, defaultTo) && (
                <p className="text-[11px] text-amber-700 mt-1">
                  Unusual transition — double-check this is intentional.
                </p>
              )}
            </div>
            <div className="sm:col-span-1">
              <label htmlFor="loss_reason" className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
                Loss reason (if lost)
              </label>
              <select
                id="loss_reason"
                name="loss_reason"
                defaultValue=""
                className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0 bg-white"
              >
                <option value="">—</option>
                {OPPORTUNITY_LOSS_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {opportunityLossReasonLabel(r)}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-1">
              <label htmlFor="note" className="block text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500 mb-1">
                Note (required if lost)
              </label>
              <input
                id="note"
                name="note"
                type="text"
                placeholder="One-line context"
                maxLength={500}
                className="w-full px-3 py-2 text-base sm:text-sm border border-ppp-charcoal-100 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600/30 focus:border-emerald-600 min-h-[44px] sm:min-h-0"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-sm font-semibold hover:bg-ppp-charcoal-700 min-h-[44px] touch-manipulation"
            >
              Apply status change
            </button>
          </div>
        </form>
      )}
    </section>
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

function KpiTile({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string;
  tooltip?: string;
}) {
  return (
    <div
      className="border border-ppp-charcoal-100 rounded-lg px-3 py-3 bg-white min-h-[64px] flex flex-col justify-center"
      title={tooltip}
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 flex items-center gap-1">
        {label}
        {tooltip && <span className="text-ppp-charcoal-400 cursor-help" aria-label="More info">ⓘ</span>}
      </div>
      <div className="text-base sm:text-lg font-bold text-ppp-charcoal mt-1 truncate">
        {value}
      </div>
    </div>
  );
}

/** Weighted tooltip — turns the bare $ value into a one-line data
 *  story Alex can quote. "$12.5k = 25% × $50k midpoint" tells him at
 *  a glance whether the weighted number is "confident" or "we're
 *  hedging." */
function weightedTooltip(opp: CommercialOpportunity): string {
  const low = opp.bid_value_low_cents ?? 0;
  const high = opp.bid_value_high_cents ?? 0;
  if (low === 0 && high === 0) return "No bid value set yet.";
  const mid = (low + (high || low)) / 2;
  const midDollars = (mid / 100).toLocaleString(undefined, { maximumFractionDigits: 0 });
  return `${opp.probability_pct}% probability × $${midDollars} midpoint bid.`;
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
