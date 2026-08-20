import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { etDateOf } from "@/lib/date-et";
import { purchaseCategoryLabel } from "@/lib/commercial/purchases/constants";

/**
 * Change orders & vendor spend — the two halves of "what did the job cost us
 * that the contract didn't cover".
 *
 * ── Change orders ────────────────────────────────────────────────────────
 *
 * - **Adds and deducts are never netted.** `amount_cents` is signed, so a job
 *   with $50k added and $50k credited back nets to zero — and "no change
 *   orders this quarter" would be a lie about $100k of scope movement. They
 *   are counted and totalled separately.
 *
 * - **Approval rate excludes pending**, the same rule as the estimator's win
 *   rate. A CO awaiting a decision is not a rejection, and counting it as one
 *   makes the number move when nothing has happened.
 *
 * - **Approved-but-unbilled is the number worth having.** A CO that is
 *   approved and carries no invoice is work the GC has agreed to pay for that
 *   nobody has asked them for. It is the only figure here that is money
 *   currently on the floor.
 *
 * ── Vendor spend ─────────────────────────────────────────────────────────
 *
 * - **`vendor` is free text**, so "Sherwin Williams", "sherwin-williams" and
 *   "Sherwin Williams Co." are three rows unless something joins them. They
 *   are grouped on a normalised key (case, punctuation and common suffixes
 *   removed) while the most-used spelling is what gets displayed — and the
 *   report says when a group merged variants, because silently merging two
 *   real vendors would be worse than splitting one.
 */

export type CoBucket = {
  count: number;
  cents: number;
};

export type CoByAccount = {
  accountId: string;
  accountName: string;
  approvedCount: number;
  approvedAddCents: number;
  approvedDeductCents: number;
  pendingCount: number;
  declinedCount: number;
};

export type VendorRow = {
  key: string;
  name: string;
  cents: number;
  count: number;
  /** Distinct spellings folded into this row. >1 means names were merged. */
  variants: number;
  topCategory: string;
};

export type CategoryRow = { category: string; label: string; cents: number; count: number };

export type ChangeOrderVendorReport = {
  co: {
    raised: number;
    approved: CoBucket;
    declined: CoBucket;
    pending: CoBucket;
    /** Approved adds and deducts, kept apart on purpose. */
    approvedAddCents: number;
    approvedDeductCents: number;
    /** approved ÷ (approved + declined). Null when nothing is decided. */
    approvalRatePct: number | null;
    /** Mean days from raised to decided, over decided COs. */
    avgDaysToDecide: number | null;
    decidedSample: number;
    /** Approved, not yet on any invoice — money agreed and never asked for. */
    unbilledCount: number;
    unbilledCents: number;
    /** Approved CREDIT change orders never billed back — kept apart so they
     *  can't net against the adds above. */
    unbilledCreditCount: number;
    unbilledCreditCents: number;
    byAccount: CoByAccount[];
  };
  vendors: VendorRow[];
  categories: CategoryRow[];
  vendorTotalCents: number;
  /** Purchases with no vendor recorded — can't be attributed to anyone. */
  unattributedCount: number;
  unattributedCents: number;
};

const EMPTY_BUCKET: CoBucket = { count: 0, cents: 0 };

/** The shape this report returns when there is nothing to report. Exported
 *  so a page can degrade one card instead of failing whole. */
export const EMPTY: ChangeOrderVendorReport = {
  co: {
    raised: 0,
    approved: { ...EMPTY_BUCKET },
    declined: { ...EMPTY_BUCKET },
    pending: { ...EMPTY_BUCKET },
    approvedAddCents: 0,
    approvedDeductCents: 0,
    approvalRatePct: null,
    avgDaysToDecide: null,
    decidedSample: 0,
    unbilledCount: 0,
    unbilledCents: 0,
    unbilledCreditCount: 0,
    unbilledCreditCents: 0,
    byAccount: [],
  },
  vendors: [],
  categories: [],
  vendorTotalCents: 0,
  unattributedCount: 0,
  unattributedCents: 0,
};

/**
 * Group key for a free-text vendor name.
 *
 * Lower-cases, drops punctuation, collapses whitespace, and strips the company
 * suffixes people type inconsistently. Deliberately conservative: it will not
 * merge "Sherwin Williams" with "Sherwin", because two genuinely different
 * vendors merged into one row is a worse error than one vendor split in two —
 * you can SEE a split, you cannot see a bad merge.
 */
