"use client";

/**
 * PurchaseForm — the add/edit form for a project cost (Costs & P&L, Phase 2).
 *
 * Client component so the form RESHAPES for labor: pick "Labor" and the Vendor
 * field becomes "Worker" (with a workers datalist), an Hours field appears, and
 * a live $/hr rate shows. Every other category keeps the plain vendor form.
 *
 * The worker picker is a free-text datalist today; it upgrades to the Phase 7
 * scheduling/attendance crew roster later (same field, richer source).
 *
 * `action` is a server action passed from the (server) costs tool — the form
 * still posts to the server; only the field layout is reactive here.
 */

import { useState } from "react";
import { DateField } from "@/components/commercial/date-field";
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
  origin = "",
  categories,
  recentVendors,
  recentWorkers,
  submitLabel,
  purchase,
  cancelHref,
  preserve,
}: {
  action: CoAction;
  oppId: string;
  accountId: string;
  back: string;
  /** Where the tool is rendered ("route" | "inline") so the action returns you here. */
  origin?: string;
  /** [value, label] pairs in display order. */
  categories: [string, string][];
  recentVendors: string[];
  recentWorkers: string[];
  submitLabel: string;
  purchase?: PurchaseFormPurchase;
  cancelHref?: string;
  preserve?: { cat?: string; vendor?: string; amt?: string; hours?: string; date?: string; desc?: string };
}) {
  const initCat = purchase?.category ?? preserve?.cat ?? "materials";
  const initAmt = purchase ? (purchase.amount_cents / 100).toFixed(2) : (preserve?.amt ?? "");
  const initHours =
    purchase?.hours != null ? String(purchase.hours) : (preserve?.hours ?? "");
  const defDate = purchase ? purchase.purchased_at.slice(0, 10) : (preserve?.date ?? "");

  const [category, setCategory] = useState(initCat);
  const [amount, setAmount] = useState(initAmt);
  const [hours, setHours] = useState(initHours);
  const isLabor = category === "labor";

  // Live $/hr hint (labor only) — purely informational, never posted.
  const amtNum = parseDollars(amount);
  const hrsNum = Number(hours);
  const rate = isLabor && amtNum && Number.isFinite(hrsNum) && hrsNum > 0 ? amtNum / hrsNum : null;

  return (
    <form action={action} className="px-3.5 pb-3.5 pt-1 space-y-3" encType="multipart/form-data">
      <input type="hidden" name="opp_id" value={oppId} />
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="back" value={back} />
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
          <label className={LABEL_CLS} htmlFor="pu-amount">{isLabor ? "Labor cost" : "Amount"}</label>
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
          <label className={LABEL_CLS} htmlFor="pu-vendor">
            {isLabor ? "Worker / crew" : "Store / vendor"} <span className="font-normal text-ppp-charcoal-400">(optional)</span>
          </label>
          <input
            id="pu-vendor"
            name="vendor"
            list={isLabor ? "pu-worker-list" : "pu-vendor-list"}
            maxLength={200}
            defaultValue={purchase?.vendor ?? preserve?.vendor ?? ""}
            className={INPUT_CLS}
            placeholder={isLabor ? "Worker or crew name" : "Sherwin-Williams"}
          />
          <datalist id="pu-vendor-list">
            {recentVendors.map((v) => (<option key={v} value={v} />))}
          </datalist>
          <datalist id="pu-worker-list">
            {recentWorkers.map((v) => (<option key={v} value={v} />))}
          </datalist>
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
            <DateField ariaLabel="Purchase date" name="purchased_at" defaultValue={defDate} placeholder="Pick a date" className="mt-1" />
          </div>
        )}
      </div>

      {/* Labor keeps its own Date row (the grid above swapped Date for Hours). */}
      {isLabor && (
        <div className="sm:max-w-[calc(50%-0.375rem)]">
          <span className={LABEL_CLS}>Date</span>
          <DateField ariaLabel="Purchase date" name="purchased_at" defaultValue={defDate} placeholder="Pick a date" className="mt-1" />
        </div>
      )}

      <div>
        <label className={LABEL_CLS} htmlFor="pu-desc">Description <span className="font-normal text-ppp-charcoal-400">(optional)</span></label>
        <textarea id="pu-desc" name="description" maxLength={2000} rows={2} defaultValue={purchase?.description ?? preserve?.desc ?? ""} className={TEXTAREA_CLS} placeholder={isLabor ? "Scope of work / notes" : "What was purchased"} />
      </div>
      <div>
        <label className={LABEL_CLS} htmlFor="pu-receipt">Receipt photo <span className="font-normal text-ppp-charcoal-400">(optional)</span></label>
        {/* capture="environment" opens the camera straight away on a phone so a
            field crew member can snap the receipt in one tap (2026-08 field
            walk). HEIC/HEIF accepted so iPhone photos aren't greyed out. */}
        <input id="pu-receipt" name="receipt" type="file" accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif" capture="environment" className="block w-full text-[13px] text-ppp-charcoal-600 file:mr-3 file:py-2.5 file:px-4 file:rounded-lg file:border-0 file:text-[13px] file:font-semibold file:bg-cc-brand-50 file:text-cc-brand-700 hover:file:bg-cc-brand-100 file:min-h-[44px]" />
        {purchase?.receipt_document_id && <p className="text-[11px] text-emerald-700 mt-1">A receipt is on file — uploading a new one replaces it.</p>}
      </div>
      <div className="flex items-center gap-2">
        <PendingSubmitButton pendingLabel="Saving…" className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px] touch-manipulation shadow-sm shadow-cc-brand-600/30">{submitLabel}</PendingSubmitButton>
        {cancelHref && <Link href={cancelHref} className="px-3.5 py-2 rounded-lg border border-ppp-charcoal-200 text-[12px] font-medium text-ppp-charcoal hover:bg-ppp-charcoal-50 min-h-[44px] inline-flex items-center">Cancel</Link>}
      </div>
    </form>
  );
}
