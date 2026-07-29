import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { isPostSaleProject } from "@/lib/commercial/opportunities/constants";
import {
  ALLOWED_CLOSEOUT_TRANSITIONS,
  DEFAULT_CLOSEOUT_ITEMS,
  isCloseoutEditable,
  type CloseoutStatus,
  type CloseoutItemKind,
  type CloseoutItemStatus,
  type CloseoutTransmittedAs,
} from "./constants";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type CloseoutPackage = {
  id: string;
  opportunity_id: string;
  account_id: string;
  status: CloseoutStatus;
  to_company: string | null;
  to_attention: string | null;
  to_address_lines: string[] | null;
  re_subject: string | null;
  transmitted_as: CloseoutTransmittedAs | null;
  remarks: string | null;
  substantial_completion_date: string | null;
  warranty_years: number;
  sent_at: string | null;
  acknowledged_at: string | null;
  completed_at: string | null;
  snapshot_document_id: string | null;
  voided_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CloseoutItem = {
  id: string;
  package_id: string;
  position: number;
  kind: CloseoutItemKind;
  label: string | null;
  included: boolean;
  item_status: CloseoutItemStatus;
  document_id: string | null;
  notes: string | null;
  created_at: string;
};

const PKG_COLS =
  "id, opportunity_id, account_id, status, to_company, to_attention, to_address_lines, re_subject, transmitted_as, remarks, substantial_completion_date, warranty_years, sent_at, acknowledged_at, completed_at, snapshot_document_id, voided_at, created_at, updated_at";

/** Load a deal's opp context (post-sale gate + account) or null. */
async function loadPostSaleOpp(
  opportunity_id: string
): Promise<{ account_id: string; substantial_completion_date?: string | null } | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at, status, sub_status, proposed_end_at")
    .eq("id", opportunity_id)
    .maybeSingle();
  const row = data as { account_id: string; deleted_at: string | null; status: string | null; sub_status: string | null; proposed_end_at: string | null } | null;
  if (!row || row.deleted_at) return null;
  if (!isPostSaleProject({ status: row.status, sub_status: row.sub_status })) return null;
  return { account_id: row.account_id, substantial_completion_date: row.proposed_end_at?.slice(0, 10) ?? null };
}

export async function listCloseoutPackages(opportunity_id: string): Promise<CloseoutPackage[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_closeout_packages")
    .select(PKG_COLS)
    .eq("opportunity_id", opportunity_id)
    .is("voided_at", null)
    .order("created_at", { ascending: false });
  return (data ?? []) as CloseoutPackage[];
}

export async function getCloseoutPackage(id: string): Promise<CloseoutPackage | null> {
  const sb = commercialDb();
  const { data } = await sb.from("commercial_closeout_packages").select(PKG_COLS).eq("id", id).maybeSingle();
  return (data as CloseoutPackage | null) ?? null;
}

export async function listCloseoutItems(package_id: string): Promise<CloseoutItem[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_closeout_items")
    .select("*")
    .eq("package_id", package_id)
    .order("position", { ascending: true });
  return (data ?? []) as CloseoutItem[];
}

export async function createCloseoutPackage(input: {
  opportunity_id: string;
  created_by_user_id: string;
  warranty_years?: number;
}): Promise<Result<CloseoutPackage>> {
  const sb = commercialDb();
  const opp = await loadPostSaleOpp(input.opportunity_id);
  if (!opp) return { ok: false, error: "Close-out packages are only for Won/in-progress projects." };

  const { data: inserted, error } = await sb
    .from("commercial_closeout_packages")
    .insert({
      opportunity_id: input.opportunity_id,
      account_id: opp.account_id,
      status: "draft",
      // Warranty starts at substantial completion; default to the deal's
      // proposed end date if we have one (the operator can adjust).
      substantial_completion_date: opp.substantial_completion_date ?? null,
      warranty_years: typeof input.warranty_years === "number" && input.warranty_years >= 0 ? input.warranty_years : 2,
      created_by_user_id: input.created_by_user_id,
    })
    .select(PKG_COLS)
    .maybeSingle();
  if (error || !inserted) return { ok: false, error: error?.message ?? "insert_failed" };
  const pkg = inserted as CloseoutPackage;
  await logInsert("commercial_closeout_packages", pkg.id, pkg, input.created_by_user_id);

  // Seed the standard close-out checklist (best-effort).
  try {
    const rows = DEFAULT_CLOSEOUT_ITEMS.map((it, i) => ({
      package_id: pkg.id,
      position: (i + 1) * 1000,
      kind: it.kind,
      included: true,
      item_status: "pending" as const,
    }));
    await sb.from("commercial_closeout_items").insert(rows);
  } catch (e) {
    console.warn("[closeout] item seed failed:", e instanceof Error ? e.message : String(e));
  }
  return { ok: true, value: pkg };
}

