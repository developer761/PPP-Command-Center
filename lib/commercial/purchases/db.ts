import "server-only";

/**
 * Project purchases / job costs data layer (Phase 2). Service-role only — every
 * caller is a server action that has already passed assertCommercialAccess.
 *
 * The COST side of a project (materials/labor/subs/equipment/permits), tagged to
 * a deal. Feeds the Job P&L (Contract − Costs = Gross Margin). NEVER touches
 * invoicing — what we charge the customer is independent of what the job costs.
 */

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { uploadDocument, softDeleteDocument } from "@/lib/commercial/documents/db";
import { PURCHASE_CATEGORIES, isPurchaseCategory, type PurchaseCategory } from "./constants";

export type CommercialProjectPurchase = {
  id: string;
  opportunity_id: string;
  account_id: string;
  category: PurchaseCategory;
  vendor: string | null;
  amount_cents: number;
  /** Labor hours for this entry (labor category only; null otherwise). Phase 2
   *  labor form; upgrades to Phase 7 scheduling/attendance later. */
  hours: number | null;
  purchased_at: string;
  description: string | null;
  receipt_document_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** One worker's labor line on a project — powers the per-worker overview under
 *  the deal's Costs & P&L tab. */
export type LaborByWorker = {
  worker: string;
  hours: number;
  cost_cents: number;
  count: number;
  /** cost / hours, cents-per-hour; null when hours is 0 (no divide-by-zero). */
  rate_cents_per_hour: number | null;
};

/** Per-category cost sums for a project (or account). */
export type CostBreakdown = {
  materials: number;
  labor: number;
  subcontractor: number;
  equipment: number;
  permit: number;
  other: number;
  total: number;
  count: number;
};

export function emptyCostBreakdown(): CostBreakdown {
  return { materials: 0, labor: 0, subcontractor: 0, equipment: 0, permit: 0, other: 0, total: 0, count: 0 };
}

type Result<T> = { ok: true; value: T; warning?: string } | { ok: false; error: string };

// Supabase typed client can't resolve a long column string for a table outside
// the generated schema — sibling modules use "*" + app-side cast.
const COLS = "*";

/** Opp must exist + be live; returns its account_id (never trusted from caller). */
async function resolveOppScope(
  sb: ReturnType<typeof commercialDb>,
  oppId: string
): Promise<{ account_id: string } | null> {
  const { data } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", oppId)
    .maybeSingle();
  const row = data as { account_id: string; deleted_at: string | null } | null;
  if (!row || row.deleted_at) return null;
  return { account_id: row.account_id };
}

const DELETED_DEAL_ERROR =
  "This deal has been deleted — purchases can't be modified. Restore the deal first.";

// ────────────── Reads ──────────────

/** All live purchases for a project, newest first. */
export async function listPurchasesForProject(oppId: string): Promise<CommercialProjectPurchase[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_project_purchases")
    .select(COLS)
    .eq("opportunity_id", oppId)
    .is("deleted_at", null)
    .order("purchased_at", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) {
    // Tolerate an unapplied migration — costs read as empty rather than crashing.
    console.warn("[commercial/purchases] list failed:", error.message);
    return [];
  }
  return (data ?? []) as CommercialProjectPurchase[];
}

function foldBreakdown(rows: { category: string; amount_cents: number }[]): CostBreakdown {
  const b = emptyCostBreakdown();
  for (const r of rows) {
    const amt = Number(r.amount_cents ?? 0);
    const cat = isPurchaseCategory(r.category) ? r.category : "other";
    b[cat] += amt;
    b.total += amt;
    b.count += 1;
  }
  return b;
}

/** Per-category cost sums for ONE project. */
export async function costBreakdownForProject(oppId: string): Promise<CostBreakdown> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_project_purchases")
    .select("category, amount_cents")
    .eq("opportunity_id", oppId)
    .is("deleted_at", null);
  if (error) return emptyCostBreakdown();
  return foldBreakdown((data ?? []) as { category: string; amount_cents: number }[]);
}

