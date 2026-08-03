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
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
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
  getEffectiveContractBaseCents,
} from "@/lib/commercial/aia/db";
import { AIA_STATUS_META, DEFAULT_RETAINAGE_PCT, type AiaApplicationStatus } from "@/lib/commercial/aia/constants";
import { buildAiaWorkbookBuffer } from "@/lib/commercial/aia/export";
import { autoFileOpportunityDocument, safeDocName, sentStampNote } from "@/lib/commercial/documents/auto-file";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { AiaApplicationDetail } from "@/components/commercial/aia-application-detail";
import type { AiaLineSaveResult } from "@/components/commercial/aia-line-row";
import { AiaSettingsForm } from "@/components/commercial/aia-settings-form";
import { ToolBackHeader } from "@/components/commercial/tool-back-header";
import { DateField } from "@/components/commercial/date-field";
import { DonutChart, GaugeRing } from "@/components/commercial/charts";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<{ app?: string; error?: string; ok?: string; back?: string }>;

async function requireCommercialUser(): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return user.id;
}

/**
 * Ownership guard (Karan #33): verify the deal belongs to this account + is a
 * post-sale project, and (when given) that the application belongs to the deal.
 * The page loader checks this on render, but the server actions must re-check —
 * they're POST endpoints reachable with hand-crafted ids. Cheap indexed reads.
 */
async function ownsAiaContext(accountId: string, dealId: string, appId?: string): Promise<boolean> {
  const opp = await getCommercialOpportunity(dealId);
  // Ownership only — no Won-gate (Karan 2026-08: nothing locked).
  if (!opp || opp.account_id !== accountId) return false;
  if (appId) {
    const app = await getAiaApplication(appId);
    if (!app || app.opportunity_id !== dealId) return false;
  }
  return true;
}

/** Canonical home for AIA billing = the deal's Project sub-tab. Already carries
 *  a query string, so callers append params with `&`. */
function base(id: string, dealId: string): string {
  return `/commercial/accounts/${id}?tab=projects&project=${dealId}&dt=aia`;
}
function backQ(back: string): string {
  return back && back.startsWith("/commercial/post-job/") ? `&back=${encodeURIComponent(back)}` : "";
}
function revalidateAia(id: string, dealId: string) {
  revalidatePath(`/commercial/accounts/${id}/aia/${dealId}`);
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
  const back = String(formData.get("back") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) redirect("/commercial/accounts");
  if (!(await ownsAiaContext(id, dealId))) redirect("/commercial/accounts");
  const retainageRaw = String(formData.get("retainage_pct") ?? "");
  const retainage_pct = retainageRaw ? Number(retainageRaw) : DEFAULT_RETAINAGE_PCT;
  const result = await createAiaApplication({
    opportunity_id: dealId,
    retainage_pct: Number.isFinite(retainage_pct) ? retainage_pct : DEFAULT_RETAINAGE_PCT,
    period_to: toEtNoon(String(formData.get("period_to") ?? "")),
    period_from: toEtNoon(String(formData.get("period_from") ?? "")),
    created_by_user_id: userId,
  });
  if (!result.ok) redirect(`${base(id, dealId)}&error=${encodeURIComponent(result.error)}${backQ(back)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId)}&app=${result.value.id}${backQ(back)}`);
}

async function updateApplicationAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId)) redirect("/commercial/accounts");
  if (!(await ownsAiaContext(id, dealId, appId))) redirect("/commercial/accounts");
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
  if (!result.ok) redirect(`${base(id, dealId)}&app=${appId}&error=${encodeURIComponent(result.error)}${backQ(back)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId)}&app=${appId}${backQ(back)}`);
}

/** Non-redirecting variant of updateApplicationAction for the autosaving
 *  settings panel. Returns {ok,error} so the client can show Saved in place. */
