/**
 * Project purchases / job-cost categories (Phase 2).
 *
 * The cost side of a project — money OUT, tagged to a deal. Kept entirely
 * separate from invoicing (what we charge the customer never changes with cost).
 * These categories drive the per-category P&L breakdown + tones.
 */

export const PURCHASE_CATEGORIES = [
  "materials",
  "labor",
  // Mary, 2026-09-24: "Can you add in the drop down a Labor option or similar?
  // I am logging payouts under Sub which is not accurate for our employees."
  //
  // She is right, and the old assumption is what made it wrong. `labor` was
  // labelled "Subcontract labor" because in-house W-2 crew cost was supposed to
  // arrive as a separate auto line priced from a rate card. Tomco now pay
  // employees through Gusto and the cost is broken out per job as a real payout,
  // so filing that under a subcontract heading misstates the one distinction an
  // accountant cares about — 1099 versus W-2.
  //
  // No migration: `category` is plain text and the app enforces the list.
  "employee_labor",
  "subcontractor",
  "equipment",
  "permit",
  "other",
] as const;

export type PurchaseCategory = (typeof PURCHASE_CATEGORIES)[number];

/**
 * The categories anyone can actually CHOOSE.
 *
 * Katie, 2026-09-16, having had to ask what the difference was: "just have
 * subcontract labor because that's what we use." She was right to ask — Tomco
 * pay labor companies for people's time, which is `labor`; `subcontractor` is
 * for a trade company quoting a scope, and they have never booked one. Zero
 * rows, and a category whose only effect is to make somebody ask what it means
 * is costing more than it earns.
 *
 * It stays VALID in PURCHASE_CATEGORIES — the DB CHECK allows it, and a row
 * that ever carried it must keep rendering its label rather than failing
 * validation. It is simply no longer offered. Same treatment `estimating` and
 * `solicitation` got on the opportunity sub-statuses.
 */
export const OFFERED_PURCHASE_CATEGORIES = PURCHASE_CATEGORIES.filter(
  (c) => c !== "subcontractor"
) as readonly PurchaseCategory[];

export function isPurchaseCategory(v: string): v is PurchaseCategory {
  return (PURCHASE_CATEGORIES as readonly string[]).includes(v);
}

/**
 * The categories that are a PAYMENT FOR SOMEBODY'S TIME.
 *
 * `labor` is outside help — a labor company, an individual on a 1099.
 * `employee_labor` is Tomco's own crew. Both are payouts: both carry hours,
 * both want the labor vendor picker, both belong on the Labor payments screen,
 * and neither is a "purchase" in the sense the Purchases screen means.
 *
 * It exists because `=== "labor"` was written out by hand in nine places, and
 * when `employee_labor` arrived every one of them silently excluded it — so
 * Mary's own entries were listed under Purchases beside the paint, and lost
 * their hours and their $/hr. Use this rather than adding a tenth.
 */
export const LABOR_PAYMENT_CATEGORIES = ["labor", "employee_labor"] as const;

export function isLaborPaymentCategory(v: string | null | undefined): boolean {
  return (LABOR_PAYMENT_CATEGORIES as readonly string[]).includes(String(v ?? ""));
}

export const PURCHASE_CATEGORY_META: Record<
  PurchaseCategory,
  { label: string; plural: string; tone: "cc-brand" | "ppp-blue" | "amber" | "emerald" | "charcoal" }
> = {
  materials: { label: "Materials", plural: "Materials", tone: "cc-brand" },
  // "labor" = manual 1099 / day-labor purchases (individual workers). In-house
  // W-2 crew cost is the separate auto "Crew labor" line (Option A, from time
  // entries), so this is disambiguated as "Subcontract labor".
  labor: { label: "Subcontract labor", plural: "Subcontract labor", tone: "ppp-blue" },
  // What Tomco's own employees cost a job: their share of the week's Gusto
  // liability, wages and payroll taxes together. Posting a payroll week writes
  // these, and Mary can enter one by hand for anything payroll did not cover.
  employee_labor: { label: "Employee labor", plural: "Employee labor", tone: "ppp-blue" },
  subcontractor: { label: "Subcontractor", plural: "Subcontractors", tone: "amber" },
  equipment: { label: "Equipment", plural: "Equipment", tone: "emerald" },
  permit: { label: "Permit", plural: "Permits", tone: "charcoal" },
  other: { label: "Other", plural: "Other", tone: "charcoal" },
};

export function purchaseCategoryLabel(c: string): string {
  return isPurchaseCategory(c) ? PURCHASE_CATEGORY_META[c].label : "Other";
}
