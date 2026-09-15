import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { personName } from "@/lib/commercial/person-name";
import { normalizeRole, type UserRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";
import { isReportKey, type ReportKey } from "./registry";
import { diffFolderReports, moveInOrder, type AccessRows } from "./access-rule";

/**
 * Report folders — database access. The access RULE lives in access-rule.ts;
 * this file only loads and writes rows.
 *
 * Tables (migration 20260915190000): commercial_report_folders,
 * commercial_report_folder_items, commercial_report_folder_members.
 */

const FOLDERS = "commercial_report_folders";
const ITEMS = "commercial_report_folder_items";
const MEMBERS = "commercial_report_folder_members";

export const FOLDER_ICONS = ["folder", "briefcase", "dollar", "hardhat", "chart", "star"] as const;
export type FolderIcon = (typeof FOLDER_ICONS)[number];
export function isFolderIcon(v: unknown): v is FolderIcon {
  return typeof v === "string" && (FOLDER_ICONS as readonly string[]).includes(v);
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

type DbError = { code?: string; message?: string } | null;

/** The migration hasn't been pasted yet. PostgREST says PGRST205; Postgres 42P01. */
export function isMissingTable(err: DbError): boolean {
  if (!err) return false;
  if (err.code === "PGRST205" || err.code === "42P01") return true;
  const msg = err.message ?? "";
  return /commercial_report_folder/i.test(msg) && /does not exist|schema cache/i.test(msg);
}
const NOT_SET_UP = "Report folders aren't set up yet — migration 20260915190000 hasn't been applied.";
function errText(err: DbError): string {
  return isMissingTable(err) ? NOT_SET_UP : err?.message ?? "Something went wrong.";
}

export type FolderView = {
  id: string;
  name: string;
  description: string | null;
  icon: FolderIcon;
  sort_order: number;
  owner_user_id: string | null;
  /** Raw keys in folder order (unfiltered by access — callers filter). */
  reportKeys: string[];
};

type FolderRowFull = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  sort_order: number | null;
  owner_user_id: string | null;
  deleted_at: string | null;
};

const FOLDER_COLS = "id, name, description, icon, sort_order, owner_user_id, deleted_at";

function toView(f: FolderRowFull, items: { folder_id: string; report_key: string; sort_order: number | null }[]): FolderView {
  return {
    id: f.id,
    name: f.name,
    description: f.description,
    icon: isFolderIcon(f.icon) ? f.icon : "folder",
    sort_order: f.sort_order ?? 0,
    owner_user_id: f.owner_user_id,
    reportKeys: items
      .filter((i) => i.folder_id === f.id)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((i) => i.report_key),
  };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * The rows the access rule needs for ONE viewer. THROWS on any error — the
 * caller (computeReportAccess) turns a throw into "no reports", i.e. fails
 * closed. Returns raw rows (removed / deleted / personal included) so the rule
 * itself, not a query filter, decides what counts.
 */
export async function loadAccessRows(userId: string): Promise<AccessRows> {
  const sb = commercialDb();
  const mem = await sb.from(MEMBERS).select("folder_id, user_id, removed_at").eq("user_id", userId).limit(500);
  if (mem.error) throw new Error(errText(mem.error));
  const memberships = (mem.data ?? []) as AccessRows["memberships"];
  const ids = [...new Set(memberships.map((m) => m.folder_id))];
  if (ids.length === 0) return { folders: [], items: [], memberships };
  const [fol, its] = await Promise.all([
    sb.from(FOLDERS).select("id, owner_user_id, deleted_at").in("id", ids),
    sb.from(ITEMS).select("folder_id, report_key, sort_order").in("folder_id", ids).limit(2000),
  ]);
  if (fol.error) throw new Error(errText(fol.error));
  if (its.error) throw new Error(errText(its.error));
  return {
    folders: (fol.data ?? []) as AccessRows["folders"],
    items: (its.data ?? []) as AccessRows["items"],
    memberships,
  };
}

/**
 * The folders a viewer's Reports index lists: shared folders (every one for an
 * admin, only their memberships otherwise) and their own personal folders.
 */
export async function listViewerFolders(
  /** null = shared folders only (Settings). */
  userId: string | null,
  isAdmin: boolean
): Promise<{ ok: true; shared: FolderView[]; personal: FolderView[] } | { ok: false; error: string; notSetUp: boolean }> {
  const sb = commercialDb();
  let sharedIds: string[] | null = null;
  if (!isAdmin) {
    if (!userId) return { ok: true, shared: [], personal: [] };
    const mem = await sb.from(MEMBERS).select("folder_id").eq("user_id", userId).is("removed_at", null).limit(500);
    if (mem.error) return { ok: false, error: errText(mem.error), notSetUp: isMissingTable(mem.error) };
    sharedIds = [...new Set(((mem.data ?? []) as { folder_id: string }[]).map((m) => m.folder_id))];
  }
  const sharedQ =
    sharedIds !== null && sharedIds.length === 0
      ? Promise.resolve({ data: [] as FolderRowFull[], error: null as DbError })
      : (() => {
          let q = sb.from(FOLDERS).select(FOLDER_COLS).is("owner_user_id", null).is("deleted_at", null);
          if (sharedIds !== null) q = q.in("id", sharedIds);
          return q.order("sort_order").order("name").limit(200);
        })();
  const personalQ = userId
    ? sb
        .from(FOLDERS)
        .select(FOLDER_COLS)
        .eq("owner_user_id", userId)
        .is("deleted_at", null)
        .order("sort_order")
        .order("name")
        .limit(200)
    : Promise.resolve({ data: [] as FolderRowFull[], error: null as DbError });
  const [shared, personal] = await Promise.all([sharedQ, personalQ]);
  if (shared.error) return { ok: false, error: errText(shared.error), notSetUp: isMissingTable(shared.error) };
  if (personal.error) return { ok: false, error: errText(personal.error), notSetUp: isMissingTable(personal.error) };
  const sharedRows = (shared.data ?? []) as FolderRowFull[];
  const personalRows = (personal.data ?? []) as FolderRowFull[];
  const allIds = [...sharedRows, ...personalRows].map((f) => f.id);
  let items: { folder_id: string; report_key: string; sort_order: number | null }[] = [];
  if (allIds.length > 0) {
    const its = await sb.from(ITEMS).select("folder_id, report_key, sort_order").in("folder_id", allIds).limit(5000);
    if (its.error) return { ok: false, error: errText(its.error), notSetUp: isMissingTable(its.error) };
    items = (its.data ?? []) as typeof items;
  }
  return {
    ok: true,
    shared: sharedRows.map((f) => toView(f, items)),
    personal: personalRows.map((f) => toView(f, items)),
  };
}

export type FolderPerson = {
  user_id: string;
  name: string;
  email: string;
  hasCommercial: boolean;
  role: UserRole;
  isActive: boolean;
};

export type AdminFolder = FolderView & {
  members: (FolderPerson & { memberId: string })[];
};

async function peopleById(userIds: string[]): Promise<Map<string, FolderPerson>> {
  const out = new Map<string, FolderPerson>();
  if (userIds.length === 0) return out;
  const sb = commercialDb();
  const { data } = await sb
    .from("profiles")
    .select("user_id, email, sf_user_name, full_name, role, is_admin, is_active, has_new_platform_access")
    .in("user_id", userIds);
  for (const p of (data ?? []) as ProfileRow[]) out.set(p.user_id, toPerson(p));
  return out;
}

type ProfileRow = {
  user_id: string;
  email: string | null;
  sf_user_name: string | null;
  full_name: string | null;
  role: string | null;
  is_admin: boolean | null;
  is_active: boolean | null;
  has_new_platform_access: boolean | null;
};
function toPerson(p: ProfileRow): FolderPerson {
  return {
    user_id: p.user_id,
    name: personName(p.sf_user_name || p.full_name, p.email, "(user)"),
    email: (p.email ?? "").trim(),
    hasCommercial: !!p.has_new_platform_access,
    role: normalizeRole(p.role, p.is_admin ?? isAdminEmail(p.email)),
    isActive: p.is_active !== false,
  };
}

/** Every shared folder with its reports and members — Settings → Report folders. */
export async function listSharedFoldersForAdmin(): Promise<{ ok: true; folders: AdminFolder[] } | { ok: false; error: string; notSetUp: boolean }> {
  const base = await listViewerFolders(null, true);
  if (!base.ok) return base;
  const ids = base.shared.map((f) => f.id);
  if (ids.length === 0) return { ok: true, folders: [] };
  const sb = commercialDb();
  const mem = await sb
    .from(MEMBERS)
    .select("id, folder_id, user_id, created_at")
    .in("folder_id", ids)
    .is("removed_at", null)
    .order("created_at")
    .limit(5000);
  if (mem.error) return { ok: false, error: errText(mem.error), notSetUp: isMissingTable(mem.error) };
  const rows = (mem.data ?? []) as { id: string; folder_id: string; user_id: string }[];
  const people = await peopleById([...new Set(rows.map((r) => r.user_id))]);
  return {
    ok: true,
    folders: base.shared.map((f) => ({
      ...f,
      members: rows
        .filter((r) => r.folder_id === f.id)
        .map((r) => ({
          memberId: r.id,
          ...(people.get(r.user_id) ?? {
            user_id: r.user_id, name: "(user)", email: "", hasCommercial: false, role: "rep" as UserRole, isActive: false,
          }),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    })),
  };
}

/** Live member count for one shared folder (the index header's "Shared with N"). */
export async function countFolderMembers(folderId: string): Promise<number | null> {
  const sb = commercialDb();
  const { count, error } = await sb
    .from(MEMBERS)
    .select("id", { count: "exact", head: true })
    .eq("folder_id", folderId)
    .is("removed_at", null);
  return error ? null : count ?? 0;
}

/** Everyone who could be put in a folder — active profiles, Commercial access
 *  or not (Jason's is off today; the picker says so rather than hiding him). */
export async function listFolderPeople(): Promise<FolderPerson[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("profiles")
    .select("user_id, email, sf_user_name, full_name, role, is_admin, is_active, has_new_platform_access")
    .neq("is_active", false)
    .order("user_id")
    .limit(1000);
  if (error) return [];
  return ((data ?? []) as ProfileRow[]).map(toPerson).sort((a, b) => a.name.localeCompare(b.name));
}

/** Admins with Commercial access — named in the "ask someone" empty state. */
export async function listCommercialAdminNames(): Promise<string[]> {
  const people = await listFolderPeople();
  return people
    .filter((p) => p.hasCommercial && p.role === "admin" && !/^developer@/i.test(p.email))
    .map((p) => p.name);
}

// ─── Writes ─────────────────────────────────────────────────────────────────

/** Who may touch a folder: admins manage SHARED folders; anyone manages their
 *  OWN personal folders. A write outside its scope reads as "not found". */
export type FolderScope = { kind: "shared" } | { kind: "personal"; ownerUserId: string };

async function folderInScope(id: string, scope: FolderScope): Promise<{ row: FolderRowFull | null; error: DbError }> {
  const sb = commercialDb();
  let q = sb.from(FOLDERS).select(FOLDER_COLS).eq("id", id).is("deleted_at", null);
  q = scope.kind === "shared" ? q.is("owner_user_id", null) : q.eq("owner_user_id", scope.ownerUserId);
  const { data, error } = await q.maybeSingle();
  return { row: (data as FolderRowFull | null) ?? null, error };
}

function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 80);
}
function cleanDescription(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
  return d || null;
}

async function siblingIds(scope: FolderScope): Promise<{ ids: string[]; error: DbError }> {
  const sb = commercialDb();
  let q = sb.from(FOLDERS).select("id").is("deleted_at", null);
  q = scope.kind === "shared" ? q.is("owner_user_id", null) : q.eq("owner_user_id", scope.ownerUserId);
  const { data, error } = await q.order("sort_order").order("name").limit(500);
  return { ids: ((data ?? []) as { id: string }[]).map((r) => r.id), error };
}

export async function createFolder(
  input: { name: string; description?: string | null; icon?: string | null; reportKeys?: ReportKey[] },
  scope: FolderScope,
  actorUserId: string
): Promise<Result<{ id: string }>> {
  const name = cleanName(input.name);
  if (!name) return { ok: false, error: "Give the folder a name." };
  const sib = await siblingIds(scope);
  if (sib.error) return { ok: false, error: errText(sib.error) };
  const sb = commercialDb();
  const row = {
    name,
    description: cleanDescription(input.description),
    icon: isFolderIcon(input.icon) ? input.icon : "folder",
    sort_order: (sib.ids.length + 1) * 10,
    owner_user_id: scope.kind === "personal" ? scope.ownerUserId : null,
    created_by_user_id: actorUserId,
  };
  const { data, error } = await sb.from(FOLDERS).insert(row).select("id").single();
  if (error) return { ok: false, error: errText(error) };
  const id = (data as { id: string }).id;
  await logInsert(FOLDERS, id, row, actorUserId);
  const keys = (input.reportKeys ?? []).filter(isReportKey);
  if (keys.length > 0) {
    const res = await sb.from(ITEMS).insert(keys.map((k, i) => ({ folder_id: id, report_key: k, sort_order: (i + 1) * 10 })));
    if (res.error) return { ok: false, error: errText(res.error) };
    await logInsert(ITEMS, id, { folder_id: id, report_keys: keys }, actorUserId);
  }
  return { ok: true, id };
}

export async function updateFolder(
  id: string,
  patch: { name?: string; description?: string | null; icon?: string | null },
  scope: FolderScope,
  actorUserId: string
): Promise<Result> {
  const { row, error } = await folderInScope(id, scope);
  if (error) return { ok: false, error: errText(error) };
  if (!row) return { ok: false, error: "That folder no longer exists." };
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) {
    const n = cleanName(patch.name);
    if (!n) return { ok: false, error: "A folder needs a name." };
    update.name = n;
  }
  if (patch.description !== undefined) update.description = cleanDescription(patch.description);
  if (patch.icon !== undefined && isFolderIcon(patch.icon)) update.icon = patch.icon;
  const sb = commercialDb();
  const res = await sb.from(FOLDERS).update(update).eq("id", id);
  if (res.error) return { ok: false, error: errText(res.error) };
  await logUpdate(FOLDERS, id, { name: row.name, description: row.description, icon: row.icon }, update, actorUserId);
  return { ok: true };
}

export async function deleteFolder(id: string, scope: FolderScope, actorUserId: string): Promise<Result<{ name: string }>> {
  const { row, error } = await folderInScope(id, scope);
  if (error) return { ok: false, error: errText(error) };
  if (!row) return { ok: false, error: "That folder no longer exists." };
  const sb = commercialDb();
  const res = await sb.from(FOLDERS).update({ deleted_at: new Date().toISOString() }).eq("id", id);
  if (res.error) return { ok: false, error: errText(res.error) };
  await logDelete(FOLDERS, id, { name: row.name, owner_user_id: row.owner_user_id }, actorUserId);
  return { ok: true, name: row.name };
}

export async function moveFolder(id: string, dir: "up" | "down", scope: FolderScope, actorUserId: string): Promise<Result> {
  const sib = await siblingIds(scope);
  if (sib.error) return { ok: false, error: errText(sib.error) };
  const next = moveInOrder(sib.ids, id, dir);
  if (!next) return { ok: true };
  const sb = commercialDb();
  for (let i = 0; i < next.length; i++) {
    const res = await sb.from(FOLDERS).update({ sort_order: (i + 1) * 10 }).eq("id", next[i]);
    if (res.error) return { ok: false, error: errText(res.error) };
  }
  await logUpdate(FOLDERS, id, { order: sib.ids }, { order: next }, actorUserId);
  return { ok: true };
}

async function currentKeys(folderId: string): Promise<{ keys: string[]; error: DbError }> {
  const sb = commercialDb();
  const { data, error } = await sb.from(ITEMS).select("report_key, sort_order").eq("folder_id", folderId).order("sort_order").limit(500);
  return { keys: ((data ?? []) as { report_key: string }[]).map((r) => r.report_key), error };
}

async function writeOrder(folderId: string, order: string[]): Promise<DbError> {
  const sb = commercialDb();
  for (let i = 0; i < order.length; i++) {
    const res = await sb.from(ITEMS).update({ sort_order: (i + 1) * 10 }).eq("folder_id", folderId).eq("report_key", order[i]);
    if (res.error) return res.error;
  }
  return null;
}

/** Replace a folder's report set from a checklist. Kept reports keep their place. */
export async function setFolderReports(id: string, wanted: string[], scope: FolderScope, actorUserId: string): Promise<Result> {
  const { row, error } = await folderInScope(id, scope);
  if (error) return { ok: false, error: errText(error) };
  if (!row) return { ok: false, error: "That folder no longer exists." };
  const cur = await currentKeys(id);
  if (cur.error) return { ok: false, error: errText(cur.error) };
  const diff = diffFolderReports(cur.keys, wanted);
  const sb = commercialDb();
  if (diff.remove.length > 0) {
    const res = await sb.from(ITEMS).delete().eq("folder_id", id).in("report_key", diff.remove);
    if (res.error) return { ok: false, error: errText(res.error) };
  }
  if (diff.add.length > 0) {
    const res = await sb.from(ITEMS).upsert(
      diff.add.map((k) => ({ folder_id: id, report_key: k, sort_order: 0 })),
      { onConflict: "folder_id,report_key", ignoreDuplicates: true }
    );
    if (res.error) return { ok: false, error: errText(res.error) };
  }
  const orderErr = await writeOrder(id, diff.order);
  if (orderErr) return { ok: false, error: errText(orderErr) };
  if (diff.add.length > 0 || diff.remove.length > 0) {
    await logUpdate(ITEMS, id, { report_keys: cur.keys }, { report_keys: diff.order }, actorUserId);
  }
  return { ok: true };
}

export async function addReportToFolder(id: string, key: ReportKey, scope: FolderScope, actorUserId: string): Promise<Result<{ name: string; already: boolean }>> {
  const { row, error } = await folderInScope(id, scope);
  if (error) return { ok: false, error: errText(error) };
  if (!row) return { ok: false, error: "That folder no longer exists." };
  const cur = await currentKeys(id);
  if (cur.error) return { ok: false, error: errText(cur.error) };
  if (cur.keys.includes(key)) return { ok: true, name: row.name, already: true };
  const sb = commercialDb();
  const res = await sb.from(ITEMS).insert({ folder_id: id, report_key: key, sort_order: (cur.keys.length + 1) * 10 });
  // A double-tap races the unique index; the second insert is not an error.
  if (res.error && res.error.code !== "23505") return { ok: false, error: errText(res.error) };
  await logInsert(ITEMS, id, { folder_id: id, report_key: key }, actorUserId);
  return { ok: true, name: row.name, already: false };
}

export async function removeReportFromFolder(id: string, key: string, scope: FolderScope, actorUserId: string): Promise<Result<{ name: string }>> {
  const { row, error } = await folderInScope(id, scope);
  if (error) return { ok: false, error: errText(error) };
  if (!row) return { ok: false, error: "That folder no longer exists." };
  const sb = commercialDb();
  const res = await sb.from(ITEMS).delete().eq("folder_id", id).eq("report_key", key);
  if (res.error) return { ok: false, error: errText(res.error) };
  await logDelete(ITEMS, id, { folder_id: id, report_key: key }, actorUserId);
  return { ok: true, name: row.name };
}

export async function moveReportInFolder(id: string, key: string, dir: "up" | "down", scope: FolderScope, actorUserId: string): Promise<Result> {
  const { row, error } = await folderInScope(id, scope);
  if (error) return { ok: false, error: errText(error) };
  if (!row) return { ok: false, error: "That folder no longer exists." };
  const cur = await currentKeys(id);
  if (cur.error) return { ok: false, error: errText(cur.error) };
  const next = moveInOrder(cur.keys, key, dir);
  if (!next) return { ok: true };
  const orderErr = await writeOrder(id, next);
  if (orderErr) return { ok: false, error: errText(orderErr) };
  await logUpdate(ITEMS, id, { report_keys: cur.keys }, { report_keys: next }, actorUserId);
  return { ok: true };
}

export async function addFolderMember(folderId: string, userId: string, actorUserId: string): Promise<Result<{ person: FolderPerson }>> {
  const { row, error } = await folderInScope(folderId, { kind: "shared" });
  if (error) return { ok: false, error: errText(error) };
  if (!row) return { ok: false, error: "That folder no longer exists." };
  const people = await peopleById([userId]);
  const person = people.get(userId);
  if (!person) return { ok: false, error: "That person doesn't have a login yet." };
  const sb = commercialDb();
  const { data, error: insErr } = await sb
    .from(MEMBERS)
    .insert({ folder_id: folderId, user_id: userId, added_by_user_id: actorUserId })
    .select("id")
    .single();
  if (insErr) {
    if (insErr.code === "23505") return { ok: false, error: `${person.name} is already in ${row.name}.` };
    return { ok: false, error: errText(insErr) };
  }
  await logInsert(MEMBERS, (data as { id: string }).id, { folder_id: folderId, user_id: userId }, actorUserId);
  return { ok: true, person };
}

export async function removeFolderMember(memberId: string, actorUserId: string): Promise<Result<{ folderId: string | null }>> {
  const sb = commercialDb();
  const { data: before, error } = await sb.from(MEMBERS).select("id, folder_id, user_id").eq("id", memberId).is("removed_at", null).maybeSingle();
  if (error) return { ok: false, error: errText(error) };
  if (!before) return { ok: true, folderId: null };
  const b = before as { id: string; folder_id: string; user_id: string };
  const res = await sb.from(MEMBERS).update({ removed_at: new Date().toISOString() }).eq("id", memberId);
  if (res.error) return { ok: false, error: errText(res.error) };
  await logDelete(MEMBERS, memberId, b, actorUserId);
  return { ok: true, folderId: b.folder_id };
}
