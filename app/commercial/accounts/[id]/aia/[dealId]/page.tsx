/**
 * AIA progress billing — account-scoped page (Phase H2). Lists the payment
 * applications for a post-sale project and, when one is selected (?app=),
 * shows its G702 certificate summary + editable G703 schedule of values.
 * Same account-scoped pattern + drawer-reopening back link as Change Orders.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { isPostSaleProject, oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import { netApprovedChangeOrderCents } from "@/lib/commercial/change-orders/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { parseDollarsToCents } from "@/lib/commercial/invoices/format";
import { formatCentsFull, fmtEtDate } from "@/lib/commercial/invoices/format";
import {
  listAiaApplications,
  getAiaApplication,
  listAiaLineItems,
  createAiaApplication,
  updateAiaApplication,
  deleteAiaApplication,
  upsertAiaLineItem,
  deleteAiaLineItem,
  resolveG702,
} from "@/lib/commercial/aia/db";
import { AIA_STATUS_META, DEFAULT_RETAINAGE_PCT, type AiaApplicationStatus } from "@/lib/commercial/aia/constants";
import { AiaApplicationDetail } from "@/components/commercial/aia-application-detail";
import { ProjectToolbar } from "@/components/commercial/project-toolbar";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<{ app?: string; error?: string; ok?: string }>;

async function requireCommercialUser(): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return user.id;
}

function base(id: string, dealId: string): string {
  return `/commercial/accounts/${id}/aia/${dealId}`;
}
function revalidateAia(id: string, dealId: string) {
  revalidatePath(base(id, dealId));
  revalidatePath(`/commercial/accounts/${id}`);
}
function toEtNoon(dateStr: string): string | null {
  const s = dateStr.trim();
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T16:00:00.000Z` : null;
}

async function createApplicationAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) redirect("/commercial/accounts");
  const retainageRaw = String(formData.get("retainage_pct") ?? "");
  const retainage_pct = retainageRaw ? Number(retainageRaw) : DEFAULT_RETAINAGE_PCT;
  const result = await createAiaApplication({
    opportunity_id: dealId,
    retainage_pct: Number.isFinite(retainage_pct) ? retainage_pct : DEFAULT_RETAINAGE_PCT,
    period_to: toEtNoon(String(formData.get("period_to") ?? "")),
    period_from: toEtNoon(String(formData.get("period_from") ?? "")),
    created_by_user_id: userId,
  });
  if (!result.ok) redirect(`${base(id, dealId)}?error=${encodeURIComponent(result.error)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId)}?app=${result.value.id}`);
}

async function updateApplicationAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId)) redirect("/commercial/accounts");
  const original = parseDollarsToCents(String(formData.get("original_contract") ?? ""));
  const retainageRaw = String(formData.get("retainage_pct") ?? "");
  const result = await updateAiaApplication(
    appId,
    {
      period_from: toEtNoon(String(formData.get("period_from") ?? "")),
      period_to: toEtNoon(String(formData.get("period_to") ?? "")),
      ...(original != null && original >= 0 ? { original_contract_cents: original } : {}),
      ...(retainageRaw ? { retainage_pct: Number(retainageRaw) } : {}),
      notes: String(formData.get("notes") ?? "").slice(0, 4000) || null,
    },
    userId
  );
  if (!result.ok) redirect(`${base(id, dealId)}?app=${appId}&error=${encodeURIComponent(result.error)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId)}?app=${appId}`);
}

async function setStatusAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  const status = String(formData.get("status") ?? "") as AiaApplicationStatus;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId)) redirect("/commercial/accounts");
  if (!["draft", "submitted", "paid"].includes(status)) redirect(`${base(id, dealId)}?app=${appId}`);
  const result = await updateAiaApplication(appId, { status }, userId);
  if (!result.ok) redirect(`${base(id, dealId)}?app=${appId}&error=${encodeURIComponent(result.error)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId)}?app=${appId}`);
}

async function deleteApplicationAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId)) redirect("/commercial/accounts");
  const result = await deleteAiaApplication(appId, userId);
  if (!result.ok) redirect(`${base(id, dealId)}?error=${encodeURIComponent(result.error)}`);
  revalidateAia(id, dealId);
  redirect(base(id, dealId));
}

async function upsertLineAction(formData: FormData) {
  "use server";
  await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  const lineId = String(formData.get("line_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId)) redirect("/commercial/accounts");
  const cents = (name: string) => parseDollarsToCents(String(formData.get(name) ?? "")) ?? 0;
  const result = await upsertAiaLineItem(appId, {
    ...(UUID_RE.test(lineId) ? { id: lineId } : {}),
    item_no: String(formData.get("item_no") ?? "").trim() || null,
    description: String(formData.get("description") ?? "").trim(),
    scheduled_value_cents: cents("scheduled"),
    from_previous_cents: cents("from_previous"),
    this_period_cents: cents("this_period"),
    materials_stored_cents: cents("materials_stored"),
  });
  if (!result.ok) redirect(`${base(id, dealId)}?app=${appId}&error=${encodeURIComponent(result.error)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId)}?app=${appId}`);
}

async function deleteLineAction(formData: FormData) {
  "use server";
  await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  const lineId = String(formData.get("line_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId) || !UUID_RE.test(lineId)) redirect("/commercial/accounts");
  await deleteAiaLineItem(lineId, appId);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId)}?app=${appId}`);
}

export default async function AiaBillingPage({ params, searchParams }: { params: PP; searchParams: SP }) {
  await requireCommercialUser();
  const { id, dealId } = await params;
  const sp = await searchParams;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();

  const [account, opp] = await Promise.all([getCommercialAccount(id), getCommercialOpportunity(dealId)]);
  if (!account || !opp) notFound();
  if (opp.account_id !== id) notFound();
  if (!isPostSaleProject(opp)) {
    redirect(`/commercial/accounts/${id}?tab=opportunities&edit=${dealId}`);
  }

  const dealName = derivedOppName(opp, account.company_name);
  const b = base(id, dealId);

  // Hidden fields shared by all forms (account + deal + app context).
  const ctx = (
    <>
      <input type="hidden" name="account_id" value={id} />
      <input type="hidden" name="opp_id" value={dealId} />
    </>
  );

  const selectedAppId = typeof sp.app === "string" && UUID_RE.test(sp.app) ? sp.app : null;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <div className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500 flex-wrap">
        <Link href={`/commercial/accounts/${id}?tab=opportunities&edit=${dealId}`} className="inline-flex items-center gap-1 hover:text-cc-brand-700 min-h-[32px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5 M12 19l-7-7 7-7" /></svg>
          Back to {account.company_name}
        </Link>
        <span aria-hidden>/</span>
        <span className="text-ppp-charcoal-700 font-medium truncate">{dealName}</span>
      </div>

      <div>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">AIA Billing</h1>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
          {dealName} · <span className="font-medium">{oppStatusDisplayLabel(opp.status, opp.sub_status)}</span> · G702 / G703 progress billing
        </p>
      </div>

      <ProjectToolbar accountId={id} dealId={dealId} active="aia" />

      {sp.error && !selectedAppId && (
        <div className="rounded-lg px-4 py-3 text-sm bg-rose-50 border border-rose-200 text-rose-700">{sp.error}</div>
      )}

      {selectedAppId ? (
        await (async () => {
          const application = await getAiaApplication(selectedAppId);
          if (!application || application.opportunity_id !== dealId) {
            // Stale / cross-deal app id — back to the list.
            redirect(b);
          }
          const [lines, g702] = await Promise.all([
            listAiaLineItems(selectedAppId),
            resolveG702(selectedAppId),
          ]);
          return (
            <>
              <AiaApplicationDetail
                application={application}
                accountId={id}
                dealId={dealId}
                lines={lines}
                g702={g702!}
                basePath={b}
                exportHref={`/api/commercial/aia/${selectedAppId}/export`}
                editable={application.status === "draft"}
                upsertLineAction={upsertLineAction}
                deleteLineAction={deleteLineAction}
                setStatusAction={setStatusAction}
                errorMessage={sp.error ?? null}
              />
              {/* Application settings + delete (compact) — Draft only; an issued
                  certificate's contract/retainage/period are locked. */}
              {application.status === "draft" && (
              <details className="bg-surface border border-ppp-charcoal-100 rounded-xl">
                <summary className="cursor-pointer list-none px-4 py-3 min-h-[44px] flex items-center gap-2 text-[12px] font-semibold text-ppp-charcoal-700 select-none">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H1a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8 4.6h.09" /></svg>
                  Application settings
                </summary>
                <form action={updateApplicationAction} className="px-4 pb-4 pt-1 grid sm:grid-cols-2 gap-3">
                  {ctx}
                  <input type="hidden" name="app_id" value={selectedAppId} />
                  <label className="block">
                    <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Period from</span>
                    <input type="date" name="period_from" defaultValue={application.period_from?.slice(0, 10) ?? ""} className={INPUT} />
                  </label>
                  <label className="block">
                    <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Period to</span>
                    <input type="date" name="period_to" defaultValue={application.period_to?.slice(0, 10) ?? ""} className={INPUT} />
                  </label>
                  <label className="block">
                    <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Original contract ($)</span>
                    <input name="original_contract" inputMode="decimal" defaultValue={(application.original_contract_cents / 100).toFixed(2)} className={INPUT} />
                  </label>
                  <label className="block">
                    <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Retainage (%)</span>
                    <input name="retainage_pct" inputMode="decimal" defaultValue={String(Number(application.retainage_pct))} className={INPUT} />
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Notes</span>
                    <textarea name="notes" rows={2} defaultValue={application.notes ?? ""} maxLength={4000} className={INPUT} />
                  </label>
                  <div className="sm:col-span-2 flex items-center justify-between gap-2">
                    <PendingSubmitButton pendingLabel="Saving…" className="px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">Save settings</PendingSubmitButton>
                    <ConfirmSubmitButton
                      message={`Delete Application No. ${application.application_number}? This can't be undone.`}
                      pendingLabel="Deleting…"
                      formAction={deleteApplicationAction}
                      className="px-3.5 py-2 rounded-lg text-[12px] font-medium text-ppp-charcoal-400 hover:text-rose-700 hover:bg-rose-50 min-h-[44px]"
                    >
                      Delete application
                    </ConfirmSubmitButton>
                  </div>
                </form>
              </details>
              )}
            </>
          );
        })()
      ) : (
        <AiaApplicationList
          id={id}
          dealId={dealId}
          createAction={createApplicationAction}
        />
      )}
    </div>
  );
}

