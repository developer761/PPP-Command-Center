import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_SOURCES,
  opportunityStatusLabel,
  opportunitySourceLabel,
  type OpportunityStatus,
  type OpportunitySource,
} from "@/lib/commercial/opportunities/db";
import { createCommercialOpportunity } from "@/lib/commercial/opportunities/mutations";
import { listCommercialAccounts } from "@/lib/commercial/accounts/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { pickFirst } from "@/lib/commercial/form-utils";
import { SELECT_CLS, SELECT_BG_STYLE, INPUT_CLS, TEXTAREA_CLS, LABEL_CLS } from "@/lib/commercial/form-classnames";

export const dynamic = "force-dynamic";

type SP = Promise<Record<string, string | string[] | undefined>>;

async function createAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");

  const account_id = String(formData.get("account_id") ?? "");
  if (!UUID_RE.test(account_id)) {
    redirect("/commercial/opportunities/new?error=" + encodeURIComponent("Pick an account."));
  }
  const title = String(formData.get("title") ?? "").trim();
  if (!title) {
    redirect("/commercial/opportunities/new?error=" + encodeURIComponent("Title is required."));
  }

  const statusRaw = String(formData.get("status") ?? "inquiry");
  if (statusRaw && !(OPPORTUNITY_STATUSES as readonly string[]).includes(statusRaw)) {
    redirect("/commercial/opportunities/new?error=" + encodeURIComponent("Invalid status."));
  }
  const status = (statusRaw || "inquiry") as OpportunityStatus;
  const sourceRaw = String(formData.get("source") ?? "");
  if (sourceRaw && !(OPPORTUNITY_SOURCES as readonly string[]).includes(sourceRaw)) {
    redirect("/commercial/opportunities/new?error=" + encodeURIComponent("Invalid source."));
  }
  const source = sourceRaw ? (sourceRaw as OpportunitySource) : null;

  // Bid parsing — strip commas + $ + whitespace so "$50,000" / "50,000" /
  // "50000.00" all parse correctly. parseFloat alone truncates at the
  // first comma (turning "999,999" into 999 silently).
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
    redirect("/commercial/opportunities/new?error=" + encodeURIComponent("Bid low must be a non-negative dollar amount."));
  }
  if (highParsed === "invalid") {
    redirect("/commercial/opportunities/new?error=" + encodeURIComponent("Bid high must be a non-negative dollar amount."));
  }
  const bid_value_low_cents = lowParsed as number | null;
  const bid_value_high_cents = highParsed as number | null;

  const proposal_due_at = (formData.get("proposal_due_at") as string) || null;
  const description = (formData.get("description") as string)?.trim() || null;
  // Per-opp project address (migration 035). Trimmed-empty → null so the
  // detail page falls back to the account site/billing address.
  const property_street = (formData.get("property_street") as string)?.trim() || null;
  const property_city = (formData.get("property_city") as string)?.trim() || null;
  const property_state = (formData.get("property_state") as string)?.trim().slice(0, 2).toUpperCase() || null;
  const property_zip = (formData.get("property_zip") as string)?.trim() || null;
  // If the user landed here from an Account's Opportunities tab via the
  // `?account=<uuid>` deep link, return them to that tab after create.
  // Otherwise default to the global pipeline. Hidden input passes the
  // origin context through the form submission.
  const returnTo = String(formData.get("return_to") ?? "").trim();

  const result = await createCommercialOpportunity({
    account_id,
    title,
    status,
    source,
    bid_value_low_cents,
    bid_value_high_cents,
    proposal_due_at,
    description,
    property_street,
    property_city,
    property_state,
    property_zip,
    created_by_user_id: user.id,
  });
  if (!result.ok) {
    redirect("/commercial/opportunities/new?error=" + encodeURIComponent(result.error));
  }
  // Include the new opp's title in the redirect so the success banner
  // can echo "Sunridge Apartments bid logged" instead of the generic
  // "Opportunity created." Karan UX audit 2026-06-24: context-rich
  // success messages help Alex keep track of which deal he just
  // logged when batch-entering bids.
  const createdTitle = encodeURIComponent(result.opportunity.title);
  if (returnTo === "account" && UUID_RE.test(account_id)) {
    redirect(`/commercial/accounts/${account_id}?tab=opportunities&created=1&created_title=${createdTitle}`);
  }
  redirect(`/commercial/opportunities?created=1&created_title=${createdTitle}`);
}

