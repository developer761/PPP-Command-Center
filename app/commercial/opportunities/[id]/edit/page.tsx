import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  OPPORTUNITY_SOURCES,
  opportunityStatusLabel,
  opportunitySourceLabel,
  getCommercialOpportunity,
  type OpportunitySource,
} from "@/lib/commercial/opportunities/db";
import { updateCommercialOpportunity } from "@/lib/commercial/opportunities/mutations";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, TEXTAREA_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

export const dynamic = "force-dynamic";

type PP = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

/**
 * Edit opportunity page — mirrors the account edit pattern + new-opp
 * form shape. Pre-fills every field from the existing opp; on submit
 * runs updateCommercialOpportunity which patches only changed columns.
 *
 * Out of scope (use other surfaces):
 *   - Status changes → ChangeStatusCard on the detail Info tab
 *     (enforces the DAG + captures loss_reason + writes status_log)
 *   - Soft-delete → "Delete opportunity" two-step on the detail Info tab
 *   - Team / Tasks / Notes / Plans & Specs → respective tabs
 *
 * Bid values get dollar-string parsing (commas/$ stripped) symmetric
 * with the new-opp form so "$50,000" / "50000" / "50,000.50" all work.
 */

async function updateAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) redirect("/commercial/opportunities");

  const title = String(formData.get("title") ?? "").trim();
  if (!title) {
    redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent("Title is required.")}`);
  }

  // Status is intentionally NOT editable from this form — that path
  // bypassed the DAG + loss-reason capture + status_log entry + decided_at
  // timestamp. All status changes route through ChangeStatusCard on the
  // Info tab. See lib/commercial/opportunities/status.changeOpportunityStatus.
  const sourceRaw = String(formData.get("source") ?? "");
  if (sourceRaw && !(OPPORTUNITY_SOURCES as readonly string[]).includes(sourceRaw)) {
    redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent("Invalid source.")}`);
  }

  // Dollar-string parser — same as new-opp.
  const parseDollars = (raw: string): number | null | "invalid" => {
    const cleaned = raw.trim().replace(/[$,\s]/g, "");
    if (cleaned === "") return null;
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return "invalid";
    const n = parseFloat(cleaned);
    if (!Number.isFinite(n) || n < 0) return "invalid";
    return Math.round(n * 100);
  };
  const lowParsed = parseDollars(String(formData.get("bid_low") ?? ""));
  const highParsed = parseDollars(String(formData.get("bid_high") ?? ""));
  if (lowParsed === "invalid") {
    redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent("Bid low must be a non-negative dollar amount.")}`);
  }
  if (highParsed === "invalid") {
    redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent("Bid high must be a non-negative dollar amount.")}`);
  }

  const probabilityRaw = String(formData.get("probability_pct") ?? "").trim();
  let probability: number | null | undefined = undefined;
  if (probabilityRaw !== "") {
    const n = Number(probabilityRaw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent("Probability must be a number 0-100.")}`);
    }
    probability = Math.round(n);
  }

  const result = await updateCommercialOpportunity({
    id,
    title,
    description: (formData.get("description") as string)?.trim() || null,
    // status intentionally omitted — see comment above.
    source: sourceRaw ? (sourceRaw as OpportunitySource) : null,
    bid_value_low_cents: lowParsed as number | null,
    bid_value_high_cents: highParsed as number | null,
    probability_pct: probability,
    proposal_due_at: (formData.get("proposal_due_at") as string) || null,
    proposed_start_at: (formData.get("proposed_start_at") as string) || null,
    proposed_end_at: (formData.get("proposed_end_at") as string) || null,
    property_street: (formData.get("property_street") as string) ?? null,
    property_city: (formData.get("property_city") as string) ?? null,
    property_state: (formData.get("property_state") as string) ?? null,
    property_zip: (formData.get("property_zip") as string) ?? null,
    updated_by_user_id: user.id,
  });

  if (!result.ok) {
    redirect(`/commercial/opportunities/${id}/edit?error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/commercial/opportunities/${id}?edited=1`);
}

export default async function EditOpportunityPage({
  params,
  searchParams,
}: {
  params: PP;
  searchParams: SP;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const sp = await searchParams;
  const errorMessage = pickFirst(sp.error);

  const opp = await getCommercialOpportunity(id);
  if (!opp) notFound();

  // Dollar display helpers — opp stores cents, form shows dollars.
  const centsToDollars = (cents: number | null | undefined): string => {
    if (cents === null || cents === undefined) return "";
    return (cents / 100).toFixed(2).replace(/\.00$/, "");
  };

  return (
    <div className="space-y-5 max-w-3xl">
      <header>
        <Link
          href={`/commercial/opportunities/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-emerald-700 hover:text-emerald-800"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M19 12H5 M12 19l-7-7 7-7" />
          </svg>
          Back to opportunity
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal mt-2 truncate">
          Edit: {opp.title}
        </h1>
        <p className="text-sm text-ppp-charcoal-500 mt-1">
          Change status from the Info tab so the DAG + status log run correctly. This form only edits the standing fields.
        </p>
      </header>

      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <form action={updateAction} className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 space-y-4">
        <input type="hidden" name="id" value={id} />

        <div>
          <label htmlFor="title" className={LABEL_CLS}>
            Title <span className="text-rose-700">*</span>
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            maxLength={200}
            defaultValue={opp.title}
            className={INPUT_CLS}
          />
        </div>

        {/* Status is intentionally NOT in this form — it routes through
            the Info tab's Change Status card so the DAG, loss_reason
            capture, decided_at timestamp, and status_log entry all
            run correctly. Showing the current status as a read-only
            chip so the user sees context without a misleading editable
            field. */}
        <div className="rounded-xl border border-ppp-charcoal-100 bg-ppp-charcoal-50/40 px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-[12px] text-ppp-charcoal-600">
            Current status: <strong className="text-ppp-charcoal">{opportunityStatusLabel(opp.status)}</strong>
          </span>
          <Link
            href={`/commercial/opportunities/${id}#info`}
            className="text-[12px] font-semibold text-emerald-700 hover:text-emerald-800 underline"
          >
            Change status →
          </Link>
        </div>

        <div>
          <label htmlFor="source" className={LABEL_CLS}>
            How did this come in?
          </label>
          <select
            id="source"
            name="source"
            defaultValue={opp.source ?? ""}
            className={SELECT_CLS}
            style={SELECT_BG_STYLE}
          >
            <option value="">Pick a source…</option>
            {OPPORTUNITY_SOURCES.map((s) => (
              <option key={s} value={s}>
                {opportunitySourceLabel(s)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="bid_low" className={LABEL_CLS}>
              Bid low ($)
            </label>
            <input
              id="bid_low"
              name="bid_low"
              type="text"
              inputMode="decimal"
              defaultValue={centsToDollars(opp.bid_value_low_cents)}
              placeholder="e.g. 25000"
              className={INPUT_CLS}
            />
          </div>
          <div>
            <label htmlFor="bid_high" className={LABEL_CLS}>
              Bid high ($)
            </label>
            <input
              id="bid_high"
              name="bid_high"
              type="text"
              inputMode="decimal"
              defaultValue={centsToDollars(opp.bid_value_high_cents)}
              placeholder="e.g. 35000"
              className={INPUT_CLS}
            />
          </div>
          <div>
            <label htmlFor="probability_pct" className={LABEL_CLS}>
              Probability (%)
            </label>
            <input
              id="probability_pct"
              name="probability_pct"
              type="number"
              inputMode="numeric"
              min="0"
              max="100"
              step="5"
              defaultValue={opp.probability_pct ?? ""}
              className={INPUT_CLS}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="proposal_due_at" className={LABEL_CLS}>
              Proposal due
            </label>
            <input
              id="proposal_due_at"
              name="proposal_due_at"
              type="date"
              defaultValue={opp.proposal_due_at?.slice(0, 10) ?? ""}
              className={INPUT_CLS}
            />
          </div>
          <div>
            <label htmlFor="proposed_start_at" className={LABEL_CLS}>
              Proposed start
            </label>
            <input
              id="proposed_start_at"
              name="proposed_start_at"
              type="date"
              defaultValue={opp.proposed_start_at?.slice(0, 10) ?? ""}
              className={INPUT_CLS}
            />
          </div>
          <div>
            <label htmlFor="proposed_end_at" className={LABEL_CLS}>
              Proposed end
            </label>
            <input
              id="proposed_end_at"
              name="proposed_end_at"
              type="date"
              defaultValue={opp.proposed_end_at?.slice(0, 10) ?? ""}
              className={INPUT_CLS}
            />
          </div>
        </div>

        {/* Property / project address — mirrors the new-opp card. Clearing
            every field restores the account fallback on the detail page. */}
        <div className="space-y-3 rounded-xl border border-ppp-charcoal-100 bg-ppp-charcoal-50/40 p-3 sm:p-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500">
              Property / project address
            </h3>
            <span className="text-[11px] text-ppp-charcoal-500">
              Clear all four to use the account&apos;s site address
            </span>
          </div>
          <div>
            <label htmlFor="property_street" className={LABEL_CLS}>
              Street
            </label>
            <input
              id="property_street"
              name="property_street"
              type="text"
              defaultValue={opp.property_street ?? ""}
              placeholder="e.g. 456 Park Ave"
              autoComplete="off"
              className={INPUT_CLS}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="property_city" className={LABEL_CLS}>
                City
              </label>
              <input
                id="property_city"
                name="property_city"
                type="text"
                defaultValue={opp.property_city ?? ""}
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label htmlFor="property_state" className={LABEL_CLS}>
                State
              </label>
              <input
                id="property_state"
                name="property_state"
                type="text"
                maxLength={2}
                defaultValue={opp.property_state ?? ""}
                placeholder="NY"
                className={`${INPUT_CLS} uppercase`}
              />
            </div>
            <div>
              <label htmlFor="property_zip" className={LABEL_CLS}>
                ZIP
              </label>
              <input
                id="property_zip"
                name="property_zip"
                type="text"
                maxLength={10}
                defaultValue={opp.property_zip ?? ""}
                className={INPUT_CLS}
              />
            </div>
          </div>
        </div>

        <div>
          <label htmlFor="description" className={LABEL_CLS}>
            Description / scope summary
          </label>
          <textarea
            id="description"
            name="description"
            rows={4}
            defaultValue={opp.description ?? ""}
            placeholder="Optional. Quick scope notes — full RFP attaches in Plans & Specs."
            className={TEXTAREA_CLS}
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3 pt-2">
          <Link
            href={`/commercial/opportunities/${id}`}
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-100 text-sm font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
          >
            Cancel
          </Link>
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 shadow-sm shadow-cc-brand-600/30 min-h-[44px] touch-manipulation"
          >
            Save changes
          </button>
        </div>
      </form>
    </div>
  );
}
