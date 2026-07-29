import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { type TaxJurisdictionLite } from "./constants";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type TaxJurisdiction = TaxJurisdictionLite & {
  notes: string | null;
  created_at: string;
  updated_at: string;
};

const COLS = "id, name, combined_rate_thou, zip_prefixes, verified, active, notes, created_at, updated_at";

export async function listTaxJurisdictions(opts: { activeOnly?: boolean } = {}): Promise<TaxJurisdiction[]> {
  const sb = commercialDb();
  let q = sb.from("commercial_tax_jurisdictions").select(COLS).order("name", { ascending: true });
  if (opts.activeOnly) q = q.eq("active", true);
  const { data } = await q;
  return (data ?? []) as TaxJurisdiction[];
}

function cleanPrefixes(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean)
    .slice(0, 200);
}

export async function createTaxJurisdiction(input: {
  name: string;
  combined_rate_thou: number;
  zip_prefixes_raw: string;
  verified?: boolean;
  notes?: string | null;
  actorUserId: string;
}): Promise<Result<TaxJurisdiction>> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name is required." };
  const rateThou = Math.round(input.combined_rate_thou);
  if (!Number.isFinite(rateThou) || rateThou < 0 || rateThou > 20000) return { ok: false, error: "Rate must be between 0% and 20%." };
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_tax_jurisdictions")
    .insert({
      name,
      combined_rate_thou: rateThou,
      zip_prefixes: cleanPrefixes(input.zip_prefixes_raw),
      verified: !!input.verified,
      notes: input.notes?.trim() || null,
      created_by_user_id: input.actorUserId,
    })
    .select(COLS)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "insert_failed" };
  await logInsert("commercial_tax_jurisdictions", (data as TaxJurisdiction).id, data, input.actorUserId);
  return { ok: true, value: data as TaxJurisdiction };
}

export async function updateTaxJurisdiction(
  id: string,
  patch: { name?: string; combined_rate_thou?: number; zip_prefixes_raw?: string; verified?: boolean; active?: boolean; notes?: string | null },
  actorUserId: string
): Promise<Result<TaxJurisdiction>> {
  const sb = commercialDb();
  const { data: before } = await sb.from("commercial_tax_jurisdictions").select(COLS).eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "not_found" };
  const clean: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by_user_id: actorUserId };
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) return { ok: false, error: "Name is required." };
    clean.name = n;
  }
  if (patch.combined_rate_thou !== undefined) {
    const rateThou = Math.round(patch.combined_rate_thou);
    if (!Number.isFinite(rateThou) || rateThou < 0 || rateThou > 20000) return { ok: false, error: "Rate must be between 0% and 20%." };
    clean.combined_rate_thou = rateThou;
  }
  if (patch.zip_prefixes_raw !== undefined) clean.zip_prefixes = cleanPrefixes(patch.zip_prefixes_raw);
  if (patch.verified !== undefined) clean.verified = patch.verified;
  if (patch.active !== undefined) clean.active = patch.active;
  if (patch.notes !== undefined) clean.notes = patch.notes?.trim() || null;
  const { data, error } = await sb.from("commercial_tax_jurisdictions").update(clean).eq("id", id).select(COLS).maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "update_failed" };
  await logUpdate("commercial_tax_jurisdictions", id, before as Record<string, unknown>, data, actorUserId);
  return { ok: true, value: data as TaxJurisdiction };
}

export async function deleteTaxJurisdiction(id: string, actorUserId: string): Promise<Result<true>> {
  const sb = commercialDb();
  const { data: before } = await sb.from("commercial_tax_jurisdictions").select(COLS).eq("id", id).maybeSingle();
  if (!before) return { ok: false, error: "not_found" };
  const { error } = await sb.from("commercial_tax_jurisdictions").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_tax_jurisdictions", id, before as Record<string, unknown>, actorUserId);
  return { ok: true, value: true };
}
