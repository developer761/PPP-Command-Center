"use client";

/**
 * PurchaseForm — the add/edit form for a project cost (Costs & P&L, Phase 2).
 *
 * Client component so the form RESHAPES for labor: pick "Labor" and the Vendor
 * field becomes "Worker" (with a workers datalist), an Hours field appears, and
 * a live $/hr rate shows. Every other category keeps the plain vendor form.
 *
 * The vendor field is a search box over the vendor directory (Settings →
 * Vendors, Katie 2026-09-15): the kind the category asks for is listed first
 * (labor vendors for labor/subs, stores for everything else), names typed on
 * this account before are still offered, and a name that isn't in the list
 * can be added with one tap. Free text still saves — nothing is forced.
 *
 * `action` is a server action passed from the (server) costs tool — the form
 * still posts to the server; only the field layout is reactive here.
 */

import { useId, useMemo, useRef, useState } from "react";
import { SearchableSelect, type SearchableOption } from "@/components/commercial/searchable-select";
import {
  matchVendorByName,
  orderVendorsForCategory,
  vendorKey,
  vendorKindForCategory,
  VENDOR_KIND_META,
  type VendorKind,
  type VendorStatus,
} from "@/lib/commercial/vendors/constants";
import { VENDOR_PICK_FIELDS } from "@/lib/commercial/vendors/purchase-pick";
import { isLaborPaymentCategory } from "@/lib/commercial/purchases/constants";
import { DateField } from "@/components/commercial/date-field";
import { shrinkImageUnder } from "@/lib/commercial/uploads/downscale-image";
import { SAFE_MULTIPART_BYTES, multipartOversizeError } from "@/lib/commercial/uploads/size-limit";
import Link from "next/link";
import { INPUT_CLS, TEXTAREA_CLS, LABEL_CLS, SELECT_CLS, SELECT_BG_STYLE } from "@/lib/commercial/form-classnames";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";

export type PurchaseFormPurchase = {
  id: string;
  category: string;
  vendor: string | null;
  amount_cents: number;
  hours: number | null;
  purchased_at: string;
  description: string | null;
  receipt_document_id: string | null;
  reimburse_to?: string | null;
  vendor_id?: string | null;
};

/** A directory vendor as the picker needs it (see listVendorOptions). */
export type PurchaseFormVendor = {
  id: string;
  name: string;
  kind: VendorKind;
  status: VendorStatus;
  specialty: string | null;
};

const GROUP_LABEL: Record<VendorKind, string> = {
  labor: "Labor vendors",
  retail: "Stores & suppliers",
};

