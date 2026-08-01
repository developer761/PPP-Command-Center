/**
 * Project Costs & Job P&L — shared tool body (Phase 2).
 *
 * The cost side of a deal (materials/labor/subs/equipment/permits) + the Job P&L
 * (Contract − Costs = Gross Margin). Lives inline under the deal's Project
 * sub-tab AND on a standalone route, one source of truth (mirrors ChangeOrdersTool).
 * Revenue stays on the invoices; nothing here ever changes what we bill the GC.
 */
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { parseDollarsToCents, formatCentsFull, fmtEtDate } from "@/lib/commercial/invoices/format";
import { getProjectFinancials } from "@/lib/commercial/projects/financials";
import {
  listPurchasesForProject,
  addPurchase,
  updatePurchase,
  deletePurchase,
  attachPurchaseReceipt,
  recentVendorsForAccount,
  type CommercialProjectPurchase,
} from "@/lib/commercial/purchases/db";
import { PURCHASE_CATEGORIES, PURCHASE_CATEGORY_META, purchaseCategoryLabel } from "@/lib/commercial/purchases/constants";
import { getDocumentsByIds } from "@/lib/commercial/documents/db";
import { INPUT_CLS, TEXTAREA_CLS, LABEL_CLS, SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import ConfirmSubmitButton from "@/components/commercial/confirm-submit-button";
import { ToolBackHeader } from "@/components/commercial/tool-back-header";
import Link from "next/link";

export type CostsSP = {
  cost_ok?: string;
  error?: string;
  heads_up?: string;
  edit_purchase?: string;
  back?: string;
};

async function requireCommercialUser(): Promise<string> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return user.id;
}

function costsBase(accountId: string, oppId: string): string {
  return `/commercial/accounts/${accountId}?tab=projects&project=${oppId}&dt=project&pt=costs`;
}
function costsRedirect(accountId: string, oppId: string, params: Record<string, string>, back = ""): never {
  const p = { ...params };
  if (back && back.startsWith("/commercial/post-job/")) p.back = back;
  const qs = new URLSearchParams(p).toString();
  redirect(qs ? `${costsBase(accountId, oppId)}&${qs}` : costsBase(accountId, oppId));
}

function revalidateCostSurfaces(accountId: string, oppId: string) {
  revalidatePath(`/commercial/accounts/${accountId}`);
  revalidatePath("/commercial/projects");
  revalidatePath("/commercial");
}

const CATEGORY_LABELS = Object.fromEntries(
  PURCHASE_CATEGORIES.map((c) => [c, PURCHASE_CATEGORY_META[c].label])
) as Record<string, string>;

const COST_OK_MESSAGES: Record<string, string> = {
  added: "Purchase logged.",
  saved: "Purchase updated.",
  deleted: "Purchase removed.",
};

async function readReceiptFile(formData: FormData): Promise<{ file_name: string; mime_type: string; data: Uint8Array } | null> {
  const f = formData.get("receipt");
  if (!(f instanceof File) || f.size === 0) return null;
  return { file_name: f.name || "receipt.pdf", mime_type: f.type || "application/octet-stream", data: new Uint8Array(await f.arrayBuffer()) };
}

async function addPurchaseAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id)) redirect("/commercial/accounts");
  const category = String(formData.get("category") ?? "materials");
  const vendor = String(formData.get("vendor") ?? "");
  const rawAmount = String(formData.get("amount") ?? "");
  const rawDate = String(formData.get("purchased_at") ?? "");
  const description = String(formData.get("description") ?? "");
  const cents = parseDollarsToCents(rawAmount);
  if (cents === null || cents <= 0) {
    costsRedirect(account_id, opp_id, { error: "Enter a purchase amount greater than $0." }, back);
  }
  const purchased_at = rawDate ? new Date(`${rawDate}T16:00:00Z`).toISOString() : undefined;
  const res = await addPurchase({
    opportunity_id: opp_id,
    category,
    vendor: vendor || null,
    amount_cents: cents!,
    purchased_at: purchased_at ?? null,
    description: description || null,
    created_by_user_id: userId,
  });
  if (!res.ok) costsRedirect(account_id, opp_id, { error: res.error }, back);
  // Optional receipt — best-effort, never blocks the purchase.
  const receipt = await readReceiptFile(formData);
  if (receipt) {
    await attachPurchaseReceipt({ purchaseId: res.value.id, ...receipt, actorUserId: userId }).catch(() => {});
  }
  revalidateCostSurfaces(account_id, opp_id);
  costsRedirect(account_id, opp_id, { cost_ok: "added" }, back);
}

