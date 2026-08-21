/**
 * Closeout & Warranty — account-scoped project page. Lists close-out packages
 * for a post-sale project; a selected one (?pkg=) shows its transmittal cover,
 * warranty term, and the close-out checklist. Same account-scoped pattern as
 * Change Orders / AIA — a single focused page with a ToolBackHeader (no
 * redundant tool tabs; this IS the closeout page).
 */
import { flashMessage } from "@/lib/commercial/flash";
import { oppStatusDisplayLabel } from "@/lib/commercial/opportunities/kanban-columns";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { fmtEtDate } from "@/lib/commercial/invoices/format";
import { UUID_RE } from "@/lib/commercial/uuid";
import {
  listCloseoutPackages,
  getCloseoutPackage,
  markWarrantyIssued,
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
  ADDABLE_CLOSEOUT_ITEM_KINDS,
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
import { autoFileOpportunityDocument, safeDocName, sentStampNote } from "@/lib/commercial/documents/auto-file";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { ToolBackHeader } from "@/components/commercial/tool-back-header";
import { DateField } from "@/components/commercial/date-field";
import { AutosaveForm } from "@/components/commercial/autosave-form";
import { isBackgroundSave } from "@/lib/commercial/autosave-flag";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { CloseoutItemControls } from "@/components/commercial/closeout-item-controls";
import { INPUT_CLS, TEXTAREA_CLS, SELECT_CLS, SELECT_BG_STYLE, LABEL_CLS } from "@/lib/commercial/form-classnames";
import { toolOriginQs } from "@/lib/commercial/tool-origin";

type PP = Promise<{ id: string; dealId: string }>;
type SP = Promise<{ pkg?: string; error?: string; ok?: string; back?: string; from?: string }>;

async function requireUser(): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return user.id;
}
/** Canonical home for Closeout = the deal's Project sub-tab. Already carries a
 *  query string, so callers append params with `&` (see the `?`→`&` usages). */
function backQ(back: string): string {
  return back && back.startsWith("/commercial/post-job/") ? `&back=${encodeURIComponent(back)}` : "";
}
function base(id: string, dealId: string, origin?: string, from?: string) {
  // Return you to WHERE you are — standalone tool when opened directly, the
  // account's deal (Project sub-tab) view when embedded there. Never jump.
  // `from` (overview/docs/activity) rides along so the page's back arrow
  // returns to the tab the tool was opened from, even after a save.
  return `/commercial/opportunities/${dealId}?tab=project&sub=closeout${toolOriginQs(from)}`;
}
function revalidateCloseout(id: string, dealId: string) {
  revalidatePath(`/commercial/opportunities/${dealId}`);
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
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) redirect("/commercial/accounts");
  const res = await createCloseoutPackage({ opportunity_id: dealId, created_by_user_id: userId });
  if (!res.ok) redirect(`${base(id, dealId, origin, from)}&error=${encodeURIComponent(res.error)}${backQ(back)}`);
  revalidateCloseout(id, dealId);
  redirect(`${base(id, dealId, origin, from)}&pkg=${res.value.id}${backQ(back)}`);
}

/** Autosave-friendly cover save: same write, but RETURNS (no redirect) so the
 *  AutosaveForm wrapper can show its "Saving…/Saved" pill instead of navigating
 *  on every debounced keystroke. Throws on a real failure → the pill shows the
 *  error. (Security/ownership failures throw too — a legit user never hits them.) */
async function autosaveCoverAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const pkgId = String(formData.get("pkg_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(pkgId)) throw new Error("Invalid ids");
  if (!(await pkgBelongs(pkgId, id, dealId))) throw new Error("Package not found");
  const taRaw = String(formData.get("transmitted_as") ?? "").trim();
  const transmitted_as = (CLOSEOUT_TRANSMITTED_AS as readonly string[]).includes(taRaw) ? (taRaw as CloseoutTransmittedAs) : null;
  const yrsRaw = Number(String(formData.get("warranty_years") ?? "1"));
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
      warranty_years: Number.isFinite(yrsRaw) && yrsRaw >= 0 && yrsRaw <= 20 ? Math.round(yrsRaw) : 1,
    },
    userId
  );
  if (!res.ok) throw new Error(res.error);
  // Background save → skip the revalidate, not the write. See the same guard in
  // work-order-tool.tsx: revalidating here re-rendered the cover sheet mid-type.
  if (isBackgroundSave(formData)) return;
  revalidateCloseout(id, dealId);
}

