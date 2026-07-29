/**
 * Closeout & Warranty — account-scoped project page. Lists close-out packages
 * for a post-sale project; a selected one (?pkg=) shows its transmittal cover,
 * warranty term, and the close-out checklist. Same account-scoped pattern +
 * ProjectToolbar as Change Orders / AIA.
 */
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { isPostSaleProject, oppStatusDisplayLabel } from "@/lib/commercial/opportunities/constants";
import { fmtEtDate } from "@/lib/commercial/invoices/format";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  listCloseoutPackages,
  getCloseoutPackage,
  listCloseoutItems,
  createCloseoutPackage,
  updateCloseoutPackage,
  changeCloseoutStatus,
  upsertCloseoutItem,
  deleteCloseoutItem,
  deleteCloseoutPackage,
} from "@/lib/commercial/closeout/db";
import {
  CLOSEOUT_STATUS_META,
  CLOSEOUT_ITEM_KIND_LABEL,
  CLOSEOUT_ITEM_STATUS_LABEL,
  CLOSEOUT_TRANSMITTED_AS,
  CLOSEOUT_TRANSMITTED_AS_LABEL,
  ALLOWED_CLOSEOUT_TRANSITIONS,
  computeWarrantyEndDate,
  closeoutProgressPct,
  isCloseoutEditable,
  isCloseoutItemStatusEditable,
  type CloseoutItemKind,
  type CloseoutItemStatus,
  type CloseoutStatus,
  type CloseoutTransmittedAs,
} from "@/lib/commercial/closeout/constants";
import { ProjectToolbar } from "@/components/commercial/project-toolbar";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { INPUT_CLS, TEXTAREA_CLS, SELECT_CLS, SELECT_BG_STYLE, LABEL_CLS } from "@/lib/commercial/form-classnames";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<{ pkg?: string; error?: string; ok?: string }>;

async function requireUser(): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return user.id;
}
function base(id: string, dealId: string) {
  return `/commercial/accounts/${id}/closeout/${dealId}`;
}
function revalidateCloseout(id: string, dealId: string) {
  revalidatePath(base(id, dealId));
  revalidatePath(`/commercial/accounts/${id}`);
  revalidatePath("/commercial/post-job/closeout");
}
function ymd(raw: string): string | null {
  const s = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
/** Verify the posted package actually belongs to this account + deal before
 *  mutating (defense-in-depth so a forged pkg_id can't revalidate/mutate under
 *  the wrong account's context). Returns false on mismatch. */
async function pkgBelongs(pkgId: string, id: string, dealId: string): Promise<boolean> {
  const p = await getCloseoutPackage(pkgId);
  return !!p && p.account_id === id && p.opportunity_id === dealId;
}

// ── Server actions ──────────────────────────────────────────────────
async function createPackageAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) redirect("/commercial/accounts");
  const res = await createCloseoutPackage({ opportunity_id: dealId, created_by_user_id: userId });
  if (!res.ok) redirect(`${base(id, dealId)}?error=${encodeURIComponent(res.error)}`);
  revalidateCloseout(id, dealId);
  redirect(`${base(id, dealId)}?pkg=${res.value.id}`);
}