type CoAction = (formData: FormData) => void | Promise<void>;

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Parse a loose dollar string ("1,250.00", "$1250") to a number, or null. */
function parseDollars(s: string): number | null {
  const cleaned = s.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export default function PurchaseForm({
  action,
  oppId,
  accountId,
  back,
  from = "",
  origin = "",
  categories,
  recentVendors,
  recentWorkers,
  vendors = [],
  submitLabel,
  purchase,
  cancelHref,
  preserve,
}: {
  action: CoAction;
  oppId: string;
  accountId: string;
  back: string;
  /** ?from= deal-tab origin so the page back arrow returns to where the tool was
   *  opened, even after a save. */
  from?: string;
  /** Where the tool is rendered ("route" | "inline") so the action returns you here. */
  origin?: string;
  /** [value, label] pairs in display order. */
  categories: [string, string][];
  recentVendors: string[];
  recentWorkers: string[];
  /** Active directory vendors. Empty (e.g. before the vendors migration) → the
   *  field behaves as the free-text box it always was. */
  vendors?: PurchaseFormVendor[];
  submitLabel: string;
  purchase?: PurchaseFormPurchase;
  cancelHref?: string;
  preserve?: { cat?: string; vendor?: string; vendorId?: string; vendorNew?: boolean; amt?: string; hours?: string; date?: string; desc?: string; reimburseTo?: string };
}) {
  // `preserve` WINS over `purchase`. It is only ever populated by a rejected
  // submit, so it is what the user typed a moment ago; the DB row is the stale
  // value they were trying to change. Reading the row first made a rejected
  // edit look like it had reverted itself.
  const initCat = preserve?.cat ?? purchase?.category ?? "materials";
  const initAmt = preserve?.amt ?? (purchase ? (purchase.amount_cents / 100).toFixed(2) : "");
  const initHours =
    preserve?.hours ?? (purchase?.hours != null ? String(purchase.hours) : "");
  const defDate = preserve?.date ?? (purchase ? purchase.purchased_at.slice(0, 10) : "");

  const [category, setCategory] = useState(initCat);
  const [amount, setAmount] = useState(initAmt);
  const [hours, setHours] = useState(initHours);
  // Employee labor is a labor payment too: it has hours and a person, and
  // wants the labor vendor picker rather than the store one.
  const isLabor = isLaborPaymentCategory(category);
  const vendorKind = vendorKindForCategory(category);

  // The vendor box. Its text decides the link: a name that IS a directory
  // vendor posts that vendor's id, anything else posts none — so editing the
  // name can never leave a stale id behind. The server re-resolves regardless.
  // Unique per form instance: the add form and an open edit form are on the
  // page together, and the picker scrolls its highlighted row into view by id.
  const vendorFieldId = `pu-vendor-${useId()}`;
  const initVendor = preserve?.vendor ?? purchase?.vendor ?? "";
  const [vendorText, setVendorText] = useState(initVendor);
  const [vendorNew, setVendorNew] = useState(!!preserve?.vendorNew);
  const directoryHasVendors = vendors.length > 0;
  const linked = useMemo(() => {
    const byText = matchVendorByName(vendors, vendorText);
    if (byText) return byText;
    // An old purchase linked to a vendor since renamed or deactivated: the id
    // still stands while the text is the one it was saved with.
    const savedId = preserve?.vendor !== undefined ? preserve.vendorId : purchase?.vendor_id;
    return savedId && vendorKey(vendorText) === vendorKey(initVendor) ? { id: savedId, name: vendorText, kind: vendorKind, status: "active" as const, specialty: null } : null;
  }, [vendors, vendorText, preserve, purchase, initVendor, vendorKind]);

  // KATIE 2026-09-16: "can we have the Vendor list filter based on which
  // Category is selected — Materials: don't show any labor vendors; labor or
  // subcontractor: don't show retail vendors."
  //
  // So it filters now rather than just ordering. The "Show all" escape stays,
  // because the reason it only ordered before is still true: a permit bought
  // through a labor company, or a sub who also sells materials, is a real
  // purchase, and a vendor you cannot find is a vendor somebody retypes — which
  // splits it in two and quietly breaks every per-vendor total.
  const [showAllVendors, setShowAllVendors] = useState(false);
  const wrongKindCount = useMemo(
    () => vendors.filter((v) => v.kind !== vendorKind).length,
    [vendors, vendorKind]
  );

  const vendorOptions = useMemo<SearchableOption[]>(() => {
    const ordered = orderVendorsForCategory(vendors, category).filter(
      (v) => showAllVendors || v.kind === vendorKind
    );
    const opts: SearchableOption[] = ordered.map((v) => ({
      value: v.name,
      label: v.name,
      hint: v.specialty ?? VENDOR_KIND_META[v.kind].label,
      group: directoryHasVendors ? GROUP_LABEL[v.kind] : undefined,
    }));
    // Names typed on this account before that aren't in the directory — still
    // one tap away, so the vendor list going live doesn't take anything away.
    const seen = new Set(vendors.map((v) => vendorKey(v.name)));
    const recent = isLabor ? [...recentWorkers, ...recentVendors] : [...recentVendors, ...recentWorkers];
    for (const name of recent) {
      const k = vendorKey(name);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      opts.push({ value: name, label: name, hint: "Typed before — not in the vendor list", group: directoryHasVendors ? "Typed before" : undefined });
    }
    return opts;
  }, [vendors, category, isLabor, recentVendors, recentWorkers, directoryHasVendors, showAllVendors, vendorKind]);

  // Receipt-photo handling. A phone snap is routinely over Vercel's ~4.5 MB
  // multipart cap, which would 413 the whole cost entry (typed amount, vendor,
  // hours and all) at the edge — the worst kind of loss for a field crew member
  // (audit U1). Shrink an oversized image under the cap on the client; if it
  // can't be shrunk (a big PDF, or HEIC we can't decode), reject the pick with a
  // clear note and clear the input so the cost still saves without it.
  const receiptRef = useRef<HTMLInputElement>(null);
  const shrinkingRef = useRef(false);
  const [receiptNote, setReceiptNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const onReceiptChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const f = input.files?.[0];
    if (!f) { setReceiptNote(null); return; }
    if (f.size <= SAFE_MULTIPART_BYTES) { setReceiptNote(null); return; }

    setReceiptNote({ tone: "ok", text: "Optimizing photo…" });
    shrinkingRef.current = true;
    let shrunk = f;
    try {
      shrunk = await shrinkImageUnder(f, SAFE_MULTIPART_BYTES);
    } finally {
      shrinkingRef.current = false;
    }

    if (shrunk.size > SAFE_MULTIPART_BYTES) {
      // Couldn't get it under the cap (non-image, or undecodable HEIC).
      setReceiptNote({ tone: "err", text: multipartOversizeError(f, "here") ?? "That file is too large." });
      input.value = "";
      return;
    }
    if (shrunk !== f) {
      const dt = new DataTransfer();
      dt.items.add(shrunk);
      input.files = dt.files;
      setReceiptNote({ tone: "ok", text: `Photo optimized to ${(shrunk.size / 1024 / 1024).toFixed(1)} MB so it uploads reliably.` });
    } else {
      setReceiptNote(null);
    }
  };

  // Live $/hr hint (labor only) — purely informational, never posted.
  const amtNum = parseDollars(amount);
  const hrsNum = Number(hours);
  const rate = isLabor && amtNum && Number.isFinite(hrsNum) && hrsNum > 0 ? amtNum / hrsNum : null;

  return (
    <form
      action={action}
      onSubmit={(e) => {
        // A tap that lands mid-optimization would post the original oversized
        // photo and 413 — hold the submit until the shrink finishes.
        if (shrinkingRef.current) {
          e.preventDefault();
          setReceiptNote({ tone: "ok", text: "One moment — still optimizing the photo. Tap Save again." });
        }
      }}
      className="px-3.5 pb-3.5 pt-1 space-y-3"
      encType="multipart/form-data"
    >
      <input type="hidden" name="opp_id" value={oppId} />
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="origin" value={origin} />
      {purchase && <input type="hidden" name="purchase_id" value={purchase.id} />}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLS} htmlFor="pu-category">Category</label>
          <select
            id="pu-category"
            name="category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className={SELECT_CLS}
            style={SELECT_BG_STYLE}
          >
            {categories.map(([value, label]) => (<option key={value} value={value}>{label}</option>))}
          </select>
        </div>
        <div>
          <label className={LABEL_CLS} htmlFor="pu-amount">{isLabor ? "Subcontract labor cost" : "Amount"}</label>
          <input
            id="pu-amount"
            name="amount"
            required
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={INPUT_CLS}
            placeholder="1,250.00"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={LABEL_CLS} htmlFor={vendorFieldId}>
            {vendorKind === "labor" ? "Worker / sub" : "Store / vendor"} <span className="font-normal text-ppp-charcoal-400">(optional)</span>
          </label>
          <SearchableSelect
            id={vendorFieldId}
            name="vendor"
            options={vendorOptions}
            defaultValue={initVendor}
            allowFreeText
            placeholder={vendorKind === "labor" ? "Search workers & subs…" : "Search stores…"}
            ariaLabel={vendorKind === "labor" ? "Worker or sub" : "Store or vendor"}
            createLabel={
              directoryHasVendors
                ? // "sherwin williams" IS Sherwin-Williams — no "Add" row for a
                  // spelling of a vendor that's already in the list.
                  (q) => (matchVendorByName(vendors, q) ? null : `Add “${q}” as a new ${vendorKind === "labor" ? "labor vendor" : "vendor"}`)
                : undefined
            }
            onChange={({ value, created }) => {
              setVendorText(value);
              setVendorNew(created);
            }}
          />
          {/* The escape hatch. Filtering is what Katie asked for and it is the
              right default — but a vendor tagged the wrong kind must never be
              unreachable, because the fix somebody reaches for is retyping the
              name, which splits the vendor and breaks its totals. */}
          {directoryHasVendors && wrongKindCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAllVendors((v) => !v)}
              className="mt-1 text-[11.5px] font-semibold text-ppp-charcoal-500 hover:text-cc-brand-700 underline underline-offset-2 min-h-[32px]"
            >
              {showAllVendors
                ? `Showing all vendors — show only ${vendorKind === "labor" ? "labor vendors" : "stores"}`
                : `Show all vendors (${wrongKindCount} ${vendorKind === "labor" ? "retail" : "labor"} hidden)`}
            </button>
          )}
          <input type="hidden" name={VENDOR_PICK_FIELDS.id} value={linked && !vendorNew ? linked.id : ""} />
          <input type="hidden" name={VENDOR_PICK_FIELDS.createNew} value={vendorNew && !linked ? "1" : ""} />
          {directoryHasVendors && vendorText.trim() !== "" && (
            <p
              className={`text-[11.5px] mt-1 leading-snug ${linked ? "text-emerald-700" : vendorNew ? "text-cc-brand-700" : "text-ppp-charcoal-500"}`}
              role="status"
            >
              {linked
                ? `✓ In the vendor list${linked.kind !== vendorKind ? ` (${VENDOR_KIND_META[linked.kind].label.toLowerCase()})` : ""}`
                : vendorNew
                  ? "New vendor — it’s added to the vendor list when you save."
                  : "Not in the vendor list. Pick “Add” in the list to save it for next time."}
            </p>
          )}
        </div>
        {/* Who fronted the money.
        
            PPP's field-team SOP treats a reimbursement as a FLAG on the
            purchase, not a separate record — the purchase is the receipt, and
            splitting it in two would double-count the job's cost. Leave it
            empty and this is an ordinary company purchase; put a name in and it
            joins the Reimbursements list until somebody marks it paid back. */}
        <div className="sm:col-span-2">
          <label className={LABEL_CLS} htmlFor="pu-reimburse">
            Paid out of pocket by <span className="font-normal text-ppp-charcoal-400">(optional)</span>
          </label>
          <input
            id="pu-reimburse"
            name="reimburse_to"
            list="pu-reimburse-list"
            maxLength={120}
            defaultValue={preserve?.reimburseTo ?? purchase?.reimburse_to ?? ""}
            className={INPUT_CLS}
            placeholder="Leave empty if the company paid"
          />
          <datalist id="pu-reimburse-list">
            {recentWorkers.map((v) => (<option key={v} value={v} />))}
          </datalist>
          <p className="text-[11.5px] text-ppp-charcoal-500 mt-1">
            Name someone and the company owes them for it — it shows under Accounting &rarr;
            Reimbursements until it&rsquo;s marked paid back.
          </p>
        </div>
        {isLabor ? (
          <div>
            <label className={LABEL_CLS} htmlFor="pu-hours">Hours <span className="font-normal text-ppp-charcoal-400">(optional)</span></label>
            <input
              id="pu-hours"
              name="hours"
              inputMode="decimal"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className={INPUT_CLS}
              placeholder="40"
            />
            {rate != null && (
              <p className="text-[11px] text-ppp-charcoal-500 mt-1 tabular-nums">≈ {money(rate)}/hr</p>
            )}
          </div>
        ) : (
          <div>
            <span className={LABEL_CLS}>Date</span>
            <DateField ariaLabel="Transaction date" name="purchased_at" defaultValue={defDate} placeholder="Pick a date" className="mt-1" />
          </div>
        )}
      </div>

      {/* Labor keeps its own Date row (the grid above swapped Date for Hours). */}
      {isLabor && (
        <div className="sm:max-w-[calc(50%-0.375rem)]">
          <span className={LABEL_CLS}>Date</span>
          <DateField ariaLabel="Transaction date" name="purchased_at" defaultValue={defDate} placeholder="Pick a date" className="mt-1" />
        </div>
      )}

      <div>
        <label className={LABEL_CLS} htmlFor="pu-desc">Description <span className="font-normal text-ppp-charcoal-400">(optional)</span></label>
        <textarea id="pu-desc" name="description" maxLength={2000} rows={2} defaultValue={preserve?.desc ?? purchase?.description ?? ""} className={TEXTAREA_CLS} placeholder={isLabor ? "Scope of work / notes" : "What this was for"} />
      </div>
      <div>
        <label className={LABEL_CLS} htmlFor="pu-receipt">Receipt photo <span className="font-normal text-ppp-charcoal-400">(optional)</span></label>
        {/* capture="environment" opens the camera straight away on a phone so a
            field crew member can snap the receipt in one tap (2026-08 field
            walk). HEIC/HEIF accepted so iPhone photos aren't greyed out. */}
        <input ref={receiptRef} onChange={onReceiptChange} id="pu-receipt" name="receipt" type="file" accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif" capture="environment" className="block w-full text-base sm:text-[13px] text-ppp-charcoal-600 file:mr-3 file:py-2.5 file:px-4 file:rounded-lg file:border-0 file:text-[13px] file:font-semibold file:bg-cc-brand-50 file:text-cc-brand-700 hover:file:bg-cc-brand-100 file:min-h-[44px]" />
        {receiptNote && (
          <p className={`text-[11px] mt-1 ${receiptNote.tone === "err" ? "text-rose-700" : "text-ppp-charcoal-500"}`} role={receiptNote.tone === "err" ? "alert" : "status"}>
            {receiptNote.text}
          </p>
        )}
        {purchase?.receipt_document_id && (
          <>
            <p className="text-[11px] text-emerald-700 mt-1">A receipt is on file — uploading a new one replaces it.</p>
            {/* Replacing was the only way to correct a receipt filed against
                the wrong purchase: you had to attach a different wrong one.
                A checkbox rather than its own button because this sits inside
                the edit form and a nested form would swallow the click. */}
            <label className="flex items-center gap-2 mt-1.5 text-[11px] text-ppp-charcoal-600 min-h-[44px] sm:min-h-0 cursor-pointer">
              <input type="checkbox" name="remove_receipt" value="1" className="rounded border-ppp-charcoal-300" />
              Remove the receipt on file (leaves the purchase in place)
            </label>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <PendingSubmitButton pendingLabel="Saving…" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30">{submitLabel}</PendingSubmitButton>
        {cancelHref && <Link href={cancelHref} className="px-3.5 py-2 rounded-lg border border-ppp-charcoal-200 text-[12px] font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px] inline-flex items-center">Cancel</Link>}
      </div>
    </form>
  );
}
