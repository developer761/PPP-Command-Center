/**
 * AIA progress billing — account-scoped page (Phase H2). Lists the payment
 * applications for a post-sale project and, when one is selected (?app=),
 * shows its G702 certificate summary + editable G703 schedule of values.
 * Same account-scoped pattern + drawer-reopening back link as Change Orders.
 */
import Link from "next/link";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/kanban-columns";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { getAiaLienWaiver } from "@/lib/commercial/aia/lien-waiver";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
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
  reconcileDraftChangeOrderRows,
  getEffectiveContractBaseCents,
  aiaBillingRollupBulk,
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
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { toolOriginQs } from "@/lib/commercial/tool-origin";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<{ app?: string; error?: string; ok?: string; back?: string; from?: string }>;

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
function base(id: string, dealId: string, origin?: string, from?: string): string {
  // Return you to WHERE you are — standalone tool when opened directly, the
  // account's deal (Project sub-tab) view when embedded there. Never jump.
  // `from` (overview/docs/activity) rides along so the page back arrow returns
  // to the tab the tool was opened from, even after a save.
  return `/commercial/opportunities/${dealId}?tab=project&sub=aia${toolOriginQs(from)}`;
}
function backQ(back: string): string {
  return back && back.startsWith("/commercial/post-job/") ? `&back=${encodeURIComponent(back)}` : "";
}
function revalidateAia(id: string, dealId: string) {
  revalidatePath(`/commercial/opportunities/${dealId}`);
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
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
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
  if (!result.ok) redirect(`${base(id, dealId, origin, from)}&error=${encodeURIComponent(result.error)}${backQ(back)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId, origin, from)}&app=${result.value.id}${backQ(back)}`);
}

/**
 * Bill the retainage — the Application for Final Payment.
 *
 * Stephanie 2026-08-17: "we need to bill for the retainage, they always pay it
 * separately and months after the job is finished."
 *
 * It is an ordinary application with retainage at 0%, which is what a G702
 * final payment IS: the schedule of values carries forward untouched, line 5
 * drops to nothing, and line 8 comes out as exactly the retainage held. Same
 * math, same carry-forward, no second money path to reconcile.
 */
async function billRetainageAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) redirect("/commercial/accounts");
  if (!(await ownsAiaContext(id, dealId))) redirect("/commercial/accounts");
  const result = await createAiaApplication({
    opportunity_id: dealId,
    is_retainage_release: true,
    // Retainage is released months later, so the period ends today rather than
    // inheriting whenever the last requisition closed.
    period_to: toEtNoon(new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" })),
    created_by_user_id: userId,
  });
  if (!result.ok) {
    // The unique index is the backstop for a double-click or two people at
    // once; say what happened rather than surfacing a Postgres error.
    const msg = /one_retainage_release|duplicate key/i.test(result.error)
      ? "The retainage has already been billed on this job."
      : result.error;
    redirect(`${base(id, dealId, origin, from)}&error=${encodeURIComponent(msg)}${backQ(back)}`);
  }
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId, origin, from)}&app=${result.value.id}${backQ(back)}`);
}

async function updateApplicationAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
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
  if (!result.ok) redirect(`${base(id, dealId, origin, from)}&app=${appId}&error=${encodeURIComponent(result.error)}${backQ(back)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId, origin, from)}&app=${appId}${backQ(back)}`);
}

/** Non-redirecting variant of updateApplicationAction for the autosaving
 *  settings panel. Returns {ok,error} so the client can show Saved in place. */
async function saveSettingsAutosaveAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
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
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  const status = String(formData.get("status") ?? "") as AiaApplicationStatus;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId)) redirect("/commercial/accounts");
  if (!(await ownsAiaContext(id, dealId, appId))) redirect("/commercial/accounts");
  if (!["draft", "submitted", "paid"].includes(status)) redirect(`${base(id, dealId, origin, from)}&app=${appId}${backQ(back)}`);
  // Issuing freezes lines 1+2. Reconcile the draft's schedule of values FIRST so
  // any change order approved since it was seeded is on the G703 before it
  // freezes — otherwise the issued certificate is frozen already not footing
  // (audit F2). No-op if it's already issued.
  if (status !== "draft") await reconcileDraftChangeOrderRows(appId);
  const result = await updateAiaApplication(appId, { status }, userId);
  if (!result.ok) redirect(`${base(id, dealId, origin, from)}&app=${appId}&error=${encodeURIComponent(result.error)}${backQ(back)}`);
  // Auto-file the G702/G703 workbook when the application is submitted to the GC
  // (best-effort — never blocks the status change).
  if (status === "submitted") await autoFileAiaApplication(id, dealId, appId, userId);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId, origin, from)}&app=${appId}${backQ(back)}`);
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
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId)) redirect("/commercial/accounts");
  if (!(await ownsAiaContext(id, dealId, appId))) redirect("/commercial/accounts");
  const result = await deleteAiaApplication(appId, userId);
  if (!result.ok) redirect(`${base(id, dealId, origin, from)}&error=${encodeURIComponent(result.error)}${backQ(back)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId, origin, from)}${backQ(back)}`);
}

