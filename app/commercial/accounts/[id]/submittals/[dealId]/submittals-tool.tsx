/**
 * Submittals — account-scoped project page. The submittal log for a post-sale
 * project + a "New submittal" action; each row drills into the submittal
 * detail. Mirrors the Change Orders / AIA / Closeout account-scoped pattern so
 * Submittals is no longer the odd tool hanging off the opportunity page.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import {
  listOpportunitySubmittals,
  createOpportunitySubmittal,
  type OpportunitySubmittalWithItemCount,
} from "@/lib/commercial/opportunities/submittals";
import { submittalStatusLabel, submittalStatusTone } from "@/lib/commercial/opportunities/submittal-constants";
import { ToolBackHeader } from "@/components/commercial/tool-back-header";
import { DonutChart } from "@/components/commercial/charts";
import { UUID_RE } from "@/lib/commercial/uuid";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<{ error?: string; back?: string }>;

async function createSubmittalAction(formData: FormData) {
  "use server";
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  const account_id = String(formData.get("account_id") ?? "");
  const opportunity_id = String(formData.get("opportunity_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const backQ = back && back.startsWith("/commercial/post-job/") ? `&back=${encodeURIComponent(back)}` : "";
  // Detail-page ?back for the new submittal's "Back to submittals": a guarded
  // post-job origin wins; otherwise, when created from the INLINE deal tab, point
  // Back at the deal's Project→Submittals sub-tab (not the standalone log) so the
  // user returns to WHERE they were. From the standalone route, the detail's
  // default back (the standalone log) is already correct.
  const backQfirst = back && back.startsWith("/commercial/post-job/")
    ? `?back=${encodeURIComponent(back)}`
    : origin === "inline"
      ? `?back=${encodeURIComponent(`/commercial/accounts/${account_id}?tab=projects&project=${opportunity_id}&dt=submittals`)}`
      : "";
  if (!UUID_RE.test(account_id) || !UUID_RE.test(opportunity_id)) redirect("/commercial/accounts");
  // Return you to WHERE you are — standalone submittals log when opened directly,
  // the account's deal (Project sub-tab) view when embedded there. Never jump.
  const base =
    origin === "route"
      ? `/commercial/accounts/${account_id}/submittals/${opportunity_id}?v=1`
      : `/commercial/accounts/${account_id}?tab=projects&project=${opportunity_id}&dt=submittals`;

  const sb = commercialDb();
  const { data: acctRow } = await sb
    .from("commercial_accounts")
    .select("company_name, billing_street, billing_city, billing_state, billing_zip")
    .eq("id", account_id)
    .maybeSingle();
  type AcctLite = { company_name: string | null; billing_street: string | null; billing_city: string | null; billing_state: string | null; billing_zip: string | null };
  const acct = acctRow as AcctLite | null;
  let to_address_lines: string[] | null = null;
  if (acct) {
    const lines: string[] = [];
    if (acct.billing_street?.trim()) lines.push(acct.billing_street.trim());
    const cityState = [acct.billing_city?.trim(), acct.billing_state?.trim()].filter(Boolean).join(", ");
    const csz = [cityState, acct.billing_zip?.trim()].filter(Boolean).join(" ");
    if (csz) lines.push(csz);
    if (lines.length > 0) to_address_lines = lines;
  }

  const result = await createOpportunitySubmittal({
    opportunity_id,
    to_company: acct?.company_name ?? null,
    to_address_lines,
    re_subject: "Submittals",
    created_by_user_id: user.id,
  });
  if (!result.ok) redirect(`${base}&error=${encodeURIComponent(result.error)}${backQ}`);
  revalidatePath(`/commercial/accounts/${account_id}/submittals/${opportunity_id}`);
  revalidatePath(`/commercial/accounts/${account_id}`);
  revalidatePath("/commercial/post-job/submittals");
  // Hand off to the account-scoped detail page so the cover + items can be
  // filled in — carry the sidebar-tool origin so its Back stays correct.
  redirect(`/commercial/accounts/${account_id}/submittals/${opportunity_id}/${result.submittal.id}${backQfirst}`);
}

export type SubmittalsSP = { error?: string; back?: string };
export async function SubmittalsTool({
  id,
  dealId,
  sp,
  variant,
}: {
  id: string;
  dealId: string;
  sp: SubmittalsSP;
  variant: "route" | "inline";
}) {
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const [account, opp] = await Promise.all([getCommercialAccount(id), getCommercialOpportunity(dealId)]);
  if (!account || !opp) notFound();
  if (opp.account_id !== id) notFound();
  // No Won-gate: submittals are available on every deal (Karan 2026-08 —
  // nothing locked). A bid simply has none yet.

  const dealName = derivedOppName(opp, account.company_name);
  const submittals = await listOpportunitySubmittals(dealId);
  // Status buckets for the stat row (ball-in-court = still needs a response).
  const openCount = submittals.filter((s) => ["draft", "submitted", "under_review"].includes(s.status)).length;
  const approvedCount = submittals.filter((s) => ["approved", "approved_as_noted"].includes(s.status)).length;
  const reworkCount = submittals.filter((s) => ["revise_and_resubmit", "rejected"].includes(s.status)).length;
  // Everything else — closed (the normal happy terminal) + voided. Without this
  // the donut slices + center excluded resolved packages and contradicted the
  // "Total" stat beside it (2026-08 re-audit).
  const closedCount = submittals.length - openCount - approvedCount - reworkCount;

  return (
    <div className={variant === "inline" ? "space-y-4" : "max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4"}>
      {variant === "route" && (
        <>
          <ToolBackHeader accountId={id} dealId={dealId} accountName={account.company_name} dealName={dealName} back={sp.back} />
          <div>
            <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Submittals</h1>
            <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
              {dealName} · <span className="font-medium">{oppStatusDisplayLabel(opp.status, opp.sub_status)}</span>
            </p>
          </div>
        </>
      )}

      {submittals.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="lg:col-span-2 grid grid-cols-2 gap-2">
            <SubmittalStat label="Total" value={submittals.length} tone="neutral" />
            <SubmittalStat label="Open / in review" value={openCount} tone={openCount > 0 ? "amber" : "neutral"} />
            <SubmittalStat label="Approved" value={approvedCount} tone={approvedCount > 0 ? "emerald" : "neutral"} />
            <SubmittalStat label="Revise / rejected" value={reworkCount} tone={reworkCount > 0 ? "rose" : "neutral"} />
          </div>
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-3 flex items-center justify-center">
            <DonutChart
              size={116}
              segments={[
                { label: "Approved", value: approvedCount, tone: "emerald", valueLabel: String(approvedCount) },
                { label: "Open / review", value: openCount, tone: "amber", valueLabel: String(openCount) },
                { label: "Revise / rejected", value: reworkCount, tone: "rose", valueLabel: String(reworkCount) },
                ...(closedCount > 0
                  ? [{ label: "Closed", value: closedCount, tone: "neutral" as const, valueLabel: String(closedCount) }]
                  : []),
              ]}
              centerValue={String(submittals.length)}
              centerLabel={submittals.length === 1 ? "submittal" : "submittals"}
            />
          </div>
        </div>
      )}

      {sp.error && (
        <div role="alert" aria-live="polite" className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-800 flex items-start gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="mt-0.5 shrink-0"><circle cx="12" cy="12" r="10" /><path d="M12 6v6 M12 16.5v.5" /></svg>
          <span>{decodeURIComponent(sp.error)}</span>
        </div>
      )}

      {/* RUX-3: brand accent (cc-brand) to match the other five delivery tools —
          was the lone ppp-blue CTA. The per-status "sky" tone below stays blue
          (that's a submittal-status color, not the tool accent). */}
      <section className="bg-cc-brand-50 border border-cc-brand-200 rounded-xl p-4">
        <form action={createSubmittalAction} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-sm text-cc-brand-900">
            <strong className="font-semibold">New submittal package</strong>
            <p className="text-[12px] text-cc-brand-800/80 mt-0.5">Creates a draft Letter of Transmittal. Fill cover + items on the next page, attach spec PDFs, then send.</p>
          </div>
          <input type="hidden" name="account_id" value={id} />
          <input type="hidden" name="opportunity_id" value={dealId} />
          <input type="hidden" name="origin" value={variant} />
          <input type="hidden" name="back" value={sp.back ?? ""} />
          <button type="submit" className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold hover:bg-cc-brand-700 active:bg-cc-brand-800 transition-colors shadow-sm min-h-[44px] touch-manipulation shrink-0">
            + New submittal
          </button>
        </form>
      </section>

      {submittals.length === 0 ? (
        <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-8 text-center text-sm text-ppp-charcoal-500">
          No submittals yet. The first package usually goes out right after the finish schedule is locked + spec PDFs are uploaded.
        </div>
      ) : (
        <section className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-ppp-charcoal-100">
            <h2 className="text-sm font-semibold text-ppp-charcoal">Submittal log · {submittals.length} {submittals.length === 1 ? "submittal" : "submittals"}</h2>
          </div>
          <ul className="divide-y divide-ppp-charcoal-100">
            {submittals.map((s) => (
              <SubmittalRow key={s.id} submittal={s} oppId={dealId} accountId={id} back={sp.back} origin={variant} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SubmittalStat({ label, value, tone }: { label: string; value: number; tone: "neutral" | "amber" | "emerald" | "rose" }) {
  const cls = tone === "amber" ? "text-amber-700" : tone === "emerald" ? "text-emerald-700" : tone === "rose" ? "text-rose-700" : "text-ppp-charcoal";
  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl px-3.5 py-2.5 shadow-sm">
      <div className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-xl sm:text-2xl font-black tabular-nums mt-0.5 ${cls}`}>{value}</div>
    </div>
  );
}

function SubmittalRow({ submittal, oppId, accountId, back, origin = "" }: { submittal: OpportunitySubmittalWithItemCount; oppId: string; accountId: string; back?: string; origin?: string }) {
  // Forward where the user is so the detail's Back / save-redirect returns HERE
  // (the deal's Project sub-tab when embedded, the standalone log otherwise, or a
  // deeper origin like the global submittals index if one was passed in).
  const logHere =
    origin === "route"
      ? `/commercial/accounts/${accountId}/submittals/${oppId}?v=1`
      : `/commercial/accounts/${accountId}?tab=projects&project=${oppId}&dt=submittals`;
  const backHref = `?back=${encodeURIComponent(back && back.startsWith("/commercial/") ? back : logHere)}`;
  const tone = submittalStatusTone(submittal.status);
  const tonePillCls =
    tone === "emerald" ? "bg-emerald-50 text-emerald-800 border-emerald-200"
    : tone === "amber" ? "bg-amber-50 text-amber-900 border-amber-200"
    : tone === "rose" ? "bg-rose-50 text-rose-800 border-rose-200"
    : tone === "sky" ? "bg-ppp-blue-50 text-ppp-blue-800 border-ppp-blue-200"
    : tone === "charcoal" ? "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200"
    : "bg-surface text-ppp-charcoal-600 border-ppp-charcoal-200";
  const fmt = (iso: string | null): string =>
    iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric" }) : "—";
  const subline = submittal.sent_at ? `Sent ${fmt(submittal.sent_at)}` : `Drafted ${fmt(submittal.created_at)}`;
  const responseLine = submittal.response_received_at ? ` · Response received ${fmt(submittal.response_received_at)}` : "";
  return (
    <li>
      <Link href={`/commercial/accounts/${accountId}/submittals/${oppId}/${submittal.id}${backHref}`} className="block px-4 py-3 hover:bg-ppp-charcoal-50 transition-colors min-h-[44px]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-mono font-bold text-ppp-charcoal text-sm">
                SUB-{String(submittal.submittal_number).padStart(3, "0")}
                {submittal.revision_number > 0 && <span className="text-ppp-charcoal-500 ml-1">Rev {submittal.revision_number}</span>}
              </span>
              <span className={`inline-flex items-center text-[10px] font-bold tracking-wider uppercase px-2 py-0.5 rounded border ${tonePillCls}`}>
                {submittalStatusLabel(submittal.status)}
              </span>
            </div>
            <div className="text-[12px] text-ppp-charcoal-500 mt-1">
              {subline}{responseLine}
              <span className="ml-2">· {submittal.item_count} {submittal.item_count === 1 ? "item" : "items"}</span>
            </div>
            {submittal.to_company && (
              <div className="text-[12px] text-ppp-charcoal-700 mt-0.5 truncate">
                To: {submittal.to_company}
                {submittal.to_attention ? <span className="text-ppp-charcoal-500"> · Attn {submittal.to_attention}</span> : null}
              </div>
            )}
          </div>
          <span aria-hidden className="shrink-0 text-ppp-charcoal-400 text-base mt-0.5">→</span>
        </div>
      </Link>
    </li>
  );
}