async function saveSettingsAutosaveAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId)) return { ok: false, error: "Bad request." };
  if (!(await ownsAiaContext(id, dealId, appId))) return { ok: false, error: "Not found." };
  const original = parseDollarsToCents(String(formData.get("original_contract") ?? ""));
  const retainageRaw = String(formData.get("retainage_pct") ?? "");
  const retainage = retainageRaw ? Number(retainageRaw) : NaN;
  const result = await updateAiaApplication(
    appId,
    {
      period_from: toEtNoon(String(formData.get("period_from") ?? "")),
      period_to: toEtNoon(String(formData.get("period_to") ?? "")),
      ...(original != null && original >= 0 ? { original_contract_cents: original } : {}),
      ...(Number.isFinite(retainage) && retainage >= 0 && retainage <= 100 ? { retainage_pct: retainage } : {}),
      notes: String(formData.get("notes") ?? "").slice(0, 4000) || null,
    },
    userId
  );
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAia(id, dealId);
  return { ok: true };
}

async function setStatusAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  const status = String(formData.get("status") ?? "") as AiaApplicationStatus;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId)) redirect("/commercial/accounts");
  if (!(await ownsAiaContext(id, dealId, appId))) redirect("/commercial/accounts");
  if (!["draft", "submitted", "paid"].includes(status)) redirect(`${base(id, dealId)}&app=${appId}${backQ(back)}`);
  const result = await updateAiaApplication(appId, { status }, userId);
  if (!result.ok) redirect(`${base(id, dealId)}&app=${appId}&error=${encodeURIComponent(result.error)}${backQ(back)}`);
  // Auto-file the G702/G703 workbook when the application is submitted to the GC
  // (best-effort — never blocks the status change).
  if (status === "submitted") await autoFileAiaApplication(id, dealId, appId, userId);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId)}&app=${appId}${backQ(back)}`);
}

/** Build + file the AIA application workbook as a deal document (category
 *  aia_billing). Best-effort; mirrors the export route's data gathering. */
async function autoFileAiaApplication(accountId: string, dealId: string, appId: string, userId: string) {
  try {
    const application = await getAiaApplication(appId);
    if (!application) return;
    const [opp, lines, g702, account] = await Promise.all([
      getCommercialOpportunity(dealId),
      listAiaLineItems(appId),
      resolveG702(appId),
      getCommercialAccount(accountId),
    ]);
    if (!opp || !g702 || !account) return;
    const dealName = derivedOppName(opp, account.company_name);
    const projectLabel = [dealName, opp.property_street].filter(Boolean).join(" · ");
    const buf = await buildAiaWorkbookBuffer({
      application,
      lines,
      g702,
      projectLabel,
      ownerLabel: account.company_name,
      contractorLabel: (await getOperatingCompany()).name,
    });
    await autoFileOpportunityDocument({
      opportunityId: dealId,
      category: "aia_billing",
      fileName: safeDocName("AIA_App", application.application_number, dealName) + ".xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: new Uint8Array(buf),
      notes: sentStampNote(`AIA Application No. ${application.application_number} submitted`),
      actorUserId: userId,
    });
  } catch (err) {
    console.warn("[auto-file aia] failed:", err);
  }
}

async function deleteApplicationAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId)) redirect("/commercial/accounts");
  if (!(await ownsAiaContext(id, dealId, appId))) redirect("/commercial/accounts");
  const result = await deleteAiaApplication(appId, userId);
  if (!result.ok) redirect(`${base(id, dealId)}&error=${encodeURIComponent(result.error)}${backQ(back)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId)}${backQ(back)}`);
}

async function upsertLineAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  const lineId = String(formData.get("line_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId)) redirect("/commercial/accounts");
  if (!(await ownsAiaContext(id, dealId, appId))) redirect("/commercial/accounts");
  const cents = (name: string) => parseDollarsToCents(String(formData.get(name) ?? "")) ?? 0;
  const result = await upsertAiaLineItem(appId, {
    ...(UUID_RE.test(lineId) ? { id: lineId } : {}),
    item_no: String(formData.get("item_no") ?? "").trim() || null,
    description: String(formData.get("description") ?? "").trim(),
    scheduled_value_cents: cents("scheduled"),
    from_previous_cents: cents("from_previous"),
    this_period_cents: cents("this_period"),
    materials_stored_cents: cents("materials_stored"),
  }, userId);
  if (!result.ok) redirect(`${base(id, dealId)}&app=${appId}&error=${encodeURIComponent(result.error)}${backQ(back)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId)}&app=${appId}${backQ(back)}`);
}

/**
 * Autosave variant of upsertLineAction — RETURNS a result instead of
 * redirecting, so the client G703 row can save on blur without a navigation
 * that would clobber a cell being typed elsewhere. Revalidates so the G702
 * totals refresh on the next render.
 */
async function saveLineAutosaveAction(formData: FormData): Promise<AiaLineSaveResult> {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  const lineId = String(formData.get("line_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId) || !UUID_RE.test(lineId)) {
    return { ok: false, error: "Bad request." };
  }
  if (!(await ownsAiaContext(id, dealId, appId))) return { ok: false, error: "Not found." };
  const cents = (name: string) => parseDollarsToCents(String(formData.get(name) ?? "")) ?? 0;
  const result = await upsertAiaLineItem(appId, {
    id: lineId,
    item_no: String(formData.get("item_no") ?? "").trim() || null,
    description: String(formData.get("description") ?? "").trim(),
    scheduled_value_cents: cents("scheduled"),
    from_previous_cents: cents("from_previous"),
    this_period_cents: cents("this_period"),
    materials_stored_cents: cents("materials_stored"),
  }, userId);
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAia(id, dealId);
  // Return the STORED (normalized/clamped) values so the client row reconciles
  // its display to the DB — kills the "typed 100.999, stored 0, still shows
  // 100.999 with a green Saved ✓" divergence the audit caught.
  const v = result.value;
  return {
    ok: true,
    line: {
      item_no: v.item_no,
      description: v.description,
      scheduled_value_cents: v.scheduled_value_cents,
      from_previous_cents: v.from_previous_cents,
      this_period_cents: v.this_period_cents,
      materials_stored_cents: v.materials_stored_cents,
    },
  };
}

async function deleteLineAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  const lineId = String(formData.get("line_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId) || !UUID_RE.test(lineId)) redirect("/commercial/accounts");
  if (!(await ownsAiaContext(id, dealId, appId))) redirect("/commercial/accounts");
  await deleteAiaLineItem(lineId, appId, userId);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId)}&app=${appId}${backQ(back)}`);
}