export default async function NewOpportunityPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const errorMessage = pickFirst(sp.error);
  // Allow ?account=<uuid> deep-link to pre-pick the account (e.g. from
  // a future "New opportunity" button on the Account detail page).
  const presetAccount = pickFirst(sp.account);
  const accounts = await listCommercialAccounts();

  return (
    <div className="space-y-5 max-w-3xl">
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
        <h1 className="text-2xl sm:text-3xl font-bold text-ppp-charcoal mt-2">
          New opportunity
        </h1>
        <p className="text-sm text-ppp-charcoal-500 mt-1">
          Log a commercial bid. Primary contact auto-pulls from the account&apos;s starred contact.
        </p>
      </header>

      {errorMessage && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </div>
      )}

      <form action={createAction} className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 space-y-4">
        {/* Stamp the return path when the user landed here from an
            Account's Opportunities tab so we drop them back there after
            the create instead of into the global pipeline. */}
        {presetAccount && <input type="hidden" name="return_to" value="account" />}
        <div>
          <label htmlFor="account_id" className={LABEL_CLS}>
            Account <span className="text-rose-700">*</span>
          </label>
          {accounts.length === 0 ? (
            <Link
              href="/commercial/accounts/new"
              className="block w-full px-3.5 py-3 text-sm text-center bg-amber-50 border-2 border-dashed border-amber-300 text-amber-900 rounded-xl hover:bg-amber-100 hover:border-amber-400 transition-colors min-h-[44px] touch-manipulation"
            >
              No accounts yet — <strong className="underline">create your first account</strong> →
            </Link>
          ) : (
            <select
              id="account_id"
              name="account_id"
              required
              defaultValue={presetAccount ?? ""}
              className={SELECT_CLS}
              style={SELECT_BG_STYLE}
            >
              <option value="">Pick an account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.company_name}
                </option>
              ))}
            </select>
          )}
        </div>

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
            placeholder="e.g. Lobby + Halls Repaint Q3"
            className={INPUT_CLS}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="status" className={LABEL_CLS}>
              Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue="inquiry"
              className={SELECT_CLS}
              style={SELECT_BG_STYLE}
            >
              {OPPORTUNITY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {opportunityStatusLabel(s)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="source" className={LABEL_CLS}>
              How did this come in?
            </label>
            <select
              id="source"
              name="source"
              defaultValue=""
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
            <p className="text-[10px] text-ppp-charcoal-400 mt-1.5">
              Used to filter the pipeline later by lead channel.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="bid_low" className={LABEL_CLS}>
              Bid low ($)
            </label>
            <input
              id="bid_low"
              name="bid_low"
              type="number"
              inputMode="decimal"
              step="100"
              min="0"
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
              type="number"
              inputMode="decimal"
              step="100"
              min="0"
              placeholder="e.g. 35000"
              className={INPUT_CLS}
            />
          </div>
        </div>

        <div>
          <label htmlFor="proposal_due_at" className={LABEL_CLS}>
            Proposal due
          </label>
          <input
            id="proposal_due_at"
            name="proposal_due_at"
            type="date"
            className={INPUT_CLS}
          />
        </div>

        <div className="space-y-3 rounded-xl border border-ppp-charcoal-100 bg-ppp-charcoal-50/40 p-3 sm:p-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-ppp-charcoal-500">
              Property / project address (optional)
            </h3>
            <span className="text-[11px] text-ppp-charcoal-500">
              Leave blank to use the account&apos;s site address
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
            placeholder="Optional. Quick scope notes — full RFP attaches in Batch 4."
            className={TEXTAREA_CLS}
          />
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-3 pt-2">
          <Link
            href="/commercial/opportunities"
            className="inline-flex items-center justify-center px-4 py-2.5 rounded-lg border border-ppp-charcoal-100 text-sm font-semibold text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px] touch-manipulation"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={accounts.length === 0}
            className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:bg-emerald-800 shadow-sm shadow-emerald-600/30 min-h-[44px] touch-manipulation disabled:bg-ppp-charcoal-300 disabled:cursor-not-allowed disabled:shadow-none"
          >
            Create opportunity
          </button>
        </div>
      </form>
    </div>
  );
}
