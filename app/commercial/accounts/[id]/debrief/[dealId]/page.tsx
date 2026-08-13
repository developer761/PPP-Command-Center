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
import { revalidatePath } from "next/cache";import Link from "next/link";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/kanban-columns";
import { assertCommercialAccess } from "@/lib/commercial/auth";
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
  PRE_SALE_OPEN_STATUSES,
} from "@/lib/commercial/opportunities/constants";
import { writeDebrief, listDebriefsForOpp } from "@/lib/commercial/win-loss/debrief";
import DebriefFields from "@/components/commercial/debrief-fields";
import { UUID_RE } from "@/lib/commercial/uuid";
import { SubmitButton } from "@/components/commercial/submit-button";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<{
  just_closed?: string;
  debrief_saved?: string;
  error?: string;
  /** `lost` — close this deal as lost, here, instead of ejecting to the
   *  global opportunity shell. See `closeAsLostAction`. */
  close?: string;
  outcome?: string;
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
  await assertCommercialAccess(user.id);
  return user.id;
}

/**
 * Close a deal as Lost or No-bid without leaving the account.
 *
 * Marking a deal lost from the account used to redirect to the global
 * opportunity shell — no account context, so the tab, the scroll position and
 * the deal being worked on were all gone, for the one outcome that is hardest
 * to record in the first place. Won already stayed here; there was no reason
 * Lost shouldn't.
 *
 * It could not simply redirect here, though: this page requires a deal that is
 * ALREADY closed, and the whole point of the old detour was that closing needs
 * a loss reason. So the close happens here too — reason and all, in one step.
 */
async function closeAsLostAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const account_id = String(formData.get("account_id") ?? "");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(account_id) || !UUID_RE.test(opp_id)) redirect("/commercial/accounts");

  const back = `/commercial/accounts/${account_id}/debrief/${opp_id}?close=lost`;
  const reason = String(formData.get("loss_reason") ?? "").trim() as OpportunityLossReason;
  if (!OPPORTUNITY_LOSS_REASONS.includes(reason)) {
    redirect(`${back}&error=${encodeURIComponent("Pick a reason so the win/loss report can use it.")}`);
  }
  const note = String(formData.get("loss_notes") ?? "").trim();
  if (!note) {
    redirect(`${back}&error=${encodeURIComponent("Add a sentence on what happened — it's the part that's useful later.")}`);
  }

  const opp = await getCommercialOpportunity(opp_id);
  if (!opp || opp.account_id !== account_id) redirect(`/commercial/accounts/${account_id}?tab=deals`);
  // Already closed by someone else while this form was open — fall through to
  // the debrief rather than closing it twice.
  if (opp.status === "pre_sale_closed") {
    redirect(`/commercial/accounts/${account_id}/debrief/${opp_id}?just_closed=1`);
  }

  const { changeOpportunityStatus } = await import("@/lib/commercial/opportunities/status");
  const result = await changeOpportunityStatus({
    opp_id,
    to_status: "pre_sale_closed",
    to_sub_status: "lost",
    acting_user_id: userId,
    loss_reason: reason,
    note,
  });
  if (!result.ok) redirect(`${back}&error=${encodeURIComponent(result.error)}`);

  const { postPlaceholderAutoNote } = await import("@/lib/commercial/win-loss/debrief");
  await postPlaceholderAutoNote({
    opportunityId: opp_id,
    outcome: reason === "no_bid" ? "no_bid" : "lost",
    actorUserId: userId,
  });
  revalidatePath(`/commercial/accounts/${account_id}`);
  redirect(`/commercial/accounts/${account_id}/debrief/${opp_id}?just_closed=1`);
}

