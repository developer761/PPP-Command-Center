/**
 * Win / Loss debrief page — nested under the account so the deal's
 * detail flow stays inside the account context. Karan 2026-07-13:
 * "everything should be under the acocunt page". After a Won drop
 * lands, the user is redirected here (not to /commercial/opportunities
 * /[id]?tab=debrief) so they can log the debrief without leaving
 * the account.
 *
 * Two states:
 *   1. Debrief already on file → read-only summary.
 *   2. Debrief pending → the same DebriefFormCard used on opps/[id].
 *
 * The submit action is scoped to this URL so the redirect after save
 * loops back to the account (?debrief_saved=1 toast).
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import {
  getCommercialOpportunity,
  opportunityLossReasonLabel,
  OPPORTUNITY_LOSS_REASONS,
  type CommercialOpportunity,
  type OpportunityLossReason,
} from "@/lib/commercial/opportunities/db";
import {
  isWon,
  isLost,
  oppStatusDisplayLabel,
} from "@/lib/commercial/opportunities/constants";
import { isTerminalOpportunityStatus } from "@/lib/commercial/opportunities/constants";
import { writeDebrief, listDebriefsForOpp } from "@/lib/commercial/win-loss/debrief";
import DebriefFields from "@/components/commercial/debrief-fields";
import { UUID_RE } from "@/lib/commercial/uuid";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<{
  just_closed?: string;
  debrief_saved?: string;
  error?: string;
}>;

async function requireCommercialUser(): Promise<string> {
  // The /commercial layout already gates on has_new_platform_access using
  // the cached service-role profile fetch. Repeating that check here just
  // needs to grab the auth user; if the layout let us through, we're in.
  // (Karan 2026-07-13: an earlier version used the auth-scoped client to
  // re-check the profile row — RLS timing sometimes made that lookup miss
  // and bounced the user to `/`, which surfaced as "the redirect is broken".)
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  return user.id;
}

async function submitDebriefAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const account_id = String(formData.get("account_id") ?? "");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(account_id) || !UUID_RE.test(opp_id)) {
    redirect("/commercial/accounts");
  }
  const opp = await getCommercialOpportunity(opp_id);
  if (!opp || opp.account_id !== account_id) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities`);
  }
  if (!isTerminalOpportunityStatus(opp.status)) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities`);
  }
  // Legacy outcome derivation from v2 tuple.
  let outcome: "won" | "lost" | "no_bid";
  if (opp.status === "pre_sale_closed" && opp.sub_status === "won") outcome = "won";
  else if (opp.status === "pre_sale_closed" && opp.sub_status === "lost" && opp.loss_reason === "no_bid") outcome = "no_bid";
  else if (opp.status === "pre_sale_closed" && opp.sub_status === "lost") outcome = "lost";
  else if (opp.status === "won") outcome = "won";
  else if (opp.status === "lost") outcome = "lost";
  else redirect(`/commercial/accounts/${account_id}?tab=opportunities`);

  const competitor = String(formData.get("debrief_competitor") ?? "").trim();
  const decidingFactor = String(formData.get("debrief_deciding_factor") ?? "").trim();
  const lessons = String(formData.get("debrief_lessons") ?? "").trim();
  const internalNotes = String(formData.get("debrief_internal_notes") ?? "").trim();

  // Link the debrief to the most-recent terminal status_log entry.
  const sb = commercialDb();
  const { data: lastLog } = await sb
    .from("commercial_opportunity_status_log")
    .select("id")
    .eq("opportunity_id", opp_id)
    .eq("to_status", opp.status)
    .order("changed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const statusLogId = (lastLog as { id: string } | null)?.id ?? null;

  const result = await writeDebrief({
    opportunityId: opp_id,
    outcome,
    competitorName: competitor || null,
    decidingFactor:
      decidingFactor && (OPPORTUNITY_LOSS_REASONS as readonly string[]).includes(decidingFactor)
        ? decidingFactor
        : null,
    lessonsLearned: lessons || null,
    internalNotes: internalNotes || null,
    statusLogId,
    actorUserId: userId,
  });
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${account_id}/debrief/${opp_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(
    `/commercial/accounts/${account_id}?tab=opportunities&edit=${opp_id}#deal-row-${opp_id}`
  );
}

export default async function AccountDebriefPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  await requireCommercialUser();
  const { id, dealId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();
  const sp = await searchParams;

  const [account, opp] = await Promise.all([
    getCommercialAccount(id),
    getCommercialOpportunity(dealId),
  ]);
  if (!account) notFound();
  if (!opp || opp.account_id !== id) notFound();

  const isTerminal = isTerminalOpportunityStatus(opp.status);
  // Not terminal → user landed here by mistake; kick them back.
  if (!isTerminal) {
    redirect(`/commercial/accounts/${id}?tab=opportunities`);
  }

  const debriefs = await listDebriefsForOpp(dealId);
  const latestDebrief = debriefs[0] ?? null;
  const isDebriefed = Boolean(opp.win_loss_debriefed_at) && latestDebrief !== null;
  const outcomeLabel = isWon(opp) ? "Win" : isLost(opp) ? "Loss" : "No-bid";
  const justClosed = sp.just_closed === "1";
  const error = sp.error;

  const backHref = `/commercial/accounts/${id}?tab=opportunities`;

  return (
    <div className="min-h-screen bg-ppp-charcoal-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        {/* Breadcrumb / back link */}
        <div className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 hover:text-cc-brand-700 min-h-[32px]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M19 12H5" />
              <path d="m12 19-7-7 7-7" />
            </svg>
            <span>{account.company_name}</span>
          </Link>
          <span aria-hidden className="text-ppp-charcoal-300">·</span>
          <span className="text-ppp-charcoal-700 truncate">
            {opp.title || "(untitled)"}
          </span>
        </div>

        {/* Header */}
        <header className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 shadow-sm">
          <div className="flex items-start gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-bold uppercase tracking-widest text-cc-brand-700 mb-1.5">
                {outcomeLabel} debrief
              </div>
              <h1 className="text-xl font-bold text-ppp-charcoal leading-tight tracking-tight">
                {opp.title || "(untitled deal)"}
              </h1>
              <div className="mt-1 text-[13px] text-ppp-charcoal-500">
                {account.company_name}
              </div>
            </div>
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold border shrink-0 ${
                isWon(opp)
                  ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                  : "bg-rose-50 text-rose-800 border-rose-200"
              }`}
            >
              {oppStatusDisplayLabel(opp.status, opp.sub_status)}
            </span>
          </div>
        </header>

        {/* Banners */}
        {error && (
          <div
            role="alert"
            aria-live="polite"
            className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-800 flex items-start gap-2"
          >
            <span aria-hidden className="mt-0.5">⚠</span>
            <span>{error}</span>
          </div>
        )}
        {justClosed && !isDebriefed && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-800">
            Deal saved as{" "}
            <strong>{oppStatusDisplayLabel(opp.status, opp.sub_status)}</strong>.
            Capture the {outcomeLabel.toLowerCase()} debrief below to feed the
            quarterly Win/Loss report — or come back later via the deal row on
            the account page.
          </div>
        )}

        {/* Body */}
        {isDebriefed && latestDebrief ? (
          <DebriefReadOnlyView
            opp={opp}
            debrief={latestDebrief}
            debriefCount={debriefs.length}
          />
        ) : (
          <DebriefFormCard opp={opp} accountId={id} />
        )}

        {/* Legacy loss reason (pre-debrief data) */}
        {!isDebriefed && opp.loss_reason && (
          <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ppp-charcoal-500">
              Legacy loss reason (pre-debrief)
            </div>
            <p className="text-sm text-ppp-charcoal-700 mt-1">
              {opportunityLossReasonLabel(opp.loss_reason)}
            </p>
            {opp.loss_notes && (
              <p className="mt-2 text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">
                {opp.loss_notes}
              </p>
            )}
          </div>
        )}

        {/* Footer link back */}
        <div className="pt-2">
          <Link
            href={backHref}
            className="text-[12px] text-ppp-charcoal-500 hover:text-ppp-charcoal underline"
          >
            ← Back to {account.company_name}
          </Link>
        </div>
      </div>
    </div>
  );
}

function DebriefFormCard({
  opp,
  accountId,
}: {
  opp: CommercialOpportunity;
  accountId: string;
}) {
  const outcomeLabel = isWon(opp) ? "Win" : isLost(opp) ? "Loss" : "No-bid";
  const subhead = isWon(opp)
    ? "Two quick fields — who you beat and what tipped it your way. Feeds the quarterly Win/Loss report."
    : isLost(opp)
    ? "Two quick fields — who won and why. Feeds the quarterly Win/Loss report."
    : "Two quick fields — who took it and why you passed. Feeds the quarterly Win/Loss report.";
  return (
    <section className="relative bg-white border border-ppp-charcoal-100 rounded-xl p-5 shadow-sm overflow-hidden">
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px] bg-cc-brand-600" />
      <div className="flex items-start gap-3 mb-4">
        <div className="shrink-0 w-9 h-9 rounded-lg bg-cc-brand-50 border border-cc-brand-100 flex items-center justify-center" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cc-brand-700">
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-ppp-charcoal leading-tight">
            {outcomeLabel} debrief
          </h2>
          <p className="text-[12.5px] text-ppp-charcoal-500 mt-1 leading-relaxed">
            {subhead}
          </p>
        </div>
      </div>
      <form action={submitDebriefAction} className="space-y-3">
        <input type="hidden" name="account_id" value={accountId} />
        <input type="hidden" name="opp_id" value={opp.id} />
        <DebriefFields
          initialStatus={opp.status}
          initialSubStatus={opp.sub_status ?? undefined}
        />
        <div className="flex justify-end pt-3 border-t border-ppp-charcoal-100 mt-4">
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors shadow-sm shadow-cc-brand-600/30 min-h-[44px] touch-manipulation"
          >
            Save debrief
          </button>
        </div>
      </form>
    </section>
  );
}

function DebriefReadOnlyView({
  opp,
  debrief,
  debriefCount,
}: {
  opp: CommercialOpportunity;
  debrief: {
    competitor_name: string | null;
    deciding_factor: string | null;
    lessons_learned: string | null;
    internal_notes: string | null;
    debriefed_at: string;
  };
  debriefCount: number;
}) {
  return (
    <section className="relative bg-white border border-ppp-charcoal-100 rounded-xl p-5 shadow-sm overflow-hidden">
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px] bg-emerald-500" />
      <div className="flex items-start gap-3 mb-4">
        <div className="shrink-0 w-9 h-9 rounded-lg bg-emerald-50 border border-emerald-100 flex items-center justify-center" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-700">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-ppp-charcoal leading-tight">
            {isWon(opp) ? "Win" : isLost(opp) ? "Loss" : "No-bid"} debrief on file
          </h2>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1">
            Recorded{" "}
            {new Date(debrief.debriefed_at).toLocaleDateString("en-US", {
              dateStyle: "medium",
              timeZone: "America/New_York",
            })}
            {debriefCount > 1 &&
              ` · ${debriefCount} debriefs on file (this is the most recent)`}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <ReadonlyField
          label={isWon(opp) ? "Beat" : isLost(opp) ? "Lost to" : "Competitor"}
          value={debrief.competitor_name ?? "—"}
        />
        <ReadonlyField
          label={isWon(opp) ? "What sealed it" : "Deciding factor"}
          value={
            debrief.deciding_factor
              ? opportunityLossReasonLabel(
                  debrief.deciding_factor as OpportunityLossReason
                )
              : "—"
          }
        />
      </div>
      {debrief.lessons_learned && (
        <div className="mt-4">
          <div className="text-[12px] font-semibold text-ppp-charcoal-700 mb-1">
            {isWon(opp) ? "What worked" : "What we'd do differently"}
          </div>
          <p className="text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">
            {debrief.lessons_learned}
          </p>
        </div>
      )}
      {debrief.internal_notes && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[12px] font-medium text-ppp-charcoal-500 hover:text-ppp-charcoal select-none">
            Internal notes
          </summary>
          <p className="mt-2 text-sm text-ppp-charcoal-700 whitespace-pre-wrap leading-relaxed">
            {debrief.internal_notes}
          </p>
        </details>
      )}
    </section>
  );
}

function ReadonlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ppp-charcoal-500 mb-0.5">
        {label}
      </div>
      <div className="text-sm text-ppp-charcoal-800">{value}</div>
    </div>
  );
}
