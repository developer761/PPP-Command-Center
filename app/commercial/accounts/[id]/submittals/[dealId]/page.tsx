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
import { isPostSaleProject, oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import {
  listOpportunitySubmittals,
  createOpportunitySubmittal,
  type OpportunitySubmittalWithItemCount,
} from "@/lib/commercial/opportunities/submittals";
import { submittalStatusLabel, submittalStatusTone } from "@/lib/commercial/opportunities/submittal-constants";
import { ProjectToolbar } from "@/components/commercial/project-toolbar";
import { ToolBackHeader, resolveToolBack } from "@/components/commercial/tool-back-header";
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
  if (!UUID_RE.test(account_id) || !UUID_RE.test(opportunity_id)) redirect("/commercial/accounts");
  const base = `/commercial/accounts/${account_id}/submittals/${opportunity_id}`;

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
  if (!result.ok) redirect(`${base}?error=${encodeURIComponent(result.error)}`);
  revalidatePath(base);
  revalidatePath(`/commercial/accounts/${account_id}`);
  revalidatePath("/commercial/post-job/submittals");
  // Hand off to the account-scoped detail page so the cover + items can be
  // filled in — never bounces to /opportunities anymore.
  redirect(`/commercial/accounts/${account_id}/submittals/${opportunity_id}/${result.submittal.id}`);
}

export default async function AccountSubmittalsPage({ params, searchParams }: { params: PP; searchParams: SP }) {
  const { id, dealId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);

  const [account, opp] = await Promise.all([getCommercialAccount(id), getCommercialOpportunity(dealId)]);
  if (!account || !opp) notFound();
  if (opp.account_id !== id) notFound();
  if (!isPostSaleProject(opp)) {
    redirect(`/commercial/accounts/${id}?tab=opportunities&edit=${dealId}&status_error=${encodeURIComponent("Submittals open once the deal is Won and in delivery — mark it Won first.")}`);
  }

  const sp = await searchParams;
  const dealName = derivedOppName(opp, account.company_name);
  const submittals = await listOpportunitySubmittals(dealId);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <ToolBackHeader accountId={id} dealId={dealId} accountName={account.company_name} dealName={dealName} back={sp.back} />

      <div>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Submittals</h1>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
          {dealName} · <span className="font-medium">{oppStatusDisplayLabel(opp.status, opp.sub_status)}</span>
        </p>
      </div>

      <ProjectToolbar accountId={id} dealId={dealId} active="submittals" fromTool={!!resolveToolBack(sp.back)} />

      {sp.error && (
        <div role="alert" aria-live="polite" className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-800 flex items-start gap-2">
          <span aria-hidden className="mt-0.5">⚠</span>
          <span>{decodeURIComponent(sp.error)}</span>
        </div>
      )}

      <section className="bg-ppp-blue-50 border border-ppp-blue-200 rounded-xl p-4">
        <form action={createSubmittalAction} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-sm text-ppp-blue-900">
            <strong className="font-semibold">New submittal package</strong>
            <p className="text-[12px] text-ppp-blue-800/80 mt-0.5">Creates a draft Letter of Transmittal. Fill cover + items on the next page, attach spec PDFs, then send.</p>
          </div>
          <input type="hidden" name="account_id" value={id} />
          <input type="hidden" name="opportunity_id" value={dealId} />
          <button type="submit" className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-ppp-blue-600 text-white text-sm font-semibold hover:bg-ppp-blue-800 active:bg-ppp-blue-900 transition-colors shadow-sm min-h-[44px] touch-manipulation shrink-0">
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
              <SubmittalRow key={s.id} submittal={s} oppId={dealId} accountId={id} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SubmittalRow({ submittal, oppId, accountId }: { submittal: OpportunitySubmittalWithItemCount; oppId: string; accountId: string }) {
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
      <Link href={`/commercial/accounts/${accountId}/submittals/${oppId}/${submittal.id}`} className="block px-4 py-3 hover:bg-ppp-charcoal-50 transition-colors min-h-[44px]">
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