export async function updateCloseoutPackage(
  id: string,
  patch: Partial<Pick<CloseoutPackage, "to_company" | "to_attention" | "to_address_lines" | "re_subject" | "transmitted_as" | "remarks" | "substantial_completion_date" | "warranty_years">>,
  actorUserId: string
): Promise<Result<CloseoutPackage>> {
  const sb = commercialDb();
  const before = await getCloseoutPackage(id);
  if (!before) return { ok: false, error: "not_found" };
  if (!isCloseoutEditable(before.status)) {
    return { ok: false, error: "This package has been issued — void it and start a new one to change the cover." };
  }
  const { data, error } = await sb
    .from("commercial_closeout_packages")
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by_user_id: actorUserId })
    .eq("id", id)
    .eq("status", "draft")
    .select(PKG_COLS)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "update_failed" };
  await logUpdate("commercial_closeout_packages", id, before, data, actorUserId);
  return { ok: true, value: data as CloseoutPackage };
}

export async function changeCloseoutStatus(
  id: string,
  to: CloseoutStatus,
  actorUserId: string,
  voidReason?: string
): Promise<Result<CloseoutPackage>> {
  const sb = commercialDb();
  const before = await getCloseoutPackage(id);
  if (!before) return { ok: false, error: "not_found" };
  if (!ALLOWED_CLOSEOUT_TRANSITIONS[before.status].includes(to)) {
    return { ok: false, error: `Can't move a ${before.status} package to ${to}.` };
  }
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: to, updated_at: now, updated_by_user_id: actorUserId };
  if (to === "sent") patch.sent_at = before.sent_at ?? now;
  if (to === "acknowledged") patch.acknowledged_at = now;
  if (to === "complete") patch.completed_at = now;
  if (to === "voided") {
    patch.voided_at = now;
    patch.voided_by_user_id = actorUserId;
    patch.void_reason = voidReason ?? null;
  }
  const { data, error } = await sb
    .from("commercial_closeout_packages")
    .update(patch)
    .eq("id", id)
    .eq("status", before.status) // optimistic guard
    .select(PKG_COLS)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "status_change_failed" };
  await logUpdate("commercial_closeout_packages", id, before, data, actorUserId);
  return { ok: true, value: data as CloseoutPackage };
}

/** Upsert a checklist item. Only allowed while the package is a draft. */
export async function upsertCloseoutItem(
  input: {
    id?: string;
    package_id: string;
    kind: CloseoutItemKind;
    label?: string | null;
    included: boolean;
    item_status: CloseoutItemStatus;
    document_id?: string | null;
    notes?: string | null;
    position?: number;
  },
  actorUserId: string
): Promise<Result<CloseoutItem>> {
  const sb = commercialDb();
  const pkg = await getCloseoutPackage(input.package_id);
  if (!pkg) return { ok: false, error: "not_found" };
  // Item collection status (received/na) is a working checklist even after
  // sending — but structural edits (add/remove/kind) lock on issue. We allow
  // any field edit only on draft to keep it simple + immutable-once-issued.
  if (!isCloseoutEditable(pkg.status)) {
    return { ok: false, error: "The package has been issued — reopen a draft to edit items." };
  }
  const payload = {
    package_id: input.package_id,
    kind: input.kind,
    label: input.label ?? null,
    included: input.included,
    item_status: input.item_status,
    document_id: input.document_id ?? null,
    notes: input.notes ?? null,
    position: input.position ?? 9000,
  };
  if (input.id) {
    const { data, error } = await sb
      .from("commercial_closeout_items")
      .update(payload)
      .eq("id", input.id)
      .eq("package_id", input.package_id)
      .select("*")
      .maybeSingle();
    if (error || !data) return { ok: false, error: error?.message ?? "update_failed" };
    return { ok: true, value: data as CloseoutItem };
  }
  const { data, error } = await sb.from("commercial_closeout_items").insert(payload).select("*").maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "insert_failed" };
  await logInsert("commercial_closeout_items", (data as CloseoutItem).id, data, actorUserId);
  return { ok: true, value: data as CloseoutItem };
}

export async function deleteCloseoutItem(id: string, package_id: string): Promise<Result<true>> {
  const sb = commercialDb();
  const pkg = await getCloseoutPackage(package_id);
  if (!pkg) return { ok: false, error: "not_found" };
  if (!isCloseoutEditable(pkg.status)) {
    return { ok: false, error: "The package has been issued — reopen a draft to edit items." };
  }
  const { error } = await sb.from("commercial_closeout_items").delete().eq("id", id).eq("package_id", package_id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, value: true };
}

export async function deleteCloseoutPackage(id: string, actorUserId: string): Promise<Result<true>> {
  const sb = commercialDb();
  const before = await getCloseoutPackage(id);
  if (!before) return { ok: false, error: "not_found" };
  if (before.status !== "draft") {
    return { ok: false, error: "Only a draft close-out package can be deleted. Void an issued one instead." };
  }
  const { error } = await sb
    .from("commercial_closeout_packages")
    .update({ voided_at: new Date().toISOString(), voided_by_user_id: actorUserId, void_reason: "deleted (draft)" })
    .eq("id", id)
    .eq("status", "draft");
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_closeout_packages", id, before, actorUserId);
  return { ok: true, value: true };
}
