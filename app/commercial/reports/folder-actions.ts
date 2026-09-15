"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { UUID_RE } from "@/lib/commercial/uuid";
import { getReportAccess } from "@/lib/commercial/reports/access";
import { ALL_REPORTS_VIEW } from "@/lib/commercial/reports/access-rule";
import { isReportKey, reportDef } from "@/lib/commercial/reports/registry";
import {
  createFolder,
  updateFolder,
  deleteFolder,
  moveFolder,
  addReportToFolder,
  removeReportFromFolder,
  moveReportInFolder,
  type FolderScope,
} from "@/lib/commercial/reports/folders-db";

/**
 * Personal report folders — "My folders" on the Reports index.
 *
 * Anyone (admins included) can keep their own folders. They are an organised
 * VIEW, never a grant: a report can only be added if its owner can already see
 * it, and the index filters every folder through access on render anyway, so a
 * report someone later loses access to simply stops showing.
 *
 * Shared folders — the ones that DO grant access — are managed only in
 * Settings → Report folders, by admins.
 */

const BASE = "/commercial/reports";

async function actor(): Promise<{ userId: string; email: string | null | undefined; scope: FolderScope }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  await assertCommercialAccess(user.id);
  return { userId: user.id, email: user.email, scope: { kind: "personal", ownerUserId: user.id } };
}

/** Where to land after an action: the view the person was on, never a URL
 *  they typed. */
function back(formData: FormData, extra: Record<string, string> = {}, viewOverride?: string): never {
  const raw = viewOverride ?? String(formData.get("view") ?? "");
  const view = raw === ALL_REPORTS_VIEW || UUID_RE.test(raw) ? raw : "";
  const qs = new URLSearchParams();
  if (view) qs.set("folder", view);
  for (const [k, v] of Object.entries(extra)) qs.set(k, v);
  const s = qs.toString();
  revalidatePath(BASE, "layout");
  redirect(s ? `${BASE}?${s}` : BASE);
}

function folderIdFrom(formData: FormData): string | null {
  const id = String(formData.get("folder_id") ?? "");
  return UUID_RE.test(id) ? id : null;
}

export async function createPersonalFolderAction(formData: FormData) {
  const { userId, email, scope } = await actor();
  const rawKey = String(formData.get("report_key") ?? "");
  let reportKeys: ReturnType<typeof reportDef>["key"][] = [];
  if (isReportKey(rawKey)) {
    const access = await getReportAccess(userId, email);
    if (access.visible.has(rawKey)) reportKeys = [rawKey];
  }
  const res = await createFolder({ name: String(formData.get("name") ?? ""), reportKeys }, scope, userId);
  if (!res.ok) back(formData, { folder_error: res.error });
  back(formData, { notice: reportKeys.length ? `Made the folder and added ${reportDef(reportKeys[0]).title}.` : "Folder made — add reports from the ⋯ on any card." }, res.id);
}

export async function renamePersonalFolderAction(formData: FormData) {
  const { userId, scope } = await actor();
  const id = folderIdFrom(formData);
  if (!id) back(formData);
  const res = await updateFolder(id, { name: String(formData.get("name") ?? "") }, scope, userId);
  back(formData, res.ok ? { notice: "Folder renamed." } : { folder_error: res.error });
}

export async function deletePersonalFolderAction(formData: FormData) {
  const { userId, scope } = await actor();
  const id = folderIdFrom(formData);
  if (!id) back(formData);
  const res = await deleteFolder(id, scope, userId);
  // The folder is gone, so land on the default view rather than a dead id.
  back(formData, res.ok ? { notice: `Deleted “${res.name}”. The reports themselves are untouched.` } : { folder_error: res.error }, res.ok ? "" : undefined);
}

export async function movePersonalFolderAction(formData: FormData) {
  const { userId, scope } = await actor();
  const id = folderIdFrom(formData);
  const dir = String(formData.get("dir") ?? "") === "up" ? "up" : "down";
  if (!id) back(formData);
  const res = await moveFolder(id, dir, scope, userId);
  back(formData, res.ok ? {} : { folder_error: res.error });
}

export async function addReportToPersonalFolderAction(formData: FormData) {
  const { userId, email, scope } = await actor();
  const id = folderIdFrom(formData);
  const key = String(formData.get("report_key") ?? "");
  if (!id || !isReportKey(key)) back(formData);
  // Never a grant: only a report you can already open can go in your folder.
  const access = await getReportAccess(userId, email);
  if (!access.visible.has(key)) back(formData, { folder_error: "You can only add reports you can already open." });
  const res = await addReportToFolder(id, key, scope, userId);
  if (!res.ok) back(formData, { folder_error: res.error });
  back(formData, { notice: res.already ? `${reportDef(key).title} is already in “${res.name}”.` : `Added ${reportDef(key).title} to “${res.name}”.` });
}

export async function removeReportFromPersonalFolderAction(formData: FormData) {
  const { userId, scope } = await actor();
  const id = folderIdFrom(formData);
  const key = String(formData.get("report_key") ?? "");
  if (!id || !isReportKey(key)) back(formData);
  const res = await removeReportFromFolder(id, key, scope, userId);
  back(formData, res.ok ? { notice: `Took ${reportDef(key).title} out of “${res.name}”.` } : { folder_error: res.error });
}

export async function moveReportInPersonalFolderAction(formData: FormData) {
  const { userId, scope } = await actor();
  const id = folderIdFrom(formData);
  const key = String(formData.get("report_key") ?? "");
  const dir = String(formData.get("dir") ?? "") === "up" ? "up" : "down";
  if (!id || !isReportKey(key)) back(formData);
  const res = await moveReportInFolder(id, key, dir, scope, userId);
  back(formData, res.ok ? {} : { folder_error: res.error });
}