async function updateCoverAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const pkgId = String(formData.get("pkg_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(pkgId)) redirect("/commercial/accounts");
  if (!(await pkgBelongs(pkgId, id, dealId))) redirect("/commercial/accounts");
  const taRaw = String(formData.get("transmitted_as") ?? "").trim();
  const transmitted_as = (CLOSEOUT_TRANSMITTED_AS as readonly string[]).includes(taRaw)
    ? (taRaw as CloseoutTransmittedAs)
    : null;
  const yrsRaw = Number(String(formData.get("warranty_years") ?? "2"));
  const res = await updateCloseoutPackage(
    pkgId,
    {
      to_company: String(formData.get("to_company") ?? "").trim() || null,
      to_attention: String(formData.get("to_attention") ?? "").trim() || null,
      to_address_lines: String(formData.get("to_address_lines") ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
      re_subject: String(formData.get("re_subject") ?? "").trim() || null,
      transmitted_as,
      remarks: String(formData.get("remarks") ?? "").trim() || null,
      substantial_completion_date: ymd(String(formData.get("substantial_completion_date") ?? "")),
      warranty_years: Number.isFinite(yrsRaw) && yrsRaw >= 0 && yrsRaw <= 20 ? Math.round(yrsRaw) : 2,
    },
    userId
  );
  if (!res.ok) redirect(`${base(id, dealId)}?pkg=${pkgId}&error=${encodeURIComponent(res.error)}`);
  revalidateCloseout(id, dealId);
  redirect(`${base(id, dealId)}?pkg=${pkgId}&ok=1`);
}

async function changeStatusAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const pkgId = String(formData.get("pkg_id") ?? "");
  const to = String(formData.get("to") ?? "") as CloseoutStatus;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(pkgId)) redirect("/commercial/accounts");
  if (!(await pkgBelongs(pkgId, id, dealId))) redirect("/commercial/accounts");
  const res = await changeCloseoutStatus(pkgId, to, userId);
  if (!res.ok) redirect(`${base(id, dealId)}?pkg=${pkgId}&error=${encodeURIComponent(res.error)}`);
  revalidateCloseout(id, dealId);
  redirect(`${base(id, dealId)}?pkg=${pkgId}`);
}