export type AiaSP = { app?: string; error?: string; ok?: string; back?: string };
export async function AiaTool({
  id,
  dealId,
  sp,
  variant,
}: {
  id: string;
  dealId: string;
  sp: AiaSP;
  variant: "route" | "inline";
}) {
  await requireCommercialUser();
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();

  const [account, opp] = await Promise.all([getCommercialAccount(id), getCommercialOpportunity(dealId)]);
  if (!account || !opp) notFound();
  if (opp.account_id !== id) notFound();
  // No Won-gate: AIA billing is available on every deal (Karan 2026-08 —
  // nothing locked). A bid simply has no applications yet.

  const dealName = derivedOppName(opp, account.company_name);
  const b = base(id, dealId);

  // Hidden fields shared by all forms (account + deal + app context).
  const ctx = (
    <>
      <input type="hidden" name="account_id" value={id} />
      <input type="hidden" name="opp_id" value={dealId} />
      <input type="hidden" name="back" value={sp.back ?? ""} />
    </>
  );

  const selectedAppId = typeof sp.app === "string" && UUID_RE.test(sp.app) ? sp.app : null;

  return (
    <div className={variant === "inline" ? "space-y-4" : "max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4"}>
      {variant === "route" && (
        <>
          <ToolBackHeader accountId={id} dealId={dealId} accountName={account.company_name} dealName={dealName} back={sp.back} />
          <div>
            <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">AIA Billing</h1>
            <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">
              {dealName} · <span className="font-medium">{oppStatusDisplayLabel(opp.status, opp.sub_status)}</span> · G702 / G703 progress billing
            </p>
          </div>
        </>
      )}

      {sp.error && !selectedAppId && (
        <div className="rounded-lg px-4 py-3 text-sm bg-rose-50 border border-rose-200 text-rose-700">{sp.error}</div>
      )}

      {/* R5 billing signpost — the AIA application certifies work completed; the
          actual money requests are Invoices. Cross-link back. */}
      <Link
        href={`/commercial/accounts/${id}?tab=projects&project=${dealId}&dt=invoices`}
        className="flex items-center gap-2.5 rounded-xl border border-cc-brand-200 bg-cc-brand-50/50 px-4 py-2.5 hover:bg-cc-brand-50 transition-colors"
      >
        <span aria-hidden className="inline-flex items-center justify-center h-7 w-7 rounded-lg bg-cc-brand-600 text-white shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2v20 M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
        </span>
        <span className="min-w-0 text-[12px] text-ppp-charcoal-600 flex-1">
          <span className="font-semibold text-ppp-charcoal">This certifies completed work.</span> The actual money requests are Invoices — record payments there.
        </span>
        <span className="shrink-0 text-[12px] font-semibold text-cc-brand-700 inline-flex items-center gap-0.5">Invoices<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 18l6-6-6-6" /></svg></span>
      </Link>

      {selectedAppId ? (
        await (async () => {
          const application = await getAiaApplication(selectedAppId);
          if (!application || application.opportunity_id !== dealId) {
            // Stale / cross-deal app id — fall back to the list in place (no
            // redirect, so it stays graceful inline just like Closeout).
            return <AiaApplicationList id={id} dealId={dealId} back={sp.back ?? ""} createAction={createApplicationAction} />;
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
                back={sp.back ?? ""}
                lines={lines}
                g702={g702!}
                basePath={b}
                exportHref={`/api/commercial/aia/${selectedAppId}/export`}
                editable={application.status === "draft"}
                upsertLineAction={upsertLineAction}
                saveLineAutosaveAction={saveLineAutosaveAction}
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
                <AiaSettingsForm
                  appId={selectedAppId}
                  accountId={id}
                  dealId={dealId}
                  saveAction={saveSettingsAutosaveAction}
                  initial={{
                    period_from: application.period_from?.slice(0, 10) ?? "",
                    period_to: application.period_to?.slice(0, 10) ?? "",
                    original_contract: (application.original_contract_cents / 100).toFixed(2),
                    retainage_pct: String(Number(application.retainage_pct)),
                    notes: application.notes ?? "",
                  }}
                />
                {/* Delete stays a separate, explicit + confirmed action. */}
                <form action={deleteApplicationAction} className="px-4 pb-4 pt-0 flex justify-end">
                  {ctx}
                  <input type="hidden" name="app_id" value={selectedAppId} />
                  <ConfirmSubmitButton
                    message={`Delete Application No. ${application.application_number}? This can't be undone.`}
                    pendingLabel="Deleting…"
                    className="px-3.5 py-2 rounded-lg text-[12px] font-medium text-ppp-charcoal-400 hover:text-rose-700 hover:bg-rose-50 min-h-[44px]"
                  >
                    Delete application
                  </ConfirmSubmitButton>
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
          back={sp.back ?? ""}
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
  back = "",
  createAction,
}: {
  id: string;
  dealId: string;
  back?: string;
  createAction: (fd: FormData) => void | Promise<void>;
}) {
  const [applications, netCO, baseContract] = await Promise.all([
    listAiaApplications(dealId),
    netApprovedChangeOrderCents(dealId),
    getEffectiveContractBaseCents(dealId),
  ]);
  const baseContractCents = baseContract > 0 ? baseContract : null;
  const contractToDateCents = baseContractCents != null ? baseContractCents + netCO : null;
  const submittedCount = applications.filter((a) => a.status === "submitted").length;
  const paidCount = applications.filter((a) => a.status === "paid").length;
  // Billed-of-contract: the LATEST application's G702 line-4 "completed & stored
  // to date" as a % of the contract to date (the running billing progress).
  const latestApp = applications.length > 0 ? [...applications].sort((a, b) => b.application_number - a.application_number)[0] : null;
  const latestG702 = latestApp ? await resolveG702(latestApp.id) : null;
  const completedToDateCents = latestG702?.totalCompletedStoredCents ?? 0;
  const billedPct = contractToDateCents && contractToDateCents > 0 ? Math.min(100, Math.round((completedToDateCents / contractToDateCents) * 100)) : null;
  const appsHint = applications.length === 0
    ? "None yet"
    : [paidCount > 0 ? `${paidCount} paid` : null, submittedCount > 0 ? `${submittedCount} submitted` : null]
        .filter(Boolean).join(" · ") || undefined;
  return (
    <div className="space-y-3">
      {/* ── Contract summary strip — renders even with zero applications so the
          page isn't a wall of white. Mirrors the Change Orders panel. ── */}
      <section className="bg-gradient-to-br from-cc-brand-50/60 to-surface border border-cc-brand-100 rounded-xl p-4 sm:p-5">
        <div className="flex items-center gap-2 mb-3">
          <span aria-hidden className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-cc-brand-600 text-white">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M9 13h6 M9 17h6" /></svg>
          </span>
          <div>
            <h2 className="text-sm font-bold text-ppp-charcoal leading-tight">Contract to date</h2>
            <p className="text-[11px] text-ppp-charcoal-500 leading-snug">The base contract plus approved change orders — what each G702 certifies against.</p>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <AiaSummaryTile label="Original contract" value={baseContractCents != null ? formatCentsFull(baseContractCents) : "—"} hint={baseContractCents == null ? "No bid set" : undefined} />
          <AiaSummaryTile label="Net approved COs" value={netCO === 0 ? formatCentsFull(0) : `${netCO < 0 ? "−" : "+"}${formatCentsFull(Math.abs(netCO))}`} tone={netCO < 0 ? "rose" : netCO > 0 ? "emerald" : "neutral"} />
          <AiaSummaryTile label="Contract to date" value={contractToDateCents != null ? formatCentsFull(contractToDateCents) : "—"} emphasize />
          <AiaSummaryTile label="Applications" value={String(applications.length)} hint={appsHint} />
        </div>
        {applications.length > 0 && (
          <div className="mt-4 pt-4 border-t border-ppp-charcoal-100 grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <DonutChart
              size={116}
              segments={[
                { label: "Paid", value: paidCount, tone: "emerald", valueLabel: String(paidCount) },
                { label: "Submitted", value: submittedCount, tone: "blue", valueLabel: String(submittedCount) },
                { label: "Draft", value: Math.max(0, applications.length - submittedCount - paidCount), tone: "neutral", valueLabel: String(Math.max(0, applications.length - submittedCount - paidCount)) },
              ]}
              centerValue={String(applications.length)}
              centerLabel={applications.length === 1 ? "application" : "applications"}
            />
            <div className="flex items-center gap-4 justify-center">
              <GaugeRing pct={billedPct ?? 0} tone={billedPct === null ? "neutral" : billedPct >= 100 ? "emerald" : "blue"} value={billedPct === null ? "—" : `${billedPct}%`} label="billed" size={104} />
              <div className="min-w-0 text-[12px] space-y-1">
                <div><span className="text-ppp-charcoal-500">Completed to date: </span><strong className="tabular-nums text-ppp-charcoal">{formatCentsFull(completedToDateCents)}</strong></div>
                <div><span className="text-ppp-charcoal-500">Contract to date: </span><strong className="tabular-nums text-ppp-charcoal">{contractToDateCents != null ? formatCentsFull(contractToDateCents) : "—"}</strong></div>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-3">Payment applications</h2>
        {applications.length === 0 ? (
          <p className="text-[12px] text-ppp-charcoal-500 mb-3">No applications yet. Start the first billing period below.</p>
        ) : (
          <ul className="space-y-2 mb-4">
            {applications.map((a) => (
              <li key={a.id}>
                <Link
                  href={`${base(id, dealId)}&app=${a.id}`}
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
                    : "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200"
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
          <input type="hidden" name="back" value={back} />
          <div>
            <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Period to</span>
            <DateField name="period_to" placeholder="Pick a date" />
          </div>
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

function AiaSummaryTile({
  label,
  value,
  hint,
  tone = "neutral",
  emphasize = false,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "emerald" | "rose";
  emphasize?: boolean;
}) {
  const valueCls = tone === "emerald" ? "text-emerald-700" : tone === "rose" ? "text-rose-700" : "text-ppp-charcoal";
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${emphasize ? "border-cc-brand-300 bg-surface" : "border-ppp-charcoal-100 bg-surface/70"}`}>
      <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-lg sm:text-xl font-black tabular-nums leading-none mt-0.5 ${valueCls}`}>{value}</div>
      {hint && <div className="text-[10px] text-ppp-charcoal-500 mt-0.5">{hint}</div>}
    </div>
  );
}
