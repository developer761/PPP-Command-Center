import "server-only";

import { dollarsToCents } from "@/lib/commercial/accounting/money";
import { isLaborPaymentCategory } from "@/lib/commercial/purchases/constants";
import { joinOtherDetail } from "@/lib/commercial/forms/other-detail";
import { addPurchase, attachPurchaseReceipt } from "@/lib/commercial/purchases/db";
import { resolvePurchaseVendor } from "@/lib/commercial/vendors/db";
import { SPEND_PRESERVE_KEYS, type SpendPreserve } from "./spend-preserve";

/**
 * Accounting's two money-out forms — "Record a labor payment" and "Record a
 * purchase" — written to the book.
 *
 * Out of the page file so it can be exercised without a browser: the bugs that
 * shipped here were all at the seam between what the form posted and what the
 * write did with it, which a source-reading test cannot see.
 *
 *   · THE VENDOR LINK. The Costs tool resolves the typed name against the
 *     vendor directory before it saves; this path never did, so every purchase
 *     Mary recorded from Accounting since 2026-09-16 was saved as bare text —
 *     44 rows, $50,091.06, on 2026-10-16 — and fell out of every per-vendor
 *     figure that reads the link. It resolves now, the same way: a name that IS
 *     a directory vendor links to it and takes the directory's spelling;
 *     anything else stays free text (this form has no "add as new vendor").
 *
 *   · WHAT SHE TYPED, ON A REFUSAL. A rejected save redirected with only the
 *     error, so the job, vendor, amount and reference she had just typed were
 *     gone. `preserve` carries them back, the Costs tool's `pu_*` convention.
 */

type Getter = { get(name: string): FormDataEntryValue | null };

const str = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v : "");

/** A bare YYYY-MM-DD anchored at noon ET, so it lands on the day picked. */
function pickedDate(raw: unknown): string | undefined {
  const d = String(raw ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T16:00:00.000Z` : undefined;
}

/** What was typed, trimmed to what a URL can reasonably carry back. */
export function readSpendPreserve(form: Getter): SpendPreserve {
  const out: SpendPreserve = {};
  for (const [key, field, max] of SPEND_PRESERVE_KEYS) {
    const v = str(form.get(field)).slice(0, max);
    if (v) out[key] = v;
  }
  return out;
}

export type RecordSpendResult =
  | { ok: true; view: "labor-out" | "purchases"; isLabor: boolean; receiptFailed: boolean }
  | { ok: false; view: "labor-out" | "purchases"; error: string; preserve: SpendPreserve };

export async function recordSpend(form: Getter, userId: string): Promise<RecordSpendResult> {
  const oppId = str(form.get("opportunity_id"));
  const cents = dollarsToCents(form.get("amount"));
  const isLabor = str(form.get("kind")) === "labor";
  const view = isLabor ? "labor-out" : "purchases";
  const refuse = (error: string): RecordSpendResult => ({ ok: false, view, error, preserve: readSpendPreserve(form) });
  /*
   * ZERO is refused; NEGATIVE is a vendor credit or a return.
   *
   * Mary, 2026-10-15: *"This applies to a Vendor invoice credit? Return?"* This
   * screen is where she enters vendor invoices, and `cents <= 0` meant she
   * could not enter the credit for one. A COST is signed, and sixteen negative
   * ones are already in the book from Salesforce. `dollarsToCents` reads both
   * "-128.40" and the accounting form "(128.40)".
   */
  if (!oppId || cents == null || cents === 0) {
    return refuse("Pick a job and enter an amount. Use a minus sign, or brackets, for a vendor credit or a return.");
  }
  // A labor payment says WHOSE labor it was. Validated against the shared list
  // rather than trusted: an unknown value would render as "Other" everywhere.
  const rawLaborCategory = str(form.get("labor_category"));
  const category = isLabor
    ? isLaborPaymentCategory(rawLaborCategory)
      ? rawLaborCategory
      : "employee_labor"
    : str(form.get("category")) || "materials";
  const hoursRaw = str(form.get("hours")).trim();

  const vendor = await resolvePurchaseVendor({
    vendorId: null,
    vendorText: str(form.get("vendor")),
    category,
    createIfNew: false,
    userId,
  });

  const res = await addPurchase({
    opportunity_id: oppId,
    category,
    vendor: vendor.vendor,
    vendor_id: vendor.vendor_id,
    amount_cents: cents,
    hours: isLabor && hoursRaw ? Number(hoursRaw) : null,
    purchased_at: pickedDate(form.get("purchased_at")),
    // "Other" with nothing else recorded the word "Other" and threw away the
    // only useful fact, so the typed value is folded into the Reference column
    // Mary reads in the list.
    description: joinOtherDetail(str(form.get("category_other")), str(form.get("description"))),
    reimburse_to: str(form.get("reimburse_to")) || null,
    created_by_user_id: userId,
  });
  if (!res.ok) return refuse(res.error);

  // The receipt, best-effort exactly as the Costs tool does it: a failed upload
  // never loses the purchase, it says so.
  let receiptFailed = false;
  const file = form.get("receipt");
  if (!isLabor && typeof File !== "undefined" && file instanceof File && file.size > 0) {
    const r = await attachPurchaseReceipt({
      purchaseId: res.value.id,
      file_name: file.name || "receipt.pdf",
      mime_type: file.type || "application/octet-stream",
      data: new Uint8Array(await file.arrayBuffer()),
      actorUserId: userId,
    }).catch(() => ({ ok: false as const }));
    receiptFailed = !r.ok;
  }
  return { ok: true, view, isLabor, receiptFailed };
}