/** Per-category cost sums for MANY projects at once (deal/projects list). Keyed
 *  by opportunity_id. One query — no N+1. */
export async function costBreakdownByOpp(oppIds: string[]): Promise<Map<string, CostBreakdown>> {
  const out = new Map<string, CostBreakdown>();
  const ids = [...new Set(oppIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_project_purchases")
    .select("opportunity_id, category, amount_cents")
    .in("opportunity_id", ids)
    .is("deleted_at", null);
  if (error) return out;
  const byOpp = new Map<string, { category: string; amount_cents: number }[]>();
  for (const r of (data ?? []) as { opportunity_id: string; category: string; amount_cents: number }[]) {
    const arr = byOpp.get(r.opportunity_id) ?? [];
    arr.push(r);
    byOpp.set(r.opportunity_id, arr);
  }
  for (const [opp, rows] of byOpp) out.set(opp, foldBreakdown(rows));
  return out;
}

/** Per-category cost sums for a whole account (portfolio cost tile). */
export async function costBreakdownForAccount(accountId: string): Promise<CostBreakdown> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_project_purchases")
    .select("category, amount_cents")
    .eq("account_id", accountId)
    .is("deleted_at", null);
  if (error) return emptyCostBreakdown();
  return foldBreakdown((data ?? []) as { category: string; amount_cents: number }[]);
}

/** Distinct recent vendor names on an account — powers the searchable vendor
 *  suggestions on the add-purchase form. */
export async function recentVendorsForAccount(accountId: string, limit = 200): Promise<string[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_project_purchases")
    .select("vendor")
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .not("vendor", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of (data ?? []) as { vendor: string | null }[]) {
    const v = (r.vendor ?? "").trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

/** Distinct recent WORKER names on an account (labor purchases only) — powers
 *  the worker suggestions on the labor form. Separate from vendors so the labor
 *  form doesn't suggest material suppliers. */
export async function recentWorkersForAccount(accountId: string, limit = 200): Promise<string[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_project_purchases")
    .select("vendor")
    .eq("account_id", accountId)
    .eq("category", "labor")
    .is("deleted_at", null)
    .not("vendor", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of (data ?? []) as { vendor: string | null }[]) {
    const v = (r.vendor ?? "").trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

/** Per-worker labor rollup for ONE project (labor category only). Groups live
 *  labor purchases by worker name; unnamed labor rolls up under "Unassigned". */
export async function laborByWorkerForProject(oppId: string): Promise<LaborByWorker[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_project_purchases")
    .select("vendor, amount_cents, hours")
    .eq("opportunity_id", oppId)
    .eq("category", "labor")
    .is("deleted_at", null);
  if (error) return [];
  const map = new Map<string, LaborByWorker>();
  // Cost from rows that ALSO logged hours — the ONLY numerator that makes $/hr
  // honest (audit LOW): a $1,000 row with no hours must not inflate the rate of
  // a $4,000/40hr row into $125/hr.
  const ratedCostByKey = new Map<string, number>();
  for (const r of (data ?? []) as { vendor: string | null; amount_cents: number; hours: number | null }[]) {
    const worker = (r.vendor ?? "").trim() || "Unassigned";
    const key = worker.toLowerCase();
    const cur = map.get(key) ?? { worker, hours: 0, cost_cents: 0, count: 0, rate_cents_per_hour: null };
    const cost = Number(r.amount_cents ?? 0);
    cur.cost_cents += cost;
    const h = Number(r.hours ?? 0);
    if (Number.isFinite(h) && h > 0) {
      cur.hours += h;
      ratedCostByKey.set(key, (ratedCostByKey.get(key) ?? 0) + cost);
    }
    cur.count += 1;
    map.set(key, cur);
  }
  const out = [...map.entries()].map(([key, w]) => ({
    ...w,
    // Rate uses only the cost of hours-logged rows over those hours.
    rate_cents_per_hour: w.hours > 0 ? Math.round((ratedCostByKey.get(key) ?? 0) / w.hours) : null,
  }));
  // Costliest worker first.
  out.sort((a, b) => b.cost_cents - a.cost_cents);
  return out;
}

/** Clamp an hours input to a sane non-negative number (or null). */
function sanitizeHours(hours: number | null | undefined): number | null {
  if (hours === null || hours === undefined) return null;
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  // Cap absurd values (a single labor line over 10k hours is a typo) + 2dp.
  return Math.min(Math.round(h * 100) / 100, 100000);
}

export async function getPurchase(id: string): Promise<CommercialProjectPurchase | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_project_purchases")
    .select(COLS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as CommercialProjectPurchase | null) ?? null;
}

// ────────────── Writes ──────────────

export type AddPurchaseInput = {
  opportunity_id: string;
  category: string;
  vendor?: string | null;
  amount_cents: number;
  hours?: number | null;
  purchased_at?: string | null;
  description?: string | null;
  receipt_document_id?: string | null;
  created_by_user_id: string;
};

export async function addPurchase(input: AddPurchaseInput): Promise<Result<CommercialProjectPurchase>> {
  const amount = Math.round(input.amount_cents);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter a purchase amount greater than $0." };
  }
  const category: PurchaseCategory = isPurchaseCategory(input.category) ? input.category : "other";

  const sb = commercialDb();
  const scope = await resolveOppScope(sb, input.opportunity_id);
  if (!scope) return { ok: false, error: DELETED_DEAL_ERROR };

  // Set timestamps in the app so the schema needs no DB defaults (keeps the
  // migration to short, paste-safe ADD COLUMN lines).
  const nowIso = new Date().toISOString();
  const { data: inserted, error } = await sb
    .from("commercial_project_purchases")
    .insert({
      // Generate the id in code — the column has no DB default, so an insert
      // without it fails the NOT NULL constraint.
      id: globalThis.crypto.randomUUID(),
      opportunity_id: input.opportunity_id,
      account_id: scope.account_id,
      category,
      vendor: input.vendor?.trim().slice(0, 200) || null,
      amount_cents: amount,
      // Hours only make sense for labor; drop them on any other category so an
      // edited category can't strand stale hours.
      hours: category === "labor" ? sanitizeHours(input.hours) : null,
      purchased_at: input.purchased_at ?? nowIso,
      description: input.description?.trim().slice(0, 2000) || null,
      receipt_document_id: input.receipt_document_id ?? null,
      created_by_user_id: input.created_by_user_id,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select(COLS)
    .maybeSingle();
  if (error || !inserted) return { ok: false, error: error?.message ?? "Could not save the purchase." };
  const row = inserted as CommercialProjectPurchase;
  await logInsert("commercial_project_purchases", row.id, row, input.created_by_user_id);
  return { ok: true, value: row };
}

export async function updatePurchase(
  id: string,
  patch: { category?: string; vendor?: string | null; amount_cents?: number; hours?: number | null; purchased_at?: string | null; description?: string | null },
  userId: string,
  /** Ownership guard (audit H1): the purchase must belong to this opportunity —
   *  rejects a forged purchase_id from another deal. */
  expectedOppId?: string
): Promise<Result<CommercialProjectPurchase>> {
  const before = await getPurchase(id);
  if (!before) return { ok: false, error: "Purchase not found." };
  if (expectedOppId && before.opportunity_id !== expectedOppId) return { ok: false, error: "Purchase not found." };
  if (!(await resolveOppScope(commercialDb(), before.opportunity_id))) {
    return { ok: false, error: DELETED_DEAL_ERROR };
  }

  const next: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.category !== undefined) next.category = isPurchaseCategory(patch.category) ? patch.category : "other";
  if (patch.vendor !== undefined) next.vendor = patch.vendor?.trim().slice(0, 200) || null;
  if (patch.amount_cents !== undefined) {
    const a = Math.round(patch.amount_cents);
    if (!Number.isFinite(a) || a <= 0) return { ok: false, error: "Enter a purchase amount greater than $0." };
    next.amount_cents = a;
  }
  if (patch.purchased_at !== undefined) next.purchased_at = patch.purchased_at;
  if (patch.description !== undefined) next.description = patch.description?.trim().slice(0, 2000) || null;
  // Hours track the EFFECTIVE category (post-patch): a purchase edited off the
  // labor category loses its hours; edited onto labor can gain them. This
  // prevents stale hours surviving a category flip.
  const effectiveCategory = (next.category as string | undefined) ?? before.category;
  if (effectiveCategory !== "labor") {
    // Only overwrite when it would actually change — keeps the audit diff clean.
    if (before.hours !== null) next.hours = null;
  } else if (patch.hours !== undefined) {
    next.hours = sanitizeHours(patch.hours);
  }

  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_project_purchases")
    .update(next)
    .eq("id", id)
    .is("deleted_at", null)
    .select(COLS)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "This purchase changed in another tab — reload and try again." };
  const row = data as CommercialProjectPurchase;
  await logUpdate("commercial_project_purchases", id, before, row, userId);
  return { ok: true, value: row };
}

/** Soft-delete a purchase + retire its stored receipt (never strand the doc). */
export async function deletePurchase(id: string, userId: string, expectedOppId?: string): Promise<Result<true>> {
  const before = await getPurchase(id);
  if (!before) return { ok: false, error: "Purchase not found." };
  // Ownership guard (audit H1): reject a forged purchase_id from another deal.
  if (expectedOppId && before.opportunity_id !== expectedOppId) return { ok: false, error: "Purchase not found." };
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_project_purchases")
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  if (before.receipt_document_id) {
    await softDeleteDocument(before.receipt_document_id, userId).catch(() => {});
  }
  await logDelete("commercial_project_purchases", id, before, userId);
  return { ok: true, value: true };
}

// ────────────── Receipt (stored document) ──────────────

/** Store a receipt file against a purchase: file → per-deal document (category
 *  receipt) → link onto the purchase. Replaces + retires any prior one. */
export async function attachPurchaseReceipt(input: {
  purchaseId: string;
  file_name: string;
  mime_type: string;
  data: Uint8Array;
  actorUserId: string;
}): Promise<Result<{ documentId: string }>> {
  const purchase = await getPurchase(input.purchaseId);
  if (!purchase) return { ok: false, error: "Purchase not found." };

  const uploaded = await uploadDocument({
    parent_type: "opportunity",
    parent_id: purchase.opportunity_id,
    category: "receipt",
    file_name: input.file_name,
    size_bytes: input.data.length,
    mime_type: input.mime_type,
    notes: `Receipt — ${purchase.vendor ?? "purchase"} (${(purchase.amount_cents / 100).toFixed(2)})`,
    data: input.data,
    uploaded_by_user_id: input.actorUserId,
  });
  if (!uploaded.ok) return uploaded;

  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_project_purchases")
    .update({ receipt_document_id: uploaded.document.id, updated_at: new Date().toISOString() })
    .eq("id", input.purchaseId)
    .is("deleted_at", null);
  if (error) {
    await softDeleteDocument(uploaded.document.id, input.actorUserId).catch(() => {});
    return { ok: false, error: error.message };
  }
  if (purchase.receipt_document_id && purchase.receipt_document_id !== uploaded.document.id) {
    await softDeleteDocument(purchase.receipt_document_id, input.actorUserId).catch(() => {});
  }
  return { ok: true, value: { documentId: uploaded.document.id } };
}

export async function removePurchaseReceipt(purchaseId: string, actorUserId: string): Promise<Result<true>> {
  const purchase = await getPurchase(purchaseId);
  if (!purchase) return { ok: false, error: "Purchase not found." };
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_project_purchases")
    .update({ receipt_document_id: null, updated_at: new Date().toISOString() })
    .eq("id", purchaseId)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  if (purchase.receipt_document_id) {
    await softDeleteDocument(purchase.receipt_document_id, actorUserId).catch(() => {});
  }
  return { ok: true, value: true };
}