async function changeStatusAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const pkgId = String(formData.get("pkg_id") ?? "");
  const to = String(formData.get("to") ?? "") as CloseoutStatus;
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(pkgId)) redirect("/commercial/accounts");
  if (!(await pkgBelongs(pkgId, id, dealId))) redirect("/commercial/accounts");
  const res = await changeCloseoutStatus(pkgId, to, userId);
  if (!res.ok) redirect(`${base(id, dealId, origin, from)}&pkg=${pkgId}&error=${encodeURIComponent(res.error)}${backQ(back)}`);
  // File the TRANSMITTAL when the package goes to the GC. The warranty is not
  // filed here — Katie: "Warranty sent ONLY as requested". It has its own
  // action, below.
  if (to === "sent") await autoFileCloseoutPackage(id, dealId, pkgId, userId);
  revalidateCloseout(id, dealId);
  redirect(`${base(id, dealId, origin, from)}&pkg=${pkgId}${backQ(back)}`);
}

/** Render + file the closeout transmittal as a deal document (category
 *  closeout). Best-effort.
 *
 *  It used to file the WARRANTY here too, whenever `warranty_years > 0` — which
 *  defaults to 1, so every close-out issued one. Katie's rule is the opposite
 *  ("Warranty sent ONLY as requested"), and the letter carries Brendan's
 *  signature over a twelve-month guarantee to repair or replace at Tomco's own
 *  expense. A warranty nobody asked for is an obligation nobody had to give.
 *  Issuing it is now `issueWarrantyAction`. */
async function autoFileCloseoutPackage(accountId: string, dealId: string, pkgId: string, userId: string) {
  try {
    const pkg = await getCloseoutPackage(pkgId);
    if (!pkg) return;
    const [opp, account, items] = await Promise.all([
      getCommercialOpportunity(dealId),
      getCommercialAccount(accountId),
      listCloseoutItems(pkgId),
    ]);
    if (!opp || !account) return;
    const dealName = derivedOppName(opp, account.company_name);
    const oc = await getOperatingCompany();
    const company = {
      name: oc.name,
      phone: oc.phone,
      website: oc.website,
      signature_name: oc.signature_name,
      signature_title: oc.signature_title,
    };
    // The signature buffer and the warranty renderer are deliberately NOT
    // pulled in here any more — nothing on this path may issue a warranty.
    const { getBrandLogoBuffer } = await import("@/lib/commercial/operating-company/assets");
    const logo = await getBrandLogoBuffer();
    const { renderCloseoutTransmittalPdf } = await import("@/lib/commercial/closeout/pdf");
    const transmittal = await renderCloseoutTransmittalPdf({ pkg, items, dealName, company, logo });
    await autoFileOpportunityDocument({
      opportunityId: dealId,
      category: "closeout",
      fileName: safeDocName("Closeout_Transmittal", dealName) + ".pdf",
      mimeType: "application/pdf",
      data: new Uint8Array(transmittal),
      notes: sentStampNote("Closeout transmittal sent"),
      actorUserId: userId,
    });
  } catch (err) {
    console.warn("[auto-file closeout] failed:", err);
  }
}

/**
 * Issue the warranty letter to the GC — on request, and only on request.
 *
 * A deliberate action rather than a step in the send, for two reasons that are
 * really one: Katie's rule, and the fact that the letter is a signed
 * twelve-month guarantee. It is also available AFTER the package has gone out,
 * because that is when GCs actually ask.
 *
 * Renders the same PDF the preview link shows, files it against the deal, and
 * stamps the package so the record says when a warranty was given and on which
 * job — which is the question you need answered two years later.
 */