async function updatePurchaseAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const purchase_id = String(formData.get("purchase_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(purchase_id)) redirect("/commercial/accounts");
  const category = String(formData.get("category") ?? "materials");
  const vendor = String(formData.get("vendor") ?? "");
  const rawAmount = String(formData.get("amount") ?? "");
  const rawDate = String(formData.get("purchased_at") ?? "");
  const description = String(formData.get("description") ?? "");
  const cents = parseDollarsToCents(rawAmount);
  if (cents === null || cents <= 0) {
    costsRedirect(account_id, opp_id, { error: "Enter a purchase amount greater than $0.", edit_purchase: purchase_id }, back);
  }
  const res = await updatePurchase(
    purchase_id,
    {
      category,
      vendor: vendor || null,
      amount_cents: cents!,
      purchased_at: rawDate ? new Date(`${rawDate}T16:00:00Z`).toISOString() : undefined,
      description: description || null,
    },
    userId,
  );
  if (!res.ok) costsRedirect(account_id, opp_id, { error: res.error, edit_purchase: purchase_id }, back);
  const receipt = await readReceiptFile(formData);
  if (receipt) {
    await attachPurchaseReceipt({ purchaseId: purchase_id, ...receipt, actorUserId: userId }).catch(() => {});
  }
  revalidateCostSurfaces(account_id, opp_id);
  costsRedirect(account_id, opp_id, { cost_ok: "saved" }, back);
}

async function deletePurchaseAction(formData: FormData) {
  "use server";
  const userId = await requireCommercialUser();
  const opp_id = String(formData.get("opp_id") ?? "");
  const account_id = String(formData.get("account_id") ?? "");
  const back = String(formData.get("back") ?? "");
  const purchase_id = String(formData.get("purchase_id") ?? "");
  if (!UUID_RE.test(opp_id) || !UUID_RE.test(account_id) || !UUID_RE.test(purchase_id)) redirect("/commercial/accounts");
  const res = await deletePurchase(purchase_id, userId);
  if (!res.ok) costsRedirect(account_id, opp_id, { error: res.error }, back);
  revalidateCostSurfaces(account_id, opp_id);
  costsRedirect(account_id, opp_id, { cost_ok: "deleted" }, back);
}

function marginTone(pct: number | null): { text: string; bar: string; label: string } {
  if (pct == null) return { text: "text-ppp-charcoal-400", bar: "bg-ppp-charcoal-200", label: "—" };
  if (pct < 0) return { text: "text-rose-700", bar: "bg-rose-500", label: "over budget" };
  if (pct < 15) return { text: "text-amber-700", bar: "bg-amber-500", label: "thin margin" };
  return { text: "text-emerald-700", bar: "bg-emerald-500", label: "healthy" };
}

export async function ProjectCostsTool({
  id,
  dealId,
  sp,
  variant,
}: {
  id: string;
  dealId: string;
  sp: CostsSP;
  variant: "route" | "inline";
}) {
  await requireCommercialUser();
  if (!UUID_RE.test(id) || !UUID_RE.test(dealId)) notFound();

  const [account, opp] = await Promise.all([getCommercialAccount(id), getCommercialOpportunity(dealId)]);
  if (!account || !opp) notFound();
  if (opp.account_id !== id) notFound();

  const dealName = derivedOppName(opp, account.company_name);
  const [fin, purchases, recentVendors] = await Promise.all([
    getProjectFinancials(dealId),
    listPurchasesForProject(dealId),
    recentVendorsForAccount(id),
  ]);
  // Receipt docs for the purchases that have one (one batched query).
  const receiptDocs = await getDocumentsByIds(
    purchases.map((p) => p.receipt_document_id).filter((x): x is string => !!x),
  );

  const editId = sp.edit_purchase ?? null;
  const costPctOfContract = fin.hasContract ? Math.min(100, Math.round((fin.costs.total / fin.contractCents) * 100)) : 0;
  const mt = marginTone(fin.grossMarginPct);

  const panel = (
    <div className="space-y-3">
      {sp.cost_ok && COST_OK_MESSAGES[sp.cost_ok] ? (
        <div className="rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3 bg-emerald-50 border border-emerald-200 text-emerald-800">
          <span>{COST_OK_MESSAGES[sp.cost_ok]}</span>
          <Link href={costsBase(id, dealId)} className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center">Dismiss</Link>
        </div>
      ) : null}
      {sp.error ? (
        <div className="rounded-lg px-4 py-3 text-sm flex items-start justify-between gap-3 bg-rose-50 border border-rose-200 text-rose-700">
          <span>{sp.error}</span>
          <Link href={costsBase(id, dealId)} className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center">Dismiss</Link>
        </div>
      ) : null}

      {/* ── Job P&L ── */}
      <section className="bg-gradient-to-br from-cc-brand-50/60 to-surface border border-cc-brand-100 rounded-xl p-4 sm:p-5">
        <div className="flex items-center gap-2 mb-3">
          <span aria-hidden className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-cc-brand-600 text-white">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
          </span>
          <div>
            <h2 className="text-sm font-bold text-ppp-charcoal leading-tight">Job P&amp;L</h2>
            <p className="text-[11px] text-ppp-charcoal-500 leading-snug">Contract minus job costs. What we bill the customer never changes with cost.</p>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          <PLTile label="Contract" value={fin.hasContract ? formatCentsFull(fin.contractCents) : "—"} hint={fin.hasContract ? undefined : "Set a proposal/bid"} />
          <PLTile label="Invoiced" value={formatCentsFull(fin.invoicedCents)} />
          <PLTile label="Collected" value={formatCentsFull(fin.collectedCents)} tone="emerald" />
          <PLTile label="Costs" value={formatCentsFull(fin.costs.total)} tone={fin.costs.total > 0 ? "rose" : "neutral"} />
          <PLTile
            label={fin.grossMarginCents < 0 ? "Margin (loss)" : "Gross margin"}
            value={formatCentsFull(fin.grossMarginCents)}
            sub={fin.grossMarginPct == null ? undefined : `${fin.grossMarginPct}% · ${mt.label}`}
            tone={fin.grossMarginPct == null ? "neutral" : fin.grossMarginPct < 0 ? "rose" : fin.grossMarginPct < 15 ? "amber" : "emerald"}
            emphasize
          />
        </div>
        {fin.hasContract && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-[10.5px] text-ppp-charcoal-500 mb-1">
              <span>Costs vs contract</span>
              <span className={`font-semibold ${mt.text}`}>{costPctOfContract}% spent</span>
            </div>
            <div className="h-2.5 rounded-full bg-ppp-charcoal-100 overflow-hidden">
              <div className={`h-full rounded-full ${mt.bar}`} style={{ width: `${costPctOfContract}%` }} />
            </div>
          </div>
        )}
      </section>

      {/* ── Add + list ── */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        {purchases.length === 0 && (
          <p className="text-[12px] text-ppp-charcoal-500 mb-3">No costs logged yet. Add materials, labor, subs, equipment or permits below to see this job&rsquo;s margin.</p>
        )}
        <details className="group mb-3 border border-cc-brand-200 rounded-lg" open={!!sp.error && !editId || purchases.length === 0}>
          <summary className="cursor-pointer list-none px-3.5 py-2.5 min-h-[44px] flex items-center gap-2 text-[12px] font-semibold text-cc-brand-700 select-none">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="group-open:rotate-45 transition-transform"><path d="M12 5v14 M5 12h14" /></svg>
            Log a purchase
          </summary>
          <PurchaseForm action={addPurchaseAction} oppId={dealId} accountId={id} back={sp.back ?? ""} recentVendors={recentVendors} submitLabel="Add purchase" />
        </details>

        {purchases.length > 0 && (
          <ul className="space-y-2.5">
            {purchases.map((pu) => {
              const isEditing = editId === pu.id;
              const receipt = pu.receipt_document_id ? receiptDocs.get(pu.receipt_document_id) ?? null : null;
              const meta = PURCHASE_CATEGORY_META[pu.category] ?? PURCHASE_CATEGORY_META.other;
              return (
                <li key={pu.id} className="border border-ppp-charcoal-100 rounded-lg p-3 sm:p-3.5">
                  {isEditing ? (
                    <PurchaseForm action={updatePurchaseAction} oppId={dealId} accountId={id} back={sp.back ?? ""} recentVendors={recentVendors} submitLabel="Save" purchase={pu} cancelHref={costsBase(id, dealId)} />
                  ) : (
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-ppp-charcoal-200 bg-ppp-charcoal-50 text-[11px] font-semibold text-ppp-charcoal-700">{purchaseCategoryLabel(pu.category)}</span>
                          {pu.vendor && <span className="text-sm font-semibold text-ppp-charcoal break-words">{pu.vendor}</span>}
                        </div>
                        {pu.description && <div className="text-[12px] text-ppp-charcoal-500 mt-0.5 break-words whitespace-pre-wrap">{pu.description}</div>}
                        <div className="text-[11px] text-ppp-charcoal-400 mt-1 flex items-center gap-2 flex-wrap">
                          <span>{fmtEtDate(pu.purchased_at)}</span>
                          {receipt && (
                            <a href={`/api/commercial/documents/${receipt.id}/download`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-cc-brand-700 hover:text-cc-brand-800 min-h-[32px]">
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" /></svg>
                              Receipt
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <div className={`text-base font-bold tabular-nums text-ppp-charcoal`}>−{formatCentsFull(pu.amount_cents)}</div>
                        <div className="flex items-center gap-1">
                          <Link href={`${costsBase(id, dealId)}&edit_purchase=${pu.id}`} className="inline-flex items-center px-2.5 py-1.5 rounded-lg border border-ppp-charcoal-200 text-[12px] font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px]">Edit</Link>
                          <form action={deletePurchaseAction}>
                            <input type="hidden" name="opp_id" value={dealId} />
                            <input type="hidden" name="account_id" value={id} />
                            <input type="hidden" name="back" value={sp.back ?? ""} />
                            <input type="hidden" name="purchase_id" value={pu.id} />
                            <ConfirmSubmitButton message={`Delete this ${purchaseCategoryLabel(pu.category).toLowerCase()} purchase? This can't be undone.`} pendingLabel="Deleting…" className="inline-flex items-center px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-ppp-charcoal-400 hover:text-rose-700 hover:bg-rose-50 min-h-[44px]">Delete</ConfirmSubmitButton>
                          </form>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );

  if (variant === "inline") return <div className="space-y-4">{panel}</div>;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <ToolBackHeader accountId={id} dealId={dealId} accountName={account.company_name} dealName={dealName} back={sp.back} />
      <div>
        <h1 className="font-condensed text-2xl sm:text-3xl font-black text-ppp-charcoal tracking-tight leading-none">Costs &amp; Job P&amp;L</h1>
        <p className="text-[12px] text-ppp-charcoal-500 mt-0.5">{dealName}</p>
      </div>
      {panel}
    </div>
  );
}

type CoAction = (formData: FormData) => void | Promise<void>;

function PurchaseForm({
  action,
  oppId,
  accountId,
  back,
  recentVendors,
  submitLabel,
  purchase,
  cancelHref,
}: {
  action: CoAction;
  oppId: string;
  accountId: string;
  back: string;
  recentVendors: string[];
  submitLabel: string;
  purchase?: CommercialProjectPurchase;
  cancelHref?: string;
}) {
  const defDate = purchase ? purchase.purchased_at.slice(0, 10) : "";
  return (
    <form action={action} className="px-3.5 pb-3.5 pt-1 space-y-3" encType="multipart/form-data">
      <input type="hidden" name="opp_id" value={oppId} />
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="back" value={back} />
      {purchase && <input type="hidden" name="purchase_id" value={purchase.id} />}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLS} htmlFor="pu-category">Category</label>
          <select id="pu-category" name="category" defaultValue={purchase?.category ?? "materials"} className={SELECT_CLS} style={SELECT_BG_STYLE}>
            {PURCHASE_CATEGORIES.map((c) => (<option key={c} value={c}>{CATEGORY_LABELS[c]}</option>))}
          </select>
        </div>
        <div>
          <label className={LABEL_CLS} htmlFor="pu-amount">Amount</label>
          <input id="pu-amount" name="amount" required inputMode="decimal" defaultValue={purchase ? (purchase.amount_cents / 100).toFixed(2) : ""} className={INPUT_CLS} placeholder="1,250.00" />
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLS} htmlFor="pu-vendor">Vendor <span className="font-normal text-ppp-charcoal-400">(optional)</span></label>
          <input id="pu-vendor" name="vendor" list="pu-vendor-list" maxLength={200} defaultValue={purchase?.vendor ?? ""} className={INPUT_CLS} placeholder="Sherwin-Williams" />
          <datalist id="pu-vendor-list">
            {recentVendors.map((v) => (<option key={v} value={v} />))}
          </datalist>
        </div>
        <div>
          <label className={LABEL_CLS} htmlFor="pu-date">Date</label>
          <input id="pu-date" name="purchased_at" type="date" defaultValue={defDate} className={INPUT_CLS} />
        </div>
      </div>
      <div>
        <label className={LABEL_CLS} htmlFor="pu-desc">Description <span className="font-normal text-ppp-charcoal-400">(optional)</span></label>
        <textarea id="pu-desc" name="description" maxLength={2000} rows={2} defaultValue={purchase?.description ?? ""} className={TEXTAREA_CLS} placeholder="What was purchased" />
      </div>
      <div>
        <label className={LABEL_CLS} htmlFor="pu-receipt">Receipt <span className="font-normal text-ppp-charcoal-400">(optional — PDF or photo)</span></label>
        <input id="pu-receipt" name="receipt" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="block w-full text-[12px] text-ppp-charcoal-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-[12px] file:font-semibold file:bg-cc-brand-50 file:text-cc-brand-700 hover:file:bg-cc-brand-100" />
        {purchase?.receipt_document_id && <p className="text-[11px] text-emerald-600 mt-1">A receipt is on file — uploading a new one replaces it.</p>}
        <p className="text-[11px] text-ppp-charcoal-500 mt-1">Uploading from Google Drive? Use the raw file, not a Drive link — Drive recompresses PDFs.</p>
      </div>
      <div className="flex items-center gap-2">
        <PendingSubmitButton pendingLabel="Saving…" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30">{submitLabel}</PendingSubmitButton>
        {cancelHref && <Link href={cancelHref} className="px-3.5 py-2 rounded-lg border border-ppp-charcoal-200 text-[12px] font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px] inline-flex items-center">Cancel</Link>}
      </div>
    </form>
  );
}

function PLTile({
  label,
  value,
  sub,
  hint,
  tone = "neutral",
  emphasize = false,
}: {
  label: string;
  value: string;
  sub?: string;
  hint?: string;
  tone?: "neutral" | "emerald" | "rose" | "amber";
  emphasize?: boolean;
}) {
  const valueCls =
    tone === "emerald" ? "text-emerald-700" : tone === "rose" ? "text-rose-700" : tone === "amber" ? "text-amber-700" : "text-ppp-charcoal";
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${emphasize ? "border-cc-brand-300 bg-surface" : "border-ppp-charcoal-100 bg-surface/70"}`}>
      <div className="text-[9px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div className={`font-condensed text-lg sm:text-xl font-black tabular-nums leading-none mt-0.5 ${valueCls}`}>{value}</div>
      {sub && <div className={`text-[10px] mt-0.5 ${valueCls}`}>{sub}</div>}
      {hint && <div className="text-[10px] text-ppp-charcoal-400 mt-0.5">{hint}</div>}
    </div>
  );
}