async function startProjectAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const account_id = String(formData.get("account_id") ?? "");
  const opp_id = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(account_id) || !UUID_RE.test(opp_id)) {
    redirect("/commercial/accounts");
  }
  const opp = await getCommercialOpportunity(opp_id);
  if (!opp || opp.account_id !== account_id) {
    redirect(`/commercial/accounts/${account_id}?tab=deals`);
  }
  // Belt-and-braces: only Won deals can start a project. The button
  // itself already gates this — but a stale form POST could otherwise
  // slip through and quietly re-fire the transition.
  if (opp.status !== "pre_sale_closed" || opp.sub_status !== "won") {
    redirect(
      `/commercial/accounts/${account_id}/debrief/${opp_id}?error=` +
        encodeURIComponent(
          "Only Won deals can Start Project. Refresh — this deal isn't Won anymore."
        )
    );
  }
  const { changeOpportunityStatus } = await import(
    "@/lib/commercial/opportunities/status"
  );
  const result = await changeOpportunityStatus({
    opp_id,
    to_status: "pre_construction",
    to_sub_status: "coordination",
    acting_user_id: userId,
    note: "Started project — Won deal handed off to delivery.",
  });
  if (!result.ok) {
    redirect(
      `/commercial/accounts/${account_id}/debrief/${opp_id}?error=` +
        encodeURIComponent(result.error)
    );
  }
  redirect(
    `/commercial/opportunities/${opp_id}?project_started=1`
  );
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
    redirect(`/commercial/accounts/${account_id}?tab=deals`);
  }
  // Only pre-sale bid outcomes are debriefable (see the page-level gate).
  if (opp.status !== "pre_sale_closed") {
    redirect(`/commercial/accounts/${account_id}?tab=deals`);
  }
  // Outcome from the v2 (status, sub_status, loss_reason) tuple. Gated above to
  // pre_sale_closed, so the sub_status branches are exhaustive; the final
  // redirect covers a malformed tuple (e.g. sub_status neither won nor lost).
  let outcome: "won" | "lost" | "no_bid";
  if (opp.sub_status === "won") outcome = "won";
  else if (opp.sub_status === "lost" && opp.loss_reason === "no_bid") outcome = "no_bid";
  else if (opp.sub_status === "lost") outcome = "lost";
  else redirect(`/commercial/accounts/${account_id}?tab=deals`);

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
  // A won deal stays on this page: Start Project is right here, and redirecting
  // away the instant the debrief saved dropped the user out exactly when the
  // next step became available. A loss has no next step, so it returns to the
  // deal as before.
  if (outcome === "won") {
    redirect(`/commercial/accounts/${account_id}/debrief/${opp_id}?debrief_saved=1`);
  }
  redirect(
    `/commercial/opportunities/${opp_id}`
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

  // Win/Loss debrief is for the BID decision (pre-sale won / lost / no-bid)
  // only. Karan 2026-07-27 audit: isTerminalOpportunityStatus also matched
  // post_sale_closed (delivered work), which has no bid outcome — the form
  // then mislabeled it "No-bid" and submitDebriefAction had no branch, so the
  // save silently no-op'd. Gate strictly to pre_sale_closed.
  // A deal still being sold reaches this page for exactly one reason: it is
  // being closed as lost, here, rather than out in the global opportunity
  // shell. Anything else still bounces.
  const closingAsLost =
    sp.close === "lost" && PRE_SALE_OPEN_STATUSES.includes(opp.status);
  if (opp.status !== "pre_sale_closed" && !closingAsLost) {
    redirect(`/commercial/accounts/${id}?tab=deals`);
  }

  if (closingAsLost) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        <Link
          href={`/commercial/opportunities/${dealId}`}
          className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ppp-charcoal-600 hover:text-cc-brand-700 min-h-[44px]"
        >
          <span aria-hidden>←</span> Back to the deal
        </Link>
        <div>
          <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">
            Close as lost
          </h1>
          <p className="text-[13px] text-ppp-charcoal-500 mt-1.5 leading-relaxed">
            {opp.title || "(untitled deal)"} — {account.company_name}. Both fields feed the win/loss
            report, which is the only place this ends up being useful.
          </p>
        </div>
        {sp.error && (
          <div className="rounded-lg px-4 py-3 text-sm bg-rose-50 border border-rose-200 text-rose-700">
            {sp.error}
          </div>
        )}
        <form
          action={closeAsLostAction}
          className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5 space-y-4"
        >
          <input type="hidden" name="account_id" value={id} />
          <input type="hidden" name="opp_id" value={dealId} />
          <div>
            <label
              htmlFor="loss_reason"
              className="block text-[12px] font-bold uppercase tracking-wider text-ppp-charcoal-600 mb-1.5"
            >
              Why did we lose it?
            </label>
            <select
              id="loss_reason"
              name="loss_reason"
              required
              defaultValue=""
              className="w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-3 py-2 text-sm text-ppp-charcoal min-h-[44px]"
            >
              <option value="" disabled>
                Pick one…
              </option>
              {OPPORTUNITY_LOSS_REASONS.map((r) => (
                <option key={r} value={r}>
                  {opportunityLossReasonLabel(r)}
                </option>
              ))}
            </select>
            <p className="text-[11.5px] text-ppp-charcoal-500 mt-1">
              Choose <strong>No bid</strong> if we never quoted it — those are kept out of
              the win rate.
            </p>
          </div>
          <div>
            <label
              htmlFor="loss_notes"
              className="block text-[12px] font-bold uppercase tracking-wider text-ppp-charcoal-600 mb-1.5"
            >
              What happened?
            </label>
            <textarea
              id="loss_notes"
              name="loss_notes"
              required
              rows={3}
              placeholder="Came in 12% over the winning bid; GC went with an incumbent they'd used on two prior phases."
              className="w-full rounded-lg border border-ppp-charcoal-200 bg-surface px-3 py-2 text-sm text-ppp-charcoal"
            />
          </div>
          <div className="flex items-center justify-end gap-2">
            <Link
              href={`/commercial/opportunities/${dealId}`}
              className="inline-flex items-center px-3 py-2 rounded-lg text-[13px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[44px]"
            >
              Cancel
            </Link>
            <SubmitButton
              className="inline-flex items-center px-4 py-2 rounded-lg bg-ppp-charcoal text-white text-[13px] font-semibold hover:bg-ppp-charcoal-800 min-h-[44px]"
            >
              Close as lost
            </SubmitButton>
          </div>
        </form>
      </div>
    );
  }

  const debriefs = await listDebriefsForOpp(dealId);
  const latestDebrief = debriefs[0] ?? null;
  const isDebriefed = Boolean(opp.win_loss_debriefed_at) && latestDebrief !== null;
  const outcomeLabel = isWon(opp) ? "Win" : isLost(opp) ? "Loss" : "No-bid";
  const justClosed = sp.just_closed === "1";
  const error = sp.error;

  // Back reopens the deal DRAWER (where the user came from) rather than the
  // bare list, which scrolled to the top of the account (2026-07-28 nav sweep —
  // same fix already on the sibling Change Orders page).
  const backHref = `/commercial/opportunities/${dealId}`;

  return (
    <div className="min-h-screen bg-ppp-charcoal-50">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        {/* Breadcrumb / back link */}
        <div className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500">
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 hover:text-cc-brand-700 min-h-[44px] sm:min-h-[32px]"
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
        <header className="bg-surface border border-ppp-charcoal-100 rounded-xl p-5 shadow-sm">
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
        {/* A won deal now STAYS here after saving, so Start Project is right
            below — but nothing confirmed the save had happened. */}
        {sp.debrief_saved === "1" && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-800">
            <strong>Debrief saved.</strong>{" "}
            {isWon(opp)
              ? "Start the project below when the crew is ready."
              : "It feeds the Win/Loss report."}
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

        {/* Phase E-6: Start Project handoff. Only surfaced once the debrief
            is filed on a Won deal that's still at pre_sale_closed. This is
            Katie's celebrated Won → delivery moment — the deal hops the
            Pre-Sale / Post-Sale lane divider here. */}
        {/* NOT gated on the debrief. This is the only control that moves a won
            deal into delivery, and it used to require a debrief that the app
            itself presents as optional — so the normal path was: win, skip the
            debrief, land on a panel whose only guidance was the sentence "Move
            it to Pre-Construction", with no button anywhere. */}
        {isWon(opp) && opp.status === "pre_sale_closed" && (
          <StartProjectCard accountId={id} oppId={dealId} />
        )}

        {/* Legacy loss reason (pre-debrief data) */}
        {!isDebriefed && opp.loss_reason && (
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
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
    <section className="relative bg-surface border border-ppp-charcoal-100 rounded-xl p-5 shadow-sm">
      <span aria-hidden className="absolute left-0 top-0 bottom-0 w-[3px] bg-cc-brand-600 rounded-l-xl" />
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
          <SubmitButton
            className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors shadow-sm shadow-cc-brand-600/30 min-h-[44px] touch-manipulation"
          >
            Save debrief
          </SubmitButton>
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
    <section className="relative bg-surface border border-ppp-charcoal-100 rounded-xl p-5 shadow-sm">
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

/** Phase E-6 signature moment — Won → Pre-Construction handoff.
 *  The deal has been Won AND debriefed; PPP is ready to actually deliver.
 *  Renders emerald so the eye lands on it after the read-only debrief. */
function StartProjectCard({
  accountId,
  oppId,
}: {
  accountId: string;
  oppId: string;
}) {
  return (
    <section className="relative bg-gradient-to-br from-emerald-50 to-surface border border-emerald-200 rounded-xl p-5 shadow-sm overflow-hidden">
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-[3px] bg-emerald-500"
      />
      <div className="flex items-start gap-3 mb-3">
        <div
          className="shrink-0 w-9 h-9 rounded-lg bg-emerald-100 border border-emerald-200 flex items-center justify-center"
          aria-hidden
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-emerald-700"
          >
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-bold text-ppp-charcoal leading-tight">
            Ready to start the project?
          </h2>
          <p className="text-[12.5px] text-ppp-charcoal-600 mt-1 leading-relaxed">
            Hand this off to the delivery team. Next stop: Pre-Construction.
            Your debrief stays here on file.
          </p>
        </div>
      </div>
      <form action={startProjectAction} className="flex justify-end">
        <input type="hidden" name="account_id" value={accountId} />
        <input type="hidden" name="opp_id" value={oppId} />
        <SubmitButton
          className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-600 active:bg-emerald-800 transition-colors shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          Start project
        </SubmitButton>
      </form>
    </section>
  );
}
