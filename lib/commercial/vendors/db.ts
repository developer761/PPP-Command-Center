import "server-only";

/**
 * Vendor directory data layer (Katie 2026-09-15). Service-role only — every
 * caller is a server page/action that has already passed the commercial gate.
 *
 * Writes are audit-logged. Vendors are never hard-deleted: deactivating hides
 * one from the purchase picker and leaves every past purchase linked to it.
 *
 * Tolerates the migration being un-applied (supabase/migrations/README): reads
 * return an empty directory and the purchase form falls back to free text, so
 * shipping the code before 20260915191000_commercial_vendors.sql is run breaks
 * nothing.
 */

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";
import {
  matchVendorByName,
  normalizeVendorName,
  vendorKey,
  vendorKindForCategory,
  type VendorKind,
  type VendorStatus,
} from "./constants";
import type { VendorFields } from "./input";

export type CommercialVendor = VendorFields & {
  id: string;
  status: VendorStatus;
  sf_account_ids: string[];
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** The slice the purchase picker needs — small enough to ship to the client. */
export type VendorOption = {
  id: string;
  name: string;
  kind: VendorKind;
  status: VendorStatus;
  specialty: string | null;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const TABLE = "commercial_vendors";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres unique_violation — the live lower(name) index. */
const DUPLICATE = "23505";

function duplicateNameError(name: string): string {
  return `"${name}" is already in the vendor list. Search for it instead of adding it twice.`;
}

// ────────────── Reads ──────────────

/** Every live (not deleted) vendor, A→Z. Inactive included — callers filter. */
export async function listVendors(): Promise<CommercialVendor[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .limit(5000);
  if (error) {
    console.warn("[commercial/vendors] list failed (migration applied?):", error.message);
    return [];
  }
  return (data ?? []) as CommercialVendor[];
}

/** Active vendors for the purchase picker. */
export async function listVendorOptions(): Promise<VendorOption[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from(TABLE)
    .select("id, name, kind, status, specialty")
    .is("deleted_at", null)
    .eq("status", "active")
    .order("name", { ascending: true })
    .limit(5000);
  if (error) {
    console.warn("[commercial/vendors] options failed (migration applied?):", error.message);
    return [];
  }
  return (data ?? []) as VendorOption[];
}

export async function getVendor(id: string): Promise<CommercialVendor | null> {
  if (!UUID_RE.test(id)) return null;
  const sb = commercialDb();
  const { data, error } = await sb.from(TABLE).select("*").eq("id", id).is("deleted_at", null).maybeSingle();
  if (error) return null;
  return (data as CommercialVendor | null) ?? null;
}

/** Vendor names by id, for reports that prefer the directory's spelling. */
export async function vendorNamesByIds(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter((x) => UUID_RE.test(x)))];
  if (unique.length === 0) return out;
  const sb = commercialDb();
  for (let i = 0; i < unique.length; i += 200) {
    const { data, error } = await sb.from(TABLE).select("id, name").in("id", unique.slice(i, i + 200));
    if (error) return out;
    for (const r of (data ?? []) as { id: string; name: string }[]) out.set(r.id, r.name);
  }
  return out;
}

// ────────────── Writes ──────────────

export async function createVendor(fields: VendorFields, userId: string): Promise<Result<CommercialVendor>> {
  const name = normalizeVendorName(fields.name);
  if (!name) return { ok: false, error: "Give the vendor a name." };
  const sb = commercialDb();
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from(TABLE)
    .insert({ ...fields, name, status: "active", created_by_user_id: userId, created_at: now, updated_at: now })
    .select("*")
    .maybeSingle();
  if (error || !data) {
    if (error?.code === DUPLICATE) return { ok: false, error: duplicateNameError(name) };
    return { ok: false, error: error?.message ?? "Couldn't save the vendor." };
  }
  const row = data as CommercialVendor;
  await logInsert(TABLE, row.id, row, userId);
  return { ok: true, value: row };
}

