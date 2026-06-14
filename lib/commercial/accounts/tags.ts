import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logDelete } from "@/lib/commercial/audit-log";

/**
 * Account tags — free-form multi-select labels attached to commercial
 * accounts (Hospitality / Healthcare / Property Mgmt / etc.). Distinct
 * from `industry` which is a single canonical string.
 *
 * No catalog table — the picker UI suggests from what's been used
 * elsewhere. Tags emerge naturally as the team adds them.
 *
 * Case-insensitive uniqueness per account: "Hospitality" and
 * "hospitality" treated as the same. Stored with the original casing
 * the user typed.
 */

export const MAX_TAG_LENGTH = 50;

export type AccountTag = {
  id: string;
  account_id: string;
  tag: string;
  created_at: string;
  created_by_user_id: string | null;
};

/** Normalize a user-typed tag — trim whitespace, collapse internal
 *  spaces. Casing preserved (the storage layer dedupes on lower()). */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Tags attached to a single account, ordered alphabetically (case-
 *  insensitive). */
export async function listAccountTags(accountId: string): Promise<AccountTag[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_account_tags")
    .select("*")
    .eq("account_id", accountId);
  if (error) {
    console.warn("[commercial/tags] listAccountTags failed:", error.message);
    return [];
  }
  const rows = (data ?? []) as AccountTag[];
  return rows.sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));
}

/** Bulk-load tags for a set of accounts, keyed by account_id. Used by
 *  the list page so each row's pills are an O(1) lookup. */
export async function listTagsForAccounts(
  accountIds: string[]
): Promise<Map<string, AccountTag[]>> {
  if (accountIds.length === 0) return new Map();
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_account_tags")
    .select("*")
    .in("account_id", accountIds);
  if (error) {
    console.warn("[commercial/tags] listTagsForAccounts failed:", error.message);
    return new Map();
  }
  const out = new Map<string, AccountTag[]>();
  for (const row of (data ?? []) as AccountTag[]) {
    const existing = out.get(row.account_id) ?? [];
    existing.push(row);
    out.set(row.account_id, existing);
  }
  // Sort each account's tags A→Z (case-insensitive) for stable UI.
  for (const list of out.values()) {
    list.sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));
  }
  return out;
}

/** Distinct tag values across all accounts. Drives the list-page
 *  filter dropdown + the "suggested tags" UX on the picker. */
export async function listAllDistinctTags(): Promise<string[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_account_tags")
    .select("tag");
  if (error) {
    console.warn("[commercial/tags] listAllDistinctTags failed:", error.message);
    return [];
  }
  // Dedupe case-insensitively, preserve the first-seen casing.
  const seen = new Map<string, string>();
  for (const row of (data ?? []) as { tag: string }[]) {
    const key = row.tag.toLowerCase();
    if (!seen.has(key)) seen.set(key, row.tag);
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" })
  );
}

/** Attach a tag to an account. Returns the new junction row id.
 *  Idempotent: if the same tag (case-insensitively) already attached,
 *  returns a friendly error rather than a constraint violation.
 *  Refuses to attach to a soft-deleted account — otherwise a restored
 *  account would come back with phantom tags. */
export async function addAccountTag(
  accountId: string,
  rawTag: string,
  createdByUserId?: string | null
): Promise<{ ok: true; tag_id: string } | { ok: false; error: string }> {
  const tag = normalizeTag(rawTag);
  if (tag.length === 0) return { ok: false, error: "Tag can't be empty." };
  if (tag.length > MAX_TAG_LENGTH) {
    return { ok: false, error: `Tag too long (max ${MAX_TAG_LENGTH} chars).` };
  }

  const sb = commercialDb();
  // Guard against tagging a soft-deleted account.
  const { data: account } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", accountId)
    .maybeSingle();
  if (!account || account.deleted_at) {
    return { ok: false, error: "Account not found." };
  }

  const { data, error } = await sb
    .from("commercial_account_tags")
    .insert({
      account_id: accountId,
      tag,
      created_by_user_id: createdByUserId ?? null,
    })
    .select("*")
    .single();

  if (error) {
    if (error.message.toLowerCase().includes("duplicate")) {
      return { ok: false, error: `"${tag}" is already tagged on this account.` };
    }
    return { ok: false, error: error.message };
  }
  const row = data as AccountTag;
  await logInsert("commercial_account_tags", row.id, row, createdByUserId);
  return { ok: true, tag_id: row.id };
}

/** Remove a tag from an account by id. Hard delete on the junction;
 *  audit log captures the before snapshot. Requires the caller to pass
 *  the expected account_id — guards against a stray tag UUID from one
 *  account being used to delete on another (IDOR). */
export async function removeAccountTag(
  accountId: string,
  tagId: string,
  removedByUserId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_account_tags")
    .select("*")
    .eq("id", tagId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Tag not found." };

  const { error } = await sb
    .from("commercial_account_tags")
    .delete()
    .eq("id", tagId)
    .eq("account_id", accountId);
  if (error) return { ok: false, error: error.message };

  await logDelete("commercial_account_tags", tagId, before, removedByUserId);
  return { ok: true };
}