export function vendorKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"()]/g, "")
    .replace(/\b(inc|llc|ltd|co|corp|company|incorporated)\b/g, "")
    .replace(/[-_/&]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(5, 7) - 1, +fromYmd.slice(8, 10));
  const b = Date.UTC(+toYmd.slice(0, 4), +toYmd.slice(5, 7) - 1, +toYmd.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

export async function getChangeOrderVendorReport(range: {
  fromYmd: string;
  toYmd: string;
}): Promise<ChangeOrderVendorReport> {
  const sb = commercialDb();

  const [cos, purchases] = await Promise.all([
    paginateAll<{
      opportunity_id: string;
      amount_cents: number;
      status: string;
      created_at: string;
      decided_at: string | null;
      invoiced_invoice_id: string | null;
    }>(() =>
      sb
        .from("commercial_change_orders")
        .select("opportunity_id, amount_cents, status, created_at, decided_at, invoiced_invoice_id")
        .is("deleted_at", null)
        .order("created_at")
        .order("id")
    ),
    paginateAll<{
      opportunity_id: string | null;
      vendor: string | null;
      category: string | null;
      amount_cents: number | null;
      purchased_at: string | null;
    }>(() =>
      sb
        .from("commercial_project_purchases")
        .select("opportunity_id, vendor, category, amount_cents, purchased_at")
        .is("deleted_at", null)
        .order("purchased_at")
        .order("id")
    ),
  ]);

  if (cos.length === 0 && purchases.length === 0) return EMPTY;

  // Which invoices are still DRAFTS. A change order parked on a draft has not
  // been billed to the customer, and treating the pointer alone as "billed"
  // hid exactly the work this report exists to surface.
  const pointedInvoiceIds = [...new Set(cos.map((c) => c.invoiced_invoice_id).filter(Boolean))] as string[];
  const draftInvoiceIds = new Set<string>();
  if (pointedInvoiceIds.length > 0) {
    const { data: invRows } = await sb
      .from("commercial_invoices")
      .select("id, status")
      .in("id", pointedInvoiceIds);
    for (const r of (invRows ?? []) as { id: string; status: string }[]) {
      if (r.status === "draft") draftInvoiceIds.add(r.id);
    }
  }

  // ── Change orders, keyed on when they were RAISED ──────────────────────
  const inWindow = cos.filter((c) => {
    const d = etDateOf(c.created_at);
    return d !== null && d >= range.fromYmd && d <= range.toYmd;
  });

  const out: ChangeOrderVendorReport = {
    ...EMPTY,
    co: { ...EMPTY.co, approved: { ...EMPTY_BUCKET }, declined: { ...EMPTY_BUCKET }, pending: { ...EMPTY_BUCKET }, byAccount: [] },
    vendors: [],
    categories: [],
  };

  const oppIds = [...new Set([...inWindow.map((c) => c.opportunity_id), ...purchases.map((p) => p.opportunity_id)].filter(Boolean))] as string[];
  const accountByOpp = new Map<string, { id: string; name: string }>();
  if (oppIds.length > 0) {
    const rows = await paginateAll<{ id: string; account_id: string | null }>(() =>
      sb.from("commercial_opportunities").select("id, account_id").in("id", oppIds).is("deleted_at", null)
    );
    const accIds = [...new Set(rows.map((r) => r.account_id).filter(Boolean))] as string[];
    const nameById = new Map<string, string>();
    if (accIds.length > 0) {
      const { data } = await sb.from("commercial_accounts").select("id, company_name").in("id", accIds);
      for (const a of (data ?? []) as { id: string; company_name: string | null }[]) {
        nameById.set(a.id, a.company_name?.trim() || "Unnamed account");
      }
    }
    for (const r of rows) {
      if (r.account_id) accountByOpp.set(r.id, { id: r.account_id, name: nameById.get(r.account_id) ?? "Unnamed account" });
    }
  }

  // ── "Approved, never invoiced" is a STOCK, not a flow ───────────────────
  // This is the one number here that is money on the floor, so it runs over
  // EVERY change order, not the date window. It used to be tallied inside the
  // `inWindow` loop, which meant a CO raised last November and still unbilled
  // simply vanished from the banner once the default range rolled over to this
  // year — and the banner hides itself at count 0, so nothing hinted that
  // $200k of agreed work was sitting uncollected. Raised / approval-rate /
  // days-to-decide are genuinely flows and stay on the window.
  for (const c of cos) {
    if (c.status !== "approved") continue;
    const amount = Number(c.amount_cents) || 0;
    const billed = Boolean(c.invoiced_invoice_id) && !draftInvoiceIds.has(c.invoiced_invoice_id!);
    if (billed) continue;
    if (amount > 0) {
      out.co.unbilledCount += 1;
      out.co.unbilledCents += amount;
    } else if (amount < 0) {
      // A stranded CREDIT is also unbilled work — the GC is owed it back. Kept
      // in its own bucket so it can't net against the adds and report "nothing
      // outstanding" when both sides are large.
      out.co.unbilledCreditCount += 1;
      out.co.unbilledCreditCents += Math.abs(amount);
    }
  }

  const byAccount = new Map<string, CoByAccount>();
  let decideDays = 0;
  let decideSample = 0;

  for (const c of inWindow) {
    const amount = Number(c.amount_cents) || 0;
    const abs = Math.abs(amount);
    out.co.raised += 1;

    const bucket =
      c.status === "approved" ? out.co.approved : c.status === "declined" ? out.co.declined : out.co.pending;
    bucket.count += 1;
    bucket.cents += abs;

    if (c.status === "approved") {
      // Kept apart — netting would let $50k of adds and $50k of credits report
      // as "no change orders".
      if (amount > 0) out.co.approvedAddCents += amount;
      else out.co.approvedDeductCents += abs;
      // A CO pointing at an UNSENT DRAFT invoice has not been billed to anyone.
      // Keying on the mere presence of the pointer marked it billed the moment
      // it was parked on a draft, so "Approved, unbilled" under-reported the
      // work Tomco has done and not yet charged for — the one number this
      // section exists to surface.
    }

    if (c.status !== "pending") {
      const raised = etDateOf(c.created_at);
      const decided = etDateOf(c.decided_at);
      if (raised && decided) {
        decideDays += Math.max(0, daysBetween(raised, decided));
        decideSample += 1;
      }
    }

    const acc = accountByOpp.get(c.opportunity_id);
    if (acc) {
      const row = byAccount.get(acc.id) ?? {
        accountId: acc.id,
        accountName: acc.name,
        approvedCount: 0,
        approvedAddCents: 0,
        approvedDeductCents: 0,
        pendingCount: 0,
        declinedCount: 0,
      };
      if (c.status === "approved") {
        row.approvedCount += 1;
        if (amount > 0) row.approvedAddCents += amount;
        else row.approvedDeductCents += abs;
      } else if (c.status === "declined") row.declinedCount += 1;
      else row.pendingCount += 1;
      byAccount.set(acc.id, row);
    }
  }

  const decided = out.co.approved.count + out.co.declined.count;
  out.co.approvalRatePct = decided > 0 ? Math.round((out.co.approved.count / decided) * 100) : null;
  out.co.avgDaysToDecide = decideSample > 0 ? Math.round(decideDays / decideSample) : null;
  out.co.decidedSample = decideSample;
  out.co.byAccount = [...byAccount.values()].sort(
    (a, b) => b.approvedAddCents - a.approvedAddCents || b.approvedCount - a.approvedCount
  );

  // ── Vendor spend ───────────────────────────────────────────────────────
  const vendors = new Map<string, { names: Map<string, number>; cents: number; count: number; cats: Map<string, number> }>();
  const categories = new Map<string, CategoryRow>();

  for (const p of purchases) {
    const d = etDateOf(p.purchased_at);
    if (!d || d < range.fromYmd || d > range.toYmd) continue;
    const amount = Number(p.amount_cents) || 0;
    if (amount === 0) continue;

    const cat = p.category ?? "other";
    const c = categories.get(cat) ?? { category: cat, label: purchaseCategoryLabel(cat), cents: 0, count: 0 };
    c.cents += amount;
    c.count += 1;
    categories.set(cat, c);
    out.vendorTotalCents += amount;

    const raw = p.vendor?.trim();
    if (!raw) {
      out.unattributedCount += 1;
      out.unattributedCents += amount;
      continue;
    }
    const key = vendorKey(raw);
    if (!key) {
      out.unattributedCount += 1;
      out.unattributedCents += amount;
      continue;
    }
    const v = vendors.get(key) ?? { names: new Map<string, number>(), cents: 0, count: 0, cats: new Map<string, number>() };
    v.names.set(raw, (v.names.get(raw) ?? 0) + 1);
    v.cents += amount;
    v.count += 1;
    v.cats.set(cat, (v.cats.get(cat) ?? 0) + amount);
    vendors.set(key, v);
  }

  out.vendors = [...vendors.entries()]
    .map(([key, v]) => {
      // Display the spelling used most — the one people will recognise.
      const name = [...v.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const topCat = [...v.cats.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return { key, name, cents: v.cents, count: v.count, variants: v.names.size, topCategory: purchaseCategoryLabel(topCat) };
    })
    .sort((a, b) => b.cents - a.cents);

  out.categories = [...categories.values()].sort((a, b) => b.cents - a.cents);

  return out;
}