export async function updateVendor(id: string, fields: VendorFields, userId: string): Promise<Result<CommercialVendor>> {
  const before = await getVendor(id);
  if (!before) return { ok: false, error: "That vendor no longer exists." };
  const name = normalizeVendorName(fields.name);
  if (!name) return { ok: false, error: "Give the vendor a name." };
  const sb = commercialDb();
  const { data, error } = await sb
    .from(TABLE)
    .update({ ...fields, name, updated_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("*")
    .maybeSingle();
  if (error) {
    if (error.code === DUPLICATE) return { ok: false, error: duplicateNameError(name) };
    return { ok: false, error: error.message };
  }
  if (!data) return { ok: false, error: "That vendor changed in another tab — reload and try again." };
  const row = data as CommercialVendor;
  await logUpdate(TABLE, id, before, row, userId);
  return { ok: true, value: row };
}

/** Deactivate / reactivate. Never deletes: past purchases keep their link. */
export async function setVendorStatus(id: string, status: VendorStatus, userId: string): Promise<Result<CommercialVendor>> {
  const before = await getVendor(id);
  if (!before) return { ok: false, error: "That vendor no longer exists." };
  if (before.status === status) return { ok: true, value: before };
  const sb = commercialDb();
  const { data, error } = await sb
    .from(TABLE)
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("*")
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't update the vendor." };
  const row = data as CommercialVendor;
  await logUpdate(TABLE, id, before, row, userId);
  return { ok: true, value: row };
}

/**
 * Work out what a purchase's vendor IS, from what the form posted.
 *
 *   1. A picked directory vendor (vendor_id) wins, and its directory name
 *      becomes the text — so the name-grouped reports see one spelling.
 *   2. Otherwise typed text that matches a directory vendor (by vendorKey —
 *      "sherwin williams" is "Sherwin-Williams") links to it. Autofill: the
 *      crew member who typed the name instead of tapping it still gets the link.
 *   3. Otherwise, if they tapped "Add as a new vendor", it's created — kind
 *      from the purchase category — and linked.
 *   4. Otherwise it stays free text, exactly as purchases always worked.
 *
 * Never fails the purchase: any directory error (including the table not
 * existing yet) degrades to step 4. A cost that won't save because the vendor
 * list hiccupped would be a far worse bug than an unlinked name.
 */
export async function resolvePurchaseVendor(input: {
  vendorId: string | null | undefined;
  vendorText: string | null | undefined;
  category: string;
  createIfNew: boolean;
  userId: string;
}): Promise<{ vendor_id: string | null; vendor: string | null; created: boolean }> {
  const text = normalizeVendorName(input.vendorText) || null;
  try {
    if (text && input.vendorId && UUID_RE.test(input.vendorId)) {
      const picked = await getVendor(input.vendorId);
      // The picked vendor only counts if the text still says it. The picker
      // always posts the name beside the id, but a stale form must not pin
      // "Home Depot" onto a purchase whose box now says "Lowe's" — or onto one
      // whose box was cleared.
      if (picked && vendorKey(picked.name) === vendorKey(text)) {
        return { vendor_id: picked.id, vendor: picked.name, created: false };
      }
    }
    if (!text) return { vendor_id: null, vendor: null, created: false };

    const all = await listVendors();
    const match = matchVendorByName(all, text);
    if (match) return { vendor_id: match.id, vendor: match.name, created: false };

    if (input.createIfNew) {
      const res = await createVendor(
        {
          name: text,
          kind: vendorKindForCategory(input.category),
          specialty: null,
          contact_name: null,
          phone: null,
          email: null,
          website: null,
          address_line1: null,
          city: null,
          state: null,
          zip: null,
          payment_terms: null,
          preferred_payment: null,
          w9_on_file: false,
          compliance_status: null,
          notes: "Added from a purchase — fill in contact details in Settings → Vendors.",
        },
        input.userId
      );
      if (res.ok) return { vendor_id: res.value.id, vendor: res.value.name, created: true };
      // A racing tab added the same name a moment ago — link to that one.
      const again = matchVendorByName(await listVendors(), text);
      if (again) return { vendor_id: again.id, vendor: again.name, created: false };
    }
  } catch (err) {
    console.warn("[commercial/vendors] resolve failed, saving as free text:", err instanceof Error ? err.message : String(err));
  }
  return { vendor_id: null, vendor: text, created: false };
}