const INPUT = "w-full px-3 py-2 text-base sm:text-sm bg-surface border border-ppp-charcoal-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px]";

async function AiaApplicationList({
  id,
  dealId,
  createAction,
}: {
  id: string;
  dealId: string;
  createAction: (fd: FormData) => void | Promise<void>;
}) {
  const [applications, netCO] = await Promise.all([
    listAiaApplications(dealId),
    netApprovedChangeOrderCents(dealId),
  ]);
  return (
    <div className="space-y-3">
      {netCO !== 0 && (
        <div className="text-[12px] text-ppp-charcoal-500">
          Approved change orders on this project:{" "}
          <span className={`font-semibold ${netCO < 0 ? "text-rose-700" : "text-emerald-700"}`}>
            {netCO < 0 ? "−" : "+"}{formatCentsFull(Math.abs(netCO))}
          </span>{" "}
          — folded into each application&rsquo;s contract sum to date.
        </div>
      )}

      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Payment applications</h2>
        {applications.length === 0 ? (
          <p className="text-[12px] text-ppp-charcoal-500 mb-3">No applications yet. Start the first billing period below.</p>
        ) : (
          <ul className="space-y-2 mb-4">
            {applications.map((a) => (
              <li key={a.id}>
                <Link
                  href={`${base(id, dealId)}?app=${a.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-ppp-charcoal-100 px-3.5 py-2.5 hover:border-cc-brand-300 hover:bg-cc-brand-50/40 transition-colors min-h-[44px]"
                >
                  <span className="min-w-0">
                    <span className="text-[13px] font-semibold text-ppp-charcoal">Application No. {a.application_number}</span>
                    <span className="block text-[11px] text-ppp-charcoal-500">
                      {a.period_to ? `Period to ${fmtEtDate(a.period_to)}` : "No period set"}
                    </span>
                  </span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold shrink-0 ${
                    AIA_STATUS_META[a.status].tone === "emerald" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : AIA_STATUS_META[a.status].tone === "ppp-blue" ? "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200"
                    : "bg-amber-50 text-amber-800 border-amber-200"
                  }`}>
                    {AIA_STATUS_META[a.status].label}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <form action={createAction} className="rounded-lg border border-dashed border-cc-brand-200 p-3.5 grid sm:grid-cols-3 gap-3 items-end">
          <input type="hidden" name="account_id" value={id} />
          <input type="hidden" name="opp_id" value={dealId} />
          <label className="block">
            <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Period to</span>
            <input type="date" name="period_to" className={INPUT} />
          </label>
          <label className="block">
            <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Retainage (%)</span>
            <input name="retainage_pct" inputMode="decimal" defaultValue={String(DEFAULT_RETAINAGE_PCT)} className={INPUT} />
          </label>
          <PendingSubmitButton pendingLabel="Creating…" className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">
            New application
          </PendingSubmitButton>
        </form>
      </section>
    </div>
  );
}