async function issueWarrantyAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const pkgId = String(formData.get("pkg_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(pkgId)) redirect("/commercial/accounts");
  if (!(await pkgBelongs(pkgId, id, dealId))) redirect("/commercial/accounts");
  const dest = `${base(id, dealId, origin, from)}&pkg=${pkgId}`;

  const pkg = await getCloseoutPackage(pkgId);
  if (!pkg) redirect(`${dest}${backQ(back)}`);
  const [opp, account] = await Promise.all([
    getCommercialOpportunity(dealId),
    getCommercialAccount(id),
  ]);
  if (!opp || !account) {
    redirect(`${dest}&error=${encodeURIComponent("Couldn't load the job for this warranty.")}${backQ(back)}`);
  }
  const dealName = derivedOppName(opp, account.company_name);
  const oc = await getOperatingCompany();
  const { getBrandLogoBuffer, getBrandSignatureBuffer } = await import("@/lib/commercial/operating-company/assets");
  const { renderWarrantyLetterPdf } = await import("@/lib/commercial/closeout/pdf");
  try {
    const warranty = await renderWarrantyLetterPdf({
      pkg,
      dealName,
      accountName: account.company_name,
      company: {
        name: oc.name,
        phone: oc.phone,
        website: oc.website,
        signature_name: oc.signature_name,
        signature_title: oc.signature_title,
        legal_name: oc.legal_name,
        address_line1: oc.address_line1,
        address_line2: oc.address_line2,
        city: oc.city,
        state: oc.state,
        zip: oc.zip,
      },
      logo: await getBrandLogoBuffer(),
      signature: await getBrandSignatureBuffer(),
    });
    await autoFileOpportunityDocument({
      opportunityId: dealId,
      category: "closeout",
      fileName: safeDocName("Warranty", dealName, `${pkg.warranty_years}yr`) + ".pdf",
      mimeType: "application/pdf",
      data: new Uint8Array(warranty),
      notes: sentStampNote(`${pkg.warranty_years}-year warranty letter issued on request`),
      actorUserId: userId,
    });
  } catch (err) {
    console.warn("[issue warranty] render/file failed:", err);
    redirect(`${dest}&error=${encodeURIComponent("Couldn't build the warranty letter. Nothing was issued.")}${backQ(back)}`);
  }
  // Stamped only after the document exists, so the record can never claim a
  // warranty was issued when no letter was filed.
  const res = await markWarrantyIssued(pkgId, userId);
  revalidateCloseout(id, dealId);
  redirect(res.ok ? `${dest}&warranty=1${backQ(back)}` : `${dest}&error=${encodeURIComponent(res.error)}${backQ(back)}`);
}

async function upsertItemAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
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
  if (!res.ok) redirect(`${base(id, dealId, origin, from)}&pkg=${pkgId}&error=${encodeURIComponent(res.error)}${backQ(back)}`);
  revalidateCloseout(id, dealId);
  redirect(`${base(id, dealId, origin, from)}&pkg=${pkgId}${backQ(back)}`);
}

/**
 * Autosave variant of upsertItemAction — RETURNS a result instead of
 * redirecting, so the checklist's Include toggle + status select can save the
 * instant you change them (no Save button, no page jump). Same ownership guard.
 */
async function saveItemAutosaveAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const pkgId = String(formData.get("pkg_id") ?? "");
  const itemId = String(formData.get("item_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(pkgId) || !UUID_RE.test(itemId)) {
    return { ok: false, error: "Bad request." };
  }
  if (!(await pkgBelongs(pkgId, id, dealId))) return { ok: false, error: "Not found." };
  const res = await upsertCloseoutItem(
    {
      id: itemId,
      package_id: pkgId,
      kind: String(formData.get("kind") ?? "other") as CloseoutItemKind,
      label: String(formData.get("label") ?? "").trim() || null,
      included: String(formData.get("included") ?? "") === "on" || String(formData.get("included") ?? "") === "true",
      item_status: String(formData.get("item_status") ?? "pending") as CloseoutItemStatus,
      notes: String(formData.get("notes") ?? "").trim() || null,
    },
    userId
  );
  if (!res.ok) return { ok: false, error: res.error };
  revalidateCloseout(id, dealId);
  return { ok: true };
}