async function upsertLineAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
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
  if (!result.ok) redirect(`${base(id, dealId, origin, from)}&app=${appId}&error=${encodeURIComponent(result.error)}${backQ(back)}`);
  revalidateAia(id, dealId);
  redirect(`${base(id, dealId, origin, from)}&app=${appId}${backQ(back)}`);
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
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
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
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const appId = String(formData.get("app_id") ?? "");
  const lineId = String(formData.get("line_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(appId) || !UUID_RE.test(lineId)) redirect("/commercial/accounts");
  if (!(await ownsAiaContext(id, dealId, appId))) redirect("/commercial/accounts");
  // A swallowed failure here leaves the payment application's total wrong while
  // the row appears to have gone.
  const res = await deleteAiaLineItem(lineId, appId, userId);
  revalidateAia(id, dealId);
  if (!res.ok) {
    redirect(
      `${base(id, dealId, origin, from)}&app=${appId}&error=${encodeURIComponent(res.error ?? "Could not remove that line.")}${backQ(back)}`
    );
  }
  redirect(`${base(id, dealId, origin, from)}&app=${appId}${backQ(back)}`);
}

export type AiaSP = { app?: string; error?: string; ok?: string; back?: string; from?: string };
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
  const b = base(id, dealId, variant, sp.from ?? "");

  // Hidden fields shared by all forms (account + deal + app context + origin so
  // an action returns you here, not to the account page).
  const ctx = (
    <>
      <input type="hidden" name="account_id" value={id} />
      <input type="hidden" name="opp_id" value={dealId} />
      <input type="hidden" name="back" value={sp.back ?? ""} />
      <input type="hidden" name="from" value={sp.from ?? ""} />
      <input type="hidden" name="origin" value={variant} />
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
        href={`/commercial/opportunities/${dealId}?tab=invoices`}
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
            return <AiaApplicationList id={id} dealId={dealId} back={sp.back ?? ""} origin={variant} createAction={createApplicationAction} />;
          }
          // A draft tracks the deal: fold in any change orders approved since it
          // was seeded so its two sheets foot before we render/export it (audit
          // F2). No-op on an issued (frozen) certificate.
          if (application.status === "draft") {
            await reconcileDraftChangeOrderRows(selectedAppId);
          }
          const [lines, g702, lienWaiver] = await Promise.all([
            listAiaLineItems(selectedAppId),
            resolveG702(selectedAppId),
            // Stephanie 2026-08-20: "Add lien waiver option to AIA billing just
            // as it is under the invoicing."
            getAiaLienWaiver(selectedAppId).catch(() => null),
          ]);
          return (
            <>
              <AiaApplicationDetail
                application={application}
                accountId={id}
                dealId={dealId}
                back={sp.back ?? ""}
                from={sp.from ?? ""}
                origin={variant}
                lines={lines}
                g702={g702!}
                basePath={b}
                exportHref={`/api/commercial/aia/${selectedAppId}/export`}
                lienWaiver={lienWaiver}
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
          from={sp.from ?? ""}
          origin={variant}
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
  from = "",
  origin = "",
  createAction,
}: {
  id: string;
  dealId: string;
  back?: string;
  from?: string;
  origin?: string;
  createAction: (fd: FormData) => void | Promise<void>;
}) {
  const [applications, netCO, baseContract, billing] = await Promise.all([
    listAiaApplications(dealId),
    netApprovedChangeOrderCents(dealId),
    getEffectiveContractBaseCents(dealId),
    // The SAME rollup the dashboard, AR aging and the GC statement use, so this
    // page can't disagree with them about what's billed or owed.
    aiaBillingRollupBulk([dealId]).then((m) => m.get(dealId) ?? null),
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
  // Certificates issued since the freeze shipped hold their own figures, so the
  // strip above them can legitimately disagree. Say so rather than letting it
  // read as two numbers for the same thing.
  const frozenCount = applications.filter((a) => a.status !== "draft" && a.frozen_at != null).length;
  const appsHint = applications.length === 0
    ? "None yet"
    : [paidCount > 0 ? `${paidCount} paid` : null, submittedCount > 0 ? `${submittedCount} submitted` : null]
        .filter(Boolean).join(" · ") || undefined;
  // ── What to do next ──────────────────────────────────────────────────
  // Stephanie: "This entire section is kind of cumbersome and unorganized."
  // Every other surface here tells you the next move; AIA didn't. Ordered by
  // what actually blocks progress.
  const draftApp = [...applications].sort((a, b) => b.application_number - a.application_number)
    .find((a) => a.status === "draft");
  const awaitingPayment = applications.filter((a) => a.status === "submitted");
  const fullyBilled =
    contractToDateCents != null && contractToDateCents > 0 && completedToDateCents >= contractToDateCents;
  // The retainage release (Application for Final Payment). One per job — see
  // the unique index in migration 162.
  const releaseApp = applications.find((a) => a.is_retainage_release) ?? null;
  const nextStep: { text: string; tone: "todo" | "active" | "done" } =
    applications.length === 0
      ? { text: "Start Application No. 1 for the first billing period.", tone: "todo" }
      : draftApp
      ? { text: `Application No. ${draftApp.application_number} is still a draft — enter this period's work, then submit it to the GC.`, tone: "active" }
      : awaitingPayment.length > 0
      ? { text: `${awaitingPayment.length === 1 ? `Application No. ${awaitingPayment[0].application_number} is` : `${awaitingPayment.length} applications are`} with the GC. Record the payment when it arrives.`, tone: "active" }
      : fullyBilled && !releaseApp
      // This used to read "Retainage is released at close-out" — describing
      // something the platform could not do. There is a button for it now.
      ? { text: "Fully billed. The retainage is still held — bill it when the GC is ready to release it.", tone: "todo" }
      : fullyBilled
      ? { text: "Fully billed and the retainage has been billed. Nothing further to requisition.", tone: "done" }
      : { text: "Everything so far is paid. Start the next application when the period closes.", tone: "todo" };

  const billedCents = billing?.billedCents ?? completedToDateCents;
  const retainageHeldCents = billing?.retainageHeldCents ?? 0;
  const dueNowCents = billing?.dueNowCents ?? 0;
  const leftToBillCents =
    contractToDateCents != null ? Math.max(0, contractToDateCents - billedCents) : null;

  return (
    <div className="space-y-3">
      {/* ── 1. WHERE THIS JOB STANDS ──────────────────────────────────────
          Was a gradient hero carrying four tiles PLUS a donut counting
          applications by status PLUS a gauge repeating "% billed" PLUS a text
          line repeating "contract to date" — analytics on a number that is
          usually 3, and the same figure printed twice. None of it answered the
          questions a billing person opens this page with. These five do. ── */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
          <h2 className="text-sm font-bold text-ppp-charcoal">Where this job stands</h2>
          {billedPct !== null && (
            <span className="text-[11.5px] text-ppp-charcoal-500 tabular-nums">{billedPct}% billed</span>
          )}
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <AiaSummaryTile
            label="Contract to date"
            value={contractToDateCents != null ? formatCentsFull(contractToDateCents) : "—"}
            hint={
              baseContractCents == null
                ? "No bid set"
                : netCO !== 0
                ? `base ${formatCentsFull(baseContractCents)} ${netCO < 0 ? "−" : "+"} COs ${formatCentsFull(Math.abs(netCO))}`
                : "base contract"
            }
            emphasize
          />
          <AiaSummaryTile
            label="Billed to date"
            value={formatCentsFull(billedCents)}
            hint={leftToBillCents != null ? `${formatCentsFull(leftToBillCents)} left to bill` : undefined}
          />
          <AiaSummaryTile
            label="Owed now"
            value={formatCentsFull(dueNowCents)}
            tone={dueNowCents > 0 ? "rose" : "neutral"}
            hint={dueNowCents > 0 ? "certified, not yet paid" : "nothing outstanding"}
          />
          {/* Stephanie 2026-08-17: "when I pay all AIA's, where does it show
              that the retainage is outstanding?" Here — but the hint said
              "released at close-out", which described it as something that
              happens on its own. It doesn't: it is billed on the final payment
              application, and until then it is money earned and not yet asked
              for. The tile now says which of those it is. */}
          <AiaSummaryTile
            label="Retainage held"
            value={formatCentsFull(retainageHeldCents)}
            tone={retainageHeldCents > 0 && !releaseApp ? "rose" : "neutral"}
            hint={
              retainageHeldCents <= 0
                ? "none held"
                : releaseApp
                  ? `billed on Application No. ${releaseApp.application_number}`
                  : "earned, not yet billed"
            }
          />
        </div>
        {billedPct !== null && (
          <div className="mt-3 h-1.5 rounded-full bg-ppp-charcoal-100 overflow-hidden" aria-hidden>
            <div
              className={`h-full rounded-full ${billedPct >= 100 ? "bg-emerald-500" : "bg-cc-brand-500"}`}
              style={{ width: `${Math.min(100, billedPct)}%` }}
            />
          </div>
        )}
        {frozenCount > 0 && (
          <p className="text-[11px] text-ppp-charcoal-500 mt-2.5 leading-snug">
            An issued certificate keeps the figures it was sent with, so it can read lower than the
            contract above — that difference is the change orders approved since, and they belong on
            the next application.
          </p>
        )}
      </section>

      {/* ── 2. WHAT TO DO NEXT ──────────────────────────────────────────── */}
      <section
        className={`rounded-xl border px-4 py-3 flex items-start gap-2.5 ${
          nextStep.tone === "active"
            ? "border-amber-200 bg-amber-50"
            : nextStep.tone === "done"
            ? "border-emerald-200 bg-emerald-50"
            : "border-ppp-charcoal-200 bg-ppp-charcoal-50"
        }`}
      >
        <span
          aria-hidden
          className={`mt-0.5 inline-block h-2 w-2 rounded-full shrink-0 ${
            nextStep.tone === "active" ? "bg-amber-500" : nextStep.tone === "done" ? "bg-emerald-500" : "bg-ppp-charcoal-400"
          }`}
        />
        <div className="min-w-0">
          <span className="block text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
            Next step
          </span>
          <span className="block text-[13px] text-ppp-charcoal mt-0.5">{nextStep.text}</span>
        </div>
      </section>

      {/* ── 3. THE APPLICATIONS ────────────────────────────────────────────
          Newest first — the one being worked on is the one you came for. Rows
          now carry MONEY: a billing list where every row was just a number, a
          date and a pill meant she had to open each one to find out what it
          was worth. ── */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
          <h2 className="text-sm font-bold text-ppp-charcoal">Payment applications</h2>
          {applications.length > 0 && (
            <span className="text-[11.5px] text-ppp-charcoal-500">
              {applications.length} total{appsHint ? ` · ${appsHint}` : ""}
            </span>
          )}
        </div>

        {applications.length === 0 ? (
          <div className="text-[12px] text-ppp-charcoal-500 mb-3 space-y-1">
            <p>No applications yet. AIA billing runs one application per billing period.</p>
            {/* The other half of the decision — see the matching note on the
                Invoices tab. Whichever tab she lands on first, she learns the
                choice exists. */}
            <p>
              <strong className="text-ppp-charcoal-700">Only if the GC requires it.</strong> AIA is
              the G702/G703 certificate process, usually on larger jobs with retainage. If this GC
              just wants a bill, use the Invoices tab instead — a job uses one or the other, never
              both.
            </p>
            <p>
              <strong className="text-ppp-charcoal-700">How it works:</strong> create the application
              for this period &rarr; enter the work completed &rarr; send the G702/G703 to the GC
              &rarr; record their payment. Each one carries forward from the last.
            </p>
          </div>
        ) : (
          <ul className="space-y-2 mb-4">
            {[...applications]
              .sort((a, b) => b.application_number - a.application_number)
              .map((a) => (
                <li key={a.id}>
                  <Link
                    href={`${base(id, dealId, origin, from)}&app=${a.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg border border-ppp-charcoal-100 px-3.5 py-2.5 hover:border-cc-brand-300 hover:bg-cc-brand-50/40 transition-colors min-h-[44px]"
                  >
                    <span className="min-w-0">
                      <span className="text-[13px] font-semibold text-ppp-charcoal">
                        Application No. {a.application_number}
                        {a.is_retainage_release && (
                          <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 bg-amber-100 text-amber-800 text-[10px] font-bold uppercase tracking-wide align-middle">
                            Retainage
                          </span>
                        )}
                      </span>
                      <span className="block text-[11px] text-ppp-charcoal-500">
                        {a.period_to ? `Period to ${fmtEtDate(a.period_to)}` : "No period set"}
                        {a.retainage_pct ? ` · ${a.retainage_pct}% retainage` : ""}
                      </span>
                    </span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold shrink-0 ${
                        AIA_STATUS_META[a.status].tone === "emerald"
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : AIA_STATUS_META[a.status].tone === "ppp-blue"
                          ? "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200"
                          : "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200"
                      }`}
                    >
                      {AIA_STATUS_META[a.status].label}
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        )}

        {/* Once a job has applications, the create form is not what you came
            for — it was a permanently-open dashed box under the list. Folded
            away, and left open on a job with none. */}
        <details open={applications.length === 0} className="group">
          <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-cc-brand-200 bg-cc-brand-50 text-[12px] font-semibold text-cc-brand-700 hover:bg-cc-brand-100 min-h-[44px]">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="group-open:rotate-45 transition-transform">
              <path d="M12 5v14 M5 12h14" />
            </svg>
            New application
          </summary>
          <form action={createAction} className="mt-2.5 rounded-lg border border-dashed border-cc-brand-200 p-3.5 grid sm:grid-cols-3 gap-3 items-end">
            <input type="hidden" name="account_id" value={id} />
            <input type="hidden" name="opp_id" value={dealId} />
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="from" value={from} />
            <input type="hidden" name="origin" value={origin} />
            <div>
              <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Period to</span>
              <DateField ariaLabel="Period to date" name="period_to" placeholder="Pick a date" />
            </div>
            <label className="block">
              <span className="block text-[11px] font-semibold text-ppp-charcoal-600 mb-1">Retainage (%)</span>
              <input name="retainage_pct" inputMode="decimal" defaultValue={String(DEFAULT_RETAINAGE_PCT)} className={INPUT} />
            </label>
            <PendingSubmitButton pendingLabel="Creating…" className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">
              Create application
            </PendingSubmitButton>
          </form>
        </details>

        {/* Bill the retainage — Stephanie 2026-08-17: "they always pay it
            separately and months after the job is finished."

            Only once there IS retainage held and it hasn't been released, so
            this is absent on a job with no retainage and disappears the moment
            it is billed. It is a separate control rather than a checkbox on
            the form above because it takes no inputs: the period is today and
            the percentage is necessarily zero. */}
        {retainageHeldCents > 0 && !releaseApp && (
          <form action={billRetainageAction} className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3.5 flex flex-col sm:flex-row sm:items-center gap-3">
            <input type="hidden" name="account_id" value={id} />
            <input type="hidden" name="opp_id" value={dealId} />
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="from" value={from} />
            <input type="hidden" name="origin" value={origin} />
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-ppp-charcoal">
                Retainage held: {formatCentsFull(retainageHeldCents)}
              </div>
              <p className="text-[11.5px] text-ppp-charcoal-600 mt-0.5">
                Bills it as the Application for Final Payment — the schedule of values carries
                forward, retainage drops to 0%, and the payment due comes out as the amount held.
              </p>
            </div>
            <ConfirmSubmitButton
              message="Create the Application for Final Payment to bill the held retainage?"
              pendingLabel="Creating…"
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-amber-600 text-white text-[12px] font-semibold hover:bg-amber-700 min-h-[44px] shrink-0"
            >
              Bill the retainage
            </ConfirmSubmitButton>
          </form>
        )}
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