async function upsertItemAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const pkgId = String(formData.get("pkg_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(pkgId)) redirect("/commercial/accounts");
  if (!(await pkgBelongs(pkgId, id, dealId))) redirect("/commercial/accounts");
  const itemId = String(formData.get("item_id") ?? "").trim();
  const res = await upsertCloseoutItem(
    {
      id: itemId && UUID_RE.test(itemId) ? itemId : undefined,
      package_id: pkgId,
      kind: String(formData.get("kind") ?? "other") as CloseoutItemKind,
      label: String(formData.get("label") ?? "").trim() || null,
      included: String(formData.get("included") ?? "") === "on" || String(formData.get("included") ?? "") === "true",
      item_status: (String(formData.get("item_status") ?? "pending") as CloseoutItemStatus),
      notes: String(formData.get("notes") ?? "").trim() || null,
    },
    userId
  );
  if (!res.ok) redirect(`${base(id, dealId)}?pkg=${pkgId}&error=${encodeURIComponent(res.error)}`);
  revalidateCloseout(id, dealId);
  redirect(`${base(id, dealId)}?pkg=${pkgId}`);
}

async function deleteItemAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const pkgId = String(formData.get("pkg_id") ?? "");
  const itemId = String(formData.get("item_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(pkgId) || !UUID_RE.test(itemId)) redirect("/commercial/accounts");
  if (!(await pkgBelongs(pkgId, id, dealId))) redirect("/commercial/accounts");
  await deleteCloseoutItem(itemId, pkgId, userId);
  revalidateCloseout(id, dealId);
  redirect(`${base(id, dealId)}?pkg=${pkgId}`);
}

async function deletePackageAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const pkgId = String(formData.get("pkg_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(pkgId)) redirect("/commercial/accounts");
  if (!(await pkgBelongs(pkgId, id, dealId))) redirect("/commercial/accounts");
  const res = await deleteCloseoutPackage(pkgId, userId);
  if (!res.ok) redirect(`${base(id, dealId)}?pkg=${pkgId}&error=${encodeURIComponent(res.error)}`);
  revalidateCloseout(id, dealId);
  redirect(base(id, dealId));
}

// ── Page ────────────────────────────────────────────────────────────
export default async function CloseoutPage({ params, searchParams }: { params: PP; searchParams: SP }) {
  await requireUser();
  const { id, dealId } = await params;
  const sp = await searchParams;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();

  const [account, opp] = await Promise.all([getCommercialAccount(id), getCommercialOpportunity(dealId)]);
  if (!account || !opp) notFound();
  if (opp.account_id !== id) notFound();
  // Close-out is a post-award activity. Explain the gate instead of a silent
  // bounce (2026-07-29 re-audit: the redirect fired with no message, so the
  // page read as "broken").
  if (!isPostSaleProject(opp)) {
    redirect(
      `/commercial/accounts/${id}?tab=opportunities&edit=${dealId}&status_error=${encodeURIComponent(
        "Close-out opens once this deal is Won and in delivery — mark it Won first."
      )}`
    );
  }

  const dealName = derivedOppName(opp, account.company_name);
  const packages = await listCloseoutPackages(dealId);
  const selectedId = typeof sp.pkg === "string" && UUID_RE.test(sp.pkg) ? sp.pkg : packages[0]?.id ?? null;
  const pkg = selectedId ? await getCloseoutPackage(selectedId) : null;
  const activePkg = pkg && pkg.opportunity_id === dealId ? pkg : null;
  const items = activePkg ? await listCloseoutItems(activePkg.id) : [];
  const editable = activePkg ? isCloseoutEditable(activePkg.status) : false;
  // Issued but not closed → the cover + item set are frozen, but the checklist
  // stays live so docs can be ticked "Received" as they come in.
  const canTickItems = activePkg ? isCloseoutItemStatusEditable(activePkg.status) : false;
  const progress = closeoutProgressPct(items);
  const warrantyEnd = activePkg ? computeWarrantyEndDate(activePkg.substantial_completion_date, activePkg.warranty_years) : null;

  const Ctx = () => (
    <>
      <input type="hidden" name="account_id" value={id} />
      <input type="hidden" name="opp_id" value={dealId} />
      {activePkg && <input type="hidden" name="pkg_id" value={activePkg.id} />}
    </>
  );

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <div className="flex items-center gap-2 text-[12px] text-ppp-charcoal-500 flex-wrap">
        <Link href={`/commercial/accounts/${id}?tab=projects`} className="inline-flex items-center gap-1 hover:text-cc-brand-700 min-h-[32px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5 M12 19l-7-7 7-7" /></svg>
          {account.company_name} · Projects
        </Link>
        <span aria-hidden>/</span>
        <Link href={`/commercial/accounts/${id}?tab=projects&project=${dealId}`} className="text-ppp-charcoal-700 font-medium truncate hover:text-cc-brand-700 min-h-[32px] inline-flex items-center">{dealName}</Link>
      </div>

      <div>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Closeout &amp; Warranty</h1>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">{dealName} · <span className="font-medium">{oppStatusDisplayLabel(opp.status, opp.sub_status)}</span></p>
      </div>

      <ProjectToolbar accountId={id} dealId={dealId} active="closeout" />

      {sp.error && <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">{decodeURIComponent(sp.error)}</div>}
      {sp.ok && <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-[13px] text-emerald-800">Saved.</div>}

      {/* Package list + create */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {packages.map((p) => {
            const on = activePkg?.id === p.id;
            const meta = CLOSEOUT_STATUS_META[p.status];
            return (
              <Link key={p.id} href={`${base(id, dealId)}?pkg=${p.id}`} aria-current={on ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] font-semibold min-h-[36px] ${on ? "bg-cc-brand-50 border-cc-brand-300 text-cc-brand-800" : "bg-surface border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-cc-brand-50"}`}>
                Package · {meta.label}
              </Link>
            );
          })}
        </div>
        <form action={createPackageAction}>
          <input type="hidden" name="account_id" value={id} />
          <input type="hidden" name="opp_id" value={dealId} />
          <PendingSubmitButton className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation" pendingLabel="Creating…">
            + New close-out package
          </PendingSubmitButton>
        </form>
      </div>

      {!activePkg ? (
        <div className="text-center py-12 px-4 bg-surface border border-dashed border-ppp-charcoal-200 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No close-out package yet</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">Create one when the job wraps — it seeds the standard checklist (as-builts, O&amp;M, warranty, waivers, final invoice, COI) + the 2-year warranty term.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Status controls */}
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center px-2.5 py-1 rounded-full border text-[11px] font-bold uppercase tracking-wide ${
                activePkg.status === "complete" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                : activePkg.status === "voided" ? "bg-rose-50 text-rose-700 border-rose-200"
                : activePkg.status === "draft" ? "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200"
                : "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200"}`}>
                {CLOSEOUT_STATUS_META[activePkg.status].label}
              </span>
              {progress != null && <span className="text-[12px] text-ppp-charcoal-500 tabular-nums">{progress}% collected</span>}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {ALLOWED_CLOSEOUT_TRANSITIONS[activePkg.status].map((to) => (
                <form key={to} action={changeStatusAction}>
                  <Ctx />
                  <input type="hidden" name="to" value={to} />
                  <PendingSubmitButton
                    className={`inline-flex items-center px-3 py-1.5 rounded-lg text-[12px] font-semibold min-h-[40px] ${to === "voided" ? "border border-rose-300 text-rose-700 hover:bg-rose-50" : "bg-cc-brand-600 text-white hover:bg-cc-brand-700"}`}
                    pendingLabel="…"
                  >
                    {to === "sent" ? "Mark sent" : to === "acknowledged" ? "Mark acknowledged" : to === "complete" ? "Mark complete" : "Void"}
                  </PendingSubmitButton>
                </form>
              ))}
            </div>
          </div>

          {!editable && (
            <div className="bg-ppp-charcoal-50 border border-ppp-charcoal-200 rounded-lg px-4 py-2.5 text-[12px] text-ppp-charcoal-600">
              This package is <strong>{CLOSEOUT_STATUS_META[activePkg.status].label.toLowerCase()}</strong>.{" "}
              {canTickItems
                ? "The cover + item list are locked, but you can still mark items Received as documents come in. Void it to change the cover or add/remove items."
                : "It's closed and fully locked — void it and start a new one to make changes."}
            </div>
          )}

          {/* Warranty summary */}
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
            <h2 className="text-sm font-bold text-ppp-charcoal mb-2 flex items-center gap-2"><span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />Warranty</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-[12px]">
              <div><div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Substantial completion</div><div className="text-ppp-charcoal-800 tabular-nums mt-0.5">{activePkg.substantial_completion_date ? fmtEtDate(`${activePkg.substantial_completion_date}T12:00:00Z`) : "—"}</div></div>
              <div><div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Term</div><div className="text-ppp-charcoal-800 mt-0.5">{activePkg.warranty_years} year{activePkg.warranty_years === 1 ? "" : "s"}</div></div>
              <div><div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-400">Warranty through</div><div className="font-semibold text-emerald-700 tabular-nums mt-0.5">{warrantyEnd ? fmtEtDate(`${warrantyEnd}T12:00:00Z`) : "—"}</div></div>
            </div>
          </div>

          {/* Checklist */}
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
            <h2 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2"><span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />Close-out checklist</h2>
            <ul className="space-y-2">
              {items.map((it) => (
                <li key={it.id} className="border border-ppp-charcoal-100 rounded-lg p-3">
                  {editable ? (
                    <form action={upsertItemAction} className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2 items-center">
                      <Ctx />
                      <input type="hidden" name="item_id" value={it.id} />
                      <input type="hidden" name="kind" value={it.kind} />
                      <input type="hidden" name="label" value={it.label ?? ""} />
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-ppp-charcoal">{it.label || CLOSEOUT_ITEM_KIND_LABEL[it.kind]}</div>
                      </div>
                      <label className="inline-flex items-center gap-1.5 text-[12px] text-ppp-charcoal-600">
                        <input type="checkbox" name="included" defaultChecked={it.included} className="w-4 h-4 accent-cc-brand-600" /> Include
                      </label>
                      <div className="flex items-center gap-1.5">
                        <select name="item_status" defaultValue={it.item_status} className={`${SELECT_CLS} !min-h-[40px] !py-1 text-[12px] w-[7.5rem]`} style={SELECT_BG_STYLE}>
                          {(["pending", "received", "na"] as CloseoutItemStatus[]).map((s) => <option key={s} value={s}>{CLOSEOUT_ITEM_STATUS_LABEL[s]}</option>)}
                        </select>
                        <PendingSubmitButton className="px-2.5 py-1.5 rounded-md bg-ppp-charcoal text-white text-[11px] font-semibold min-h-[40px]" pendingLabel="…">Save</PendingSubmitButton>
                      </div>
                    </form>
                  ) : canTickItems ? (
                    // Issued (sent/acknowledged): the item set is frozen, but
                    // you can still tick it Received/N-A as docs arrive.
                    <form action={upsertItemAction} className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-center">
                      <Ctx />
                      <input type="hidden" name="item_id" value={it.id} />
                      <input type="hidden" name="kind" value={it.kind} />
                      <input type="hidden" name="label" value={it.label ?? ""} />
                      <input type="hidden" name="included" value={it.included ? "on" : ""} />
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-ppp-charcoal">{it.label || CLOSEOUT_ITEM_KIND_LABEL[it.kind]}{!it.included && <span className="ml-2 text-[10px] font-medium text-ppp-charcoal-400">(excluded)</span>}</div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <select name="item_status" defaultValue={it.item_status} className={`${SELECT_CLS} !min-h-[40px] !py-1 text-[12px] w-[7.5rem]`} style={SELECT_BG_STYLE}>
                          {(["pending", "received", "na"] as CloseoutItemStatus[]).map((s) => <option key={s} value={s}>{CLOSEOUT_ITEM_STATUS_LABEL[s]}</option>)}
                        </select>
                        <PendingSubmitButton className="px-2.5 py-1.5 rounded-md bg-ppp-charcoal text-white text-[11px] font-semibold min-h-[40px]" pendingLabel="…">Save</PendingSubmitButton>
                      </div>
                    </form>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[13px] font-semibold text-ppp-charcoal">{it.label || CLOSEOUT_ITEM_KIND_LABEL[it.kind]}{!it.included && <span className="ml-2 text-[10px] font-medium text-ppp-charcoal-400">(excluded)</span>}</div>
                      <span className={`text-[11px] font-semibold ${it.item_status === "received" ? "text-emerald-700" : it.item_status === "na" ? "text-ppp-charcoal-400" : "text-amber-700"}`}>{CLOSEOUT_ITEM_STATUS_LABEL[it.item_status]}</span>
                    </div>
                  )}
                  {editable && (
                    <form action={deleteItemAction} className="mt-1 text-right">
                      <Ctx /><input type="hidden" name="item_id" value={it.id} />
                      <ConfirmSubmitButton className="text-[11px] text-ppp-charcoal-400 hover:text-rose-600 min-h-[32px] inline-flex items-center" message="Remove this item?" pendingLabel="…">Remove</ConfirmSubmitButton>
                    </form>
                  )}
                </li>
              ))}
              {items.length === 0 && <li className="text-[12px] text-ppp-charcoal-400 italic">No items.</li>}
            </ul>
            {editable && (
              <details className="mt-3 group">
                <summary className="list-none cursor-pointer text-[12px] font-semibold text-cc-brand-700 min-h-[36px] inline-flex items-center gap-1">+ Add item</summary>
                <form action={upsertItemAction} className="mt-2 grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
                  <Ctx />
                  <label className="block"><span className={LABEL_CLS}>Kind</span>
                    <select name="kind" className={SELECT_CLS} style={SELECT_BG_STYLE} defaultValue="other">
                      {(Object.keys(CLOSEOUT_ITEM_KIND_LABEL) as CloseoutItemKind[]).map((k) => <option key={k} value={k}>{CLOSEOUT_ITEM_KIND_LABEL[k]}</option>)}
                    </select>
                  </label>
                  <label className="block"><span className={LABEL_CLS}>Label (optional)</span><input name="label" className={INPUT_CLS} placeholder="e.g. HVAC O&M binder" /></label>
                  <input type="hidden" name="included" value="on" /><input type="hidden" name="item_status" value="pending" />
                  <PendingSubmitButton className="px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold min-h-[44px]" pendingLabel="Adding…">Add</PendingSubmitButton>
                </form>
              </details>
            )}
          </div>

          {/* Cover / transmittal */}
          {editable ? (
            <form action={updateCoverAction} className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 space-y-3">
              <Ctx />
              <h2 className="text-sm font-bold text-ppp-charcoal flex items-center gap-2"><span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />Transmittal cover + warranty</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block"><span className={LABEL_CLS}>To (GC company)</span><input name="to_company" defaultValue={activePkg.to_company ?? account.company_name ?? ""} className={INPUT_CLS} /></label>
                <label className="block"><span className={LABEL_CLS}>Attention</span><input name="to_attention" defaultValue={activePkg.to_attention ?? ""} className={INPUT_CLS} /></label>
                <label className="block sm:col-span-2"><span className={LABEL_CLS}>Address</span><textarea name="to_address_lines" defaultValue={(activePkg.to_address_lines ?? []).join("\n")} rows={2} className={TEXTAREA_CLS} /></label>
                <label className="block sm:col-span-2"><span className={LABEL_CLS}>Re / subject</span><input name="re_subject" defaultValue={activePkg.re_subject ?? `Project Close-Out — ${dealName}`} className={INPUT_CLS} /></label>
                <label className="block"><span className={LABEL_CLS}>Transmitted as</span>
                  <select name="transmitted_as" defaultValue={activePkg.transmitted_as ?? "for_your_records"} className={SELECT_CLS} style={SELECT_BG_STYLE}>
                    {CLOSEOUT_TRANSMITTED_AS.map((t) => <option key={t} value={t}>{CLOSEOUT_TRANSMITTED_AS_LABEL[t]}</option>)}
                  </select>
                </label>
                <label className="block"><span className={LABEL_CLS}>Substantial completion</span><input type="date" name="substantial_completion_date" defaultValue={activePkg.substantial_completion_date ?? ""} className={INPUT_CLS} /></label>
                <label className="block"><span className={LABEL_CLS}>Warranty (years)</span><input type="text" inputMode="numeric" name="warranty_years" defaultValue={String(activePkg.warranty_years)} className={INPUT_CLS} /></label>
                <label className="block sm:col-span-2"><span className={LABEL_CLS}>Remarks</span><textarea name="remarks" defaultValue={activePkg.remarks ?? ""} rows={2} className={TEXTAREA_CLS} placeholder="Optional note on the cover." /></label>
              </div>
              <div className="flex justify-end">
                <PendingSubmitButton className="px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-sm font-semibold min-h-[44px]" pendingLabel="Saving…">Save cover</PendingSubmitButton>
              </div>
            </form>
          ) : (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 text-[12px] text-ppp-charcoal-600">
              <div className="font-semibold text-ppp-charcoal mb-1">Transmitted to {activePkg.to_company || account.company_name}{activePkg.to_attention ? ` · Attn ${activePkg.to_attention}` : ""}</div>
              {activePkg.re_subject && <div>Re: {activePkg.re_subject}</div>}
            </div>
          )}

          {/* PDF exports */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <a href={`/api/commercial/closeout/${activePkg.id}/transmittal`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-800 min-h-[40px]">Transmittal PDF →</a>
            <a href={`/api/commercial/closeout/${activePkg.id}/warranty`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-800 min-h-[40px]">Warranty letter PDF →</a>
          </div>

          {activePkg.status === "draft" && (
            <form action={deletePackageAction} className="text-right">
              <Ctx />
              <ConfirmSubmitButton className="text-[12px] text-ppp-charcoal-400 hover:text-rose-600 min-h-[36px] inline-flex items-center" message="Delete this draft package?" pendingLabel="Deleting…">Delete draft package</ConfirmSubmitButton>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