async function deleteItemAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const pkgId = String(formData.get("pkg_id") ?? "");
  const itemId = String(formData.get("item_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(pkgId) || !UUID_RE.test(itemId)) redirect("/commercial/accounts");
  if (!(await pkgBelongs(pkgId, id, dealId))) redirect("/commercial/accounts");
  const res = await deleteCloseoutItem(itemId, pkgId, userId);
  revalidateCloseout(id, dealId);
  if (!res.ok) {
    redirect(
      `${base(id, dealId, origin, from)}&pkg=${pkgId}&error=${encodeURIComponent(res.error ?? "Could not remove that item.")}${backQ(back)}`
    );
  }
  redirect(`${base(id, dealId, origin, from)}&pkg=${pkgId}${backQ(back)}`);
}

async function deletePackageAction(formData: FormData) {
  "use server";
  const userId = await requireUser();
  const id = String(formData.get("account_id") ?? "");
  const dealId = String(formData.get("opp_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const origin = String(formData.get("origin") ?? "");
  const from = String(formData.get("from") ?? "");
  const pkgId = String(formData.get("pkg_id") ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId) || !UUID_RE.test(pkgId)) redirect("/commercial/accounts");
  if (!(await pkgBelongs(pkgId, id, dealId))) redirect("/commercial/accounts");
  const res = await deleteCloseoutPackage(pkgId, userId);
  if (!res.ok) redirect(`${base(id, dealId, origin, from)}&pkg=${pkgId}&error=${encodeURIComponent(res.error)}${backQ(back)}`);
  revalidateCloseout(id, dealId);
  redirect(`${base(id, dealId, origin, from)}${backQ(back)}`);
}

// ── Tool body (shared by the standalone route + the deal Project sub-tab) ──
export type CloseoutSP = { pkg?: string; error?: string; ok?: string; warranty?: string; back?: string; from?: string };
export async function CloseoutTool({
  id,
  dealId,
  sp,
  variant,
}: {
  id: string;
  dealId: string;
  sp: CloseoutSP;
  variant: "route" | "inline";
}) {
  await requireUser();
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();

  const [account, opp, operatingCompany] = await Promise.all([
    getCommercialAccount(id),
    getCommercialOpportunity(dealId),
    // Named in the issue-warranty confirmation: "it carries Brendan Dwyer's
    // signature" is the sentence that makes somebody stop and think.
    getOperatingCompany(),
  ]);
  if (!account || !opp) notFound();
  if (opp.account_id !== id) notFound();
  // No Won-gate: closeout is available on every deal (Karan 2026-08 — nothing
  // locked). A bid simply has no package yet.

  const dealName = derivedOppName(opp, account.company_name);
  const packages = await listCloseoutPackages(dealId);
  const selectedId = typeof sp.pkg === "string" && UUID_RE.test(sp.pkg) ? sp.pkg : packages[0]?.id ?? null;
  const pkg = selectedId ? await getCloseoutPackage(selectedId) : null;
  const selectedValid = pkg && pkg.opportunity_id === dealId ? pkg : null;
  // A stale/cross-deal ?pkg= must NOT hide real packages — fall back to the
  // deal's first package instead of rendering the empty state.
  const activePkg =
    selectedValid ?? (packages.length > 0 && packages[0].id !== selectedId ? await getCloseoutPackage(packages[0].id) : null);
  const items = activePkg ? await listCloseoutItems(activePkg.id) : [];
  const editable = activePkg ? isCloseoutEditable(activePkg.status) : false;
  // Issued but not closed → the cover + item set are frozen, but the checklist
  // stays live so docs can be ticked "Sent" as they go out.
  const canTickItems = activePkg ? isCloseoutItemStatusEditable(activePkg.status) : false;
  const progress = closeoutProgressPct(items);
  const warrantyEnd = activePkg ? computeWarrantyEndDate(activePkg.substantial_completion_date, activePkg.warranty_years) : null;

  const Ctx = () => (
    <>
      <input type="hidden" name="account_id" value={id} />
      <input type="hidden" name="opp_id" value={dealId} />
      <input type="hidden" name="back" value={sp.back ?? ""} />
      <input type="hidden" name="from" value={sp.from ?? ""} />
      <input type="hidden" name="origin" value={variant} />
      {activePkg && <input type="hidden" name="pkg_id" value={activePkg.id} />}
    </>
  );

  return (
    <div className={variant === "inline" ? "space-y-4" : "max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4"}>
      {variant === "route" && (
        <>
          <ToolBackHeader accountId={id} dealId={dealId} accountName={account.company_name} dealName={dealName} back={sp.back} />
          <div>
            <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Closeout &amp; Warranty</h1>
            <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">{dealName} · <span className="font-medium">{oppStatusDisplayLabel(opp.status, opp.sub_status)}</span></p>
          </div>
        </>
      )}

      {sp.error && <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-700">{flashMessage(sp.error)}</div>}
      {sp.ok && <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-[13px] text-emerald-800">Saved.</div>}
      {sp.warranty === "1" && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5 text-[13px] text-emerald-800">
          Warranty letter issued and filed on the deal, under Documents.
        </div>
      )}

      {/* Package list + create */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {packages.map((p) => {
            const on = activePkg?.id === p.id;
            const meta = CLOSEOUT_STATUS_META[p.status];
            return (
              <Link key={p.id} href={`${base(id, dealId, variant, sp.from ?? "")}&pkg=${p.id}`} aria-current={on ? "page" : undefined}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-[12px] font-semibold min-h-[44px] sm:min-h-[36px] ${on ? "bg-cc-brand-50 border-cc-brand-300 text-cc-brand-800" : "bg-surface border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-cc-brand-50"}`}>
                Package · {meta.label}
              </Link>
            );
          })}
        </div>
        <form action={createPackageAction}>
          <input type="hidden" name="account_id" value={id} />
          <input type="hidden" name="opp_id" value={dealId} />
          <input type="hidden" name="back" value={sp.back ?? ""} />
      <input type="hidden" name="from" value={sp.from ?? ""} />
      <input type="hidden" name="origin" value={variant} />
          <PendingSubmitButton className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cc-brand-600 text-white text-[13px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation" pendingLabel="Creating…">
            + New close-out package
          </PendingSubmitButton>
        </form>
      </div>

      {!activePkg ? (
        <div className="text-center py-12 px-4 bg-surface border border-dashed border-ppp-charcoal-200 rounded-xl">
          <p className="text-sm font-semibold text-ppp-charcoal">No close-out package yet</p>
          <p className="text-[12px] text-ppp-charcoal-500 mt-1 max-w-sm mx-auto">Create one when the job wraps — it seeds the standard checklist (punch-list sign-off, finish schedule, warranty, lien waiver, final invoice) + the 1-year warranty term.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Quick overview strip — mirrors the CO/AIA/Submittals tools so every
              deal tool leads with an at-a-glance summary. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <CloseoutStat label="Status" value={CLOSEOUT_STATUS_META[activePkg.status].label} />
            <CloseoutStat label="Checklist" value={progress != null ? `${progress}%` : "—"} sub="collected" tone={progress === 100 ? "emerald" : progress != null && progress > 0 ? "blue" : "neutral"} />
            <CloseoutStat label="Warranty term" value={`${activePkg.warranty_years} yr${activePkg.warranty_years === 1 ? "" : "s"}`} />
            <CloseoutStat label="Warranty through" value={warrantyEnd ? fmtEtDate(`${warrantyEnd}T12:00:00Z`) : "—"} tone={warrantyEnd ? "emerald" : "neutral"} />
          </div>

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
                    className={`inline-flex items-center px-3 py-1.5 rounded-lg text-[12px] font-semibold min-h-[44px] ${to === "voided" ? "border border-rose-300 text-rose-700 hover:bg-rose-50" : "bg-cc-brand-600 text-white hover:bg-cc-brand-700"}`}
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
                ? "The cover + item list are locked, but you can still mark items Sent as documents go out. Void it to change the cover or add/remove items."
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

            {/* ── Issuing the letter ───────────────────────────────────────
                Katie: "Warranty sent ONLY as requested." This used to happen
                automatically on every send. It is a deliberate act now, and it
                stays available after the package has gone out — which is when
                GCs actually ask.

                The TERM above is unaffected either way: the warranty period is
                a fact about the job, whether or not a letter was requested. */}
            <div className="mt-3 pt-3 border-t border-ppp-charcoal-100 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-ppp-charcoal">
                  {activePkg.warranty_issued_at
                    ? `Letter issued ${fmtEtDate(activePkg.warranty_issued_at)}`
                    : "No warranty letter issued"}
                </div>
                <p className="text-[11px] text-ppp-charcoal-500 mt-0.5 max-w-md">
                  {activePkg.warranty_issued_at
                    ? "Filed on the deal under Documents. Issue again only if the GC needs another copy."
                    : "Send it when the GC asks for one — it's a signed guarantee, so it isn't issued automatically. The term above applies to the job either way."}
                </p>
              </div>
              {activePkg.status !== "voided" && (
                <form action={issueWarrantyAction}>
                  <Ctx />
                  <input type="hidden" name="pkg_id" value={activePkg.id} />
                  <ConfirmSubmitButton
                    className={`inline-flex items-center px-3.5 py-2 rounded-lg text-[12.5px] font-semibold min-h-[44px] shrink-0 ${
                      activePkg.warranty_issued_at
                        ? "border border-ppp-charcoal-200 text-ppp-charcoal-700 hover:bg-ppp-charcoal-50"
                        : "bg-cc-brand-600 text-white hover:bg-cc-brand-700"
                    }`}
                    message={`Issue the ${activePkg.warranty_years}-year warranty letter for this job? It carries ${operatingCompany.signature_name ?? "the company"}'s signature and guarantees the work for ${activePkg.warranty_years * 12} months.`}
                    pendingLabel="Issuing…"
                  >
                    {activePkg.warranty_issued_at ? "Issue again" : "Issue warranty letter"}
                  </ConfirmSubmitButton>
                </form>
              )}
            </div>
          </div>

          {/* Checklist */}
          <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4">
            <h2 className="text-sm font-bold text-ppp-charcoal mb-3 flex items-center gap-2"><span aria-hidden className="inline-block h-[3px] w-6 rounded-full bg-cc-brand-600" />Closeout checklist</h2>
            <ul className="space-y-2">
              {items.map((it) => (
                <li key={it.id} className="border border-ppp-charcoal-100 rounded-lg p-3">
                  {editable || canTickItems ? (
                    // Autosave: Include toggle (draft only) + status select save
                    // the instant you change them — no Save button.
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-center">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-ppp-charcoal">{it.label || CLOSEOUT_ITEM_KIND_LABEL[it.kind]}{!it.included && !editable && <span className="ml-2 text-[10px] font-medium text-ppp-charcoal-400">(excluded)</span>}</div>
                      </div>
                      <CloseoutItemControls
                        itemId={it.id}
                        pkgId={activePkg.id}
                        accountId={id}
                        dealId={dealId}
                        kind={it.kind}
                        label={it.label ?? ""}
                        included={it.included}
                        itemStatus={it.item_status}
                        includeEditable={editable}
                        saveAction={saveItemAutosaveAction}
                      />
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[13px] font-semibold text-ppp-charcoal">{it.label || CLOSEOUT_ITEM_KIND_LABEL[it.kind]}{!it.included && <span className="ml-2 text-[10px] font-medium text-ppp-charcoal-400">(excluded)</span>}</div>
                      <span className={`text-[11px] font-semibold ${it.item_status === "received" ? "text-emerald-700" : it.item_status === "na" ? "text-ppp-charcoal-400" : "text-amber-700"}`}>{CLOSEOUT_ITEM_STATUS_LABEL[it.item_status]}</span>
                    </div>
                  )}
                  {editable && (
                    <form action={deleteItemAction} className="mt-1 text-right">
                      <Ctx /><input type="hidden" name="item_id" value={it.id} />
                      <ConfirmSubmitButton className="text-[11px] text-ppp-charcoal-400 hover:text-rose-600 min-h-[44px] sm:min-h-[32px] inline-flex items-center" message="Remove this item?" pendingLabel="…">Remove</ConfirmSubmitButton>
                    </form>
                  )}
                </li>
              ))}
              {items.length === 0 && <li className="text-[12px] text-ppp-charcoal-400 italic">No items.</li>}
            </ul>
            {editable && (
              <details className="mt-3 group">
                <summary className="list-none cursor-pointer text-[12px] font-semibold text-cc-brand-700 min-h-[44px] sm:min-h-[36px] inline-flex items-center gap-1">+ Add item</summary>
                <form action={upsertItemAction} className="mt-2 grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
                  <Ctx />
                  <label className="block"><span className={LABEL_CLS}>Kind</span>
                    <select name="kind" className={SELECT_CLS} style={SELECT_BG_STYLE} defaultValue="other">
                      {/* Katie: COI comes off the close-out cover letter. It stays in
                          the LABEL map so packages that already carry the row still
                          read correctly — it is just no longer offered. */}
                      {ADDABLE_CLOSEOUT_ITEM_KINDS.map((k) => <option key={k} value={k}>{CLOSEOUT_ITEM_KIND_LABEL[k]}</option>)}
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
            <AutosaveForm action={autosaveCoverAction} formClassName="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 space-y-3">
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
                <div><span className={LABEL_CLS}>Substantial completion</span><DateField ariaLabel="Substantial completion date" name="substantial_completion_date" defaultValue={activePkg.substantial_completion_date ?? ""} placeholder="Pick a date" className="mt-1" /></div>
                <label className="block"><span className={LABEL_CLS}>Warranty (years)</span><input type="text" inputMode="numeric" name="warranty_years" defaultValue={String(activePkg.warranty_years)} className={INPUT_CLS} /></label>
                <label className="block sm:col-span-2"><span className={LABEL_CLS}>Remarks</span><textarea name="remarks" defaultValue={activePkg.remarks ?? ""} rows={2} className={TEXTAREA_CLS} placeholder="Optional note on the cover." /></label>
              </div>
              <div className="flex items-center justify-end gap-3">
                <span className="text-[11px] text-ppp-charcoal-400">Saves automatically</span>
                <PendingSubmitButton className="px-4 py-2 rounded-lg border border-ppp-charcoal-200 text-ppp-charcoal-700 text-sm font-semibold min-h-[44px] hover:bg-ppp-charcoal-50" pendingLabel="Saving…">Save now</PendingSubmitButton>
              </div>
            </AutosaveForm>
          ) : (
            <div className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 text-[12px] text-ppp-charcoal-600">
              <div className="font-semibold text-ppp-charcoal mb-1">Transmitted to {activePkg.to_company || account.company_name}{activePkg.to_attention ? ` · Attn ${activePkg.to_attention}` : ""}</div>
              {activePkg.re_subject && <div>Re: {activePkg.re_subject}</div>}
            </div>
          )}

          {/* PDF exports */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <a href={`/api/commercial/closeout/${activePkg.id}/transmittal`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-800 min-h-[44px]">Transmittal PDF →</a>
            <a href={`/api/commercial/closeout/${activePkg.id}/warranty`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-cc-brand-50 hover:border-cc-brand-300 hover:text-cc-brand-800 min-h-[44px]">Warranty letter PDF →</a>
          </div>

          {activePkg.status === "draft" && (
            <form action={deletePackageAction} className="text-right">
              <Ctx />
              <ConfirmSubmitButton className="text-[12px] text-ppp-charcoal-400 hover:text-rose-600 min-h-[44px] sm:min-h-[36px] inline-flex items-center" message="Delete this draft package?" pendingLabel="Deleting…">Delete draft package</ConfirmSubmitButton>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function CloseoutStat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "emerald" | "blue";
}) {
  const valueCls = tone === "emerald" ? "text-emerald-700" : tone === "blue" ? "text-ppp-blue-700" : "text-ppp-charcoal";
  return (
    <div className="rounded-lg border border-ppp-charcoal-100 bg-surface/70 px-2.5 py-2">
      <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-lg sm:text-xl font-black tabular-nums leading-none mt-0.5 ${valueCls}`}>{value}</div>
      {sub && <div className="text-[10px] text-ppp-charcoal-400 mt-0.5">{sub}</div>}
    </div>
  );
}
