/**
 * Phase F.0 Exclusions Library — CRUD + list helpers.
 *
 * Katie 2026-07-13: a searchable library of recurring proposal exclusions
 * seeded with the 8 canonical Tomco bullets. `standard` category rows are
 * auto-added to every new proposal; `optional` rows are hand-picked via
 * <ExclusionPicker>.
 *
 * Audit-logged via logInsert/logUpdate/logDelete like every commercial
 * table. Soft-delete via `deleted_at`.
 */

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import type { ExclusionCategory } from "./constants";

export type CommercialExclusion = {
  id: string;
  text: string;
  category: ExclusionCategory;
  is_active: boolean;
  use_count: number;
  created_at: string;
  updated_at: string;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  deleted_at: string | null;
};

// ────────────── CRUD ──────────────

export type CreateExclusionInput = {
  text: string;
  category?: ExclusionCategory;
  is_active?: boolean;
  created_by_user_id?: string | null;
};

export async function createExclusion(
  input: CreateExclusionInput
): Promise<
  | { ok: true; exclusion: CommercialExclusion }
  | { ok: false; error: string }
> {
  const text = input.text.trim();
  if (!text) return { ok: false, error: "Exclusion text is required." };
  if (text.length > 500) {
    return { ok: false, error: "Exclusion text is capped at 500 characters." };
  }
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_exclusions")
    .insert({
      text,
      category: input.category ?? "optional",
      is_active: input.is_active ?? true,
      created_by_user_id: input.created_by_user_id ?? null,
      updated_by_user_id: input.created_by_user_id ?? null,
    })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const exclusion = data as CommercialExclusion;
  await logInsert(
    "commercial_exclusions",
    exclusion.id,
    exclusion,
    input.created_by_user_id ?? null
  );
  return { ok: true, exclusion };
}

export type UpdateExclusionInput = {
  id: string;
  text?: string;
  category?: ExclusionCategory;
  is_active?: boolean;
  updated_by_user_id?: string | null;
};

export async function updateExclusion(
  input: UpdateExclusionInput
): Promise<
  | { ok: true; exclusion: CommercialExclusion }
  | { ok: false; error: string }
> {
  const patch: Record<string, unknown> = {
    updated_by_user_id: input.updated_by_user_id ?? null,
  };
  if (input.text !== undefined) {
    const trimmed = input.text.trim();
    if (!trimmed) return { ok: false, error: "Exclusion text is required." };
    if (trimmed.length > 500) {
      return { ok: false, error: "Exclusion text is capped at 500 characters." };
    }
    patch.text = trimmed;
  }
  if (input.category !== undefined) patch.category = input.category;
  if (input.is_active !== undefined) patch.is_active = input.is_active;
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_exclusions")
    .select("*")
    .eq("id", input.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Exclusion not found." };
  const { data: after, error } = await sb
    .from("commercial_exclusions")
    .update(patch)
    .eq("id", input.id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  const exclusion = after as CommercialExclusion;
  await logUpdate(
    "commercial_exclusions",
    exclusion.id,
    before,
    exclusion,
    input.updated_by_user_id ?? null
  );
  return { ok: true, exclusion };
}

export async function softDeleteExclusion(
  id: string,
  actorUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_exclusions")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) return { ok: false, error: "Exclusion not found." };
  const { error } = await sb
    .from("commercial_exclusions")
    .update({
      deleted_at: new Date().toISOString(),
      updated_by_user_id: actorUserId,
    })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_exclusions", id, before, actorUserId);
  return { ok: true };
}

// ────────────── reads ──────────────

export async function getExclusion(
  id: string
): Promise<CommercialExclusion | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_exclusions")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as CommercialExclusion | null) ?? null;
}

export type ListExclusionsFilters = {
  search?: string;
  category?: ExclusionCategory | "all";
  activeOnly?: boolean;
};

export async function listExclusions(
  filters: ListExclusionsFilters = {}
): Promise<CommercialExclusion[]> {
  const sb = commercialDb();
  let q = sb.from("commercial_exclusions").select("*").is("deleted_at", null);
  if (filters.activeOnly !== false) q = q.eq("is_active", true);
  if (filters.category && filters.category !== "all")
    q = q.eq("category", filters.category);
  if (filters.search) {
    // Escape backslashes + percent for LIKE. Postgres ILIKE handles the
    // case-insensitive matching for us.
    const escaped = filters.search.replace(/[\\%_]/g, (m) => `\\${m}`);
    q = q.ilike("text", `%${escaped}%`);
  }
  q = q.order("category", { ascending: true }).order("use_count", { ascending: false }).order("text", { ascending: true });
  const { data } = await q;
  return (data as CommercialExclusion[] | null) ?? [];
}

// ────────────── proposal-side helpers ──────────────

/** Bump `use_count` for a list of exclusion ids. Fire-and-forget from
 *  the proposal Send path so the picker's "most-used" sort surfaces
 *  the exclusions Alex actually reaches for. Errors swallowed. */
export async function bumpExclusionUseCount(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const sb = commercialDb();
  // Postgres has no atomic array-in increment via supabase-js — issue a
  // single RPC-style UPDATE per row would be N round-trips; instead
  // batch via a raw SQL update using coalesce.
  const uniqueIds = Array.from(new Set(ids));
  await Promise.all(
    uniqueIds.map(async (id) => {
      const { data } = await sb
        .from("commercial_exclusions")
        .select("use_count")
        .eq("id", id)
        .maybeSingle();
      const current = (data as { use_count: number } | null)?.use_count ?? 0;
      await sb
        .from("commercial_exclusions")
        .update({ use_count: current + 1 })
        .eq("id", id);
    })
  );
}

/** Fetch the standard (auto-add) exclusions — used to pre-populate a
 *  new proposal's exclusion_ids array. */
export async function listStandardExclusions(): Promise<CommercialExclusion[]> {
  return listExclusions({ category: "standard", activeOnly: true });
}
