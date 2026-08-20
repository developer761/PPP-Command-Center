import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import {
  ALLOWED_CLOSEOUT_TRANSITIONS,
  DEFAULT_CLOSEOUT_ITEMS,
  isCloseoutEditable,
  isCloseoutItemStatusEditable,
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
  /** When the warranty letter was ISSUED to the GC — on request only (Katie:
   *  "Warranty sent ONLY as requested"). Null = never issued. Deliberately
   *  separate from `warranty_years`: the TERM applies to the job whether or not
   *  a letter was ever asked for. */
  warranty_issued_at: string | null;
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
  "id, opportunity_id, account_id, status, to_company, to_attention, to_address_lines, re_subject, transmitted_as, remarks, substantial_completion_date, warranty_years, warranty_issued_at, sent_at, acknowledged_at, completed_at, snapshot_document_id, voided_at, created_at, updated_at";

/** Load a deal's opp context (account + suggested completion date) or null. No
 *  Won-gate (Karan 2026-08: closeout is available on every deal — a bid just
 *  has no package yet). */
async function loadOppContext(
  opportunity_id: string
): Promise<{ account_id: string; substantial_completion_date?: string | null } | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at, proposed_end_at")
    .eq("id", opportunity_id)
    .maybeSingle();
  const row = data as { account_id: string; deleted_at: string | null; proposed_end_at: string | null } | null;
  if (!row || row.deleted_at) return null;
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
  const opp = await loadOppContext(input.opportunity_id);
  if (!opp) return { ok: false, error: "opportunity_not_found" };

  const { data: inserted, error } = await sb
    .from("commercial_closeout_packages")
    .insert({
      opportunity_id: input.opportunity_id,
      account_id: opp.account_id,
      status: "draft",
      // Warranty starts at substantial completion; default to the deal's
      // proposed end date if we have one (the operator can adjust).
      substantial_completion_date: opp.substantial_completion_date ?? null,
      // Tomco's standard warranty is 12 months (Brendan Dwyer VP block) — default
      // to 1 year; the operator can bump it per job.
      warranty_years: typeof input.warranty_years === "number" && input.warranty_years >= 0 ? input.warranty_years : 1,
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

  // Finishing the closeout package finishes the job: (post_sale_closed,
  // closeout) → (post_sale_closed, closed). Edge-triggered on the transition
  // INTO complete — the optimistic guard above means this line is reached once
  // per real transition even if the button is double-clicked, and a second
  // package completing on the same deal is a harmless no-op.
  //
  // The source restriction on this target is doing real work. `post_sale_closed`
  // counts as terminal, so writing it from any EARLIER status stamps
  // `decided_at` with today — and the dashboard builds its win-rate denominator
  // from raw `decided_at`, so closing an old job would quietly drag a win into
  // the wrong month. Requiring the deal to already be at `·closeout` keeps this
  // a pure sub-status refinement: same top-level status, so no `decided_at`
  // write, no status_log row, no notification.
  if (to === "complete" && before.status !== "complete") {
    try {
      const { autoAdvanceOpportunity } = await import(
        "@/lib/commercial/opportunities/auto-advance"
      );
      await autoAdvanceOpportunity({
        oppId: (data as CloseoutPackage).opportunity_id,
        target: "closed",
        artifactAt: now,
        source: "auto_advance",
        reason: "Closeout package completed",
        actingUserId: actorUserId,
      });
    } catch (err) {
      // The package IS complete; failing to refine the deal's sub-status must
      // not fail the user's action. Someone can drag the card.
      console.warn(
        "[changeCloseoutStatus] deal close-out advance failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }
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
  const isDraft = isCloseoutEditable(pkg.status);
  const canTickItems = isCloseoutItemStatusEditable(pkg.status);
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
    // Editing an EXISTING item: on a draft everything's editable; on a
    // sent/acknowledged package only the collection state (received/N-A + its
    // doc/notes) can change — the transmitted item set + kind + included stay
    // frozen. On a complete/voided package nothing changes.
    if (!isDraft && !canTickItems) {
      return { ok: false, error: "This package is closed — its checklist can't be changed." };
    }
    const { data: beforeItem } = await sb.from("commercial_closeout_items").select("*").eq("id", input.id).eq("package_id", input.package_id).maybeSingle();
    const patch = isDraft
      ? payload
      : {
          item_status: input.item_status,
          document_id: input.document_id ?? null,
          notes: input.notes ?? null,
        };
    const { data, error } = await sb
      .from("commercial_closeout_items")
      .update(patch)
      .eq("id", input.id)
      .eq("package_id", input.package_id)
      .select("*")
      .maybeSingle();
    if (error || !data) return { ok: false, error: error?.message ?? "update_failed" };
    await logUpdate("commercial_closeout_items", input.id, (beforeItem as Record<string, unknown>) ?? {}, data, actorUserId);
    return { ok: true, value: data as CloseoutItem };
  }
  // Adding a NEW item changes the transmitted set — draft only.
  if (!isDraft) {
    return { ok: false, error: "The package has been sent — reopen a draft to add or remove items." };
  }
  const { data, error } = await sb.from("commercial_closeout_items").insert(payload).select("*").maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "insert_failed" };
  await logInsert("commercial_closeout_items", (data as CloseoutItem).id, data, actorUserId);
  return { ok: true, value: data as CloseoutItem };
}

export async function deleteCloseoutItem(id: string, package_id: string, actorUserId: string): Promise<Result<true>> {
  const sb = commercialDb();
  const pkg = await getCloseoutPackage(package_id);
  if (!pkg) return { ok: false, error: "not_found" };
  if (!isCloseoutEditable(pkg.status)) {
    return { ok: false, error: "The package has been issued — reopen a draft to edit items." };
  }
  const { data: before } = await sb.from("commercial_closeout_items").select("*").eq("id", id).eq("package_id", package_id).maybeSingle();
  const { error } = await sb.from("commercial_closeout_items").delete().eq("id", id).eq("package_id", package_id);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_closeout_items", id, (before as Record<string, unknown>) ?? {}, actorUserId);
  return { ok: true, value: true };
}

export type CloseoutIndexRow = {
  id: string;
  opportunityId: string;
  accountId: string;
  accountName: string;
  dealName: string;
  status: CloseoutStatus;
  progressPct: number | null;
  warrantyThrough: string | null;
  sentAt: string | null;
  updatedAt: string;
};

/** Cross-project close-out index (the sidebar Closeout & Warranty surface). */
export async function listAllCloseoutPackages(
  opts: { search?: string; status?: string } = {}
): Promise<CloseoutIndexRow[]> {
  const sb = commercialDb();
  let q = sb
    .from("commercial_closeout_packages")
    .select("id, opportunity_id, account_id, status, substantial_completion_date, warranty_years, sent_at, updated_at")
    .is("voided_at", null)
    .order("updated_at", { ascending: false });
  if (opts.status && opts.status !== "all") q = q.eq("status", opts.status);
  const { data: pkgs } = await q;
  const rows = (pkgs ?? []) as {
    id: string;
    opportunity_id: string;
    account_id: string;
    status: CloseoutStatus;
    substantial_completion_date: string | null;
    warranty_years: number;
    sent_at: string | null;
    updated_at: string;
  }[];
  if (rows.length === 0) return [];

  const oppIds = [...new Set(rows.map((r) => r.opportunity_id))];
  const acctIds = [...new Set(rows.map((r) => r.account_id))];
  const pkgIds = rows.map((r) => r.id);
  const [{ data: oppsData }, { data: acctsData }, { data: itemsData }] = await Promise.all([
    sb.from("commercial_opportunities").select("id, title, title_override, client_name, property_street, deleted_at").in("id", oppIds),
    sb.from("commercial_accounts").select("id, company_name, deleted_at").in("id", acctIds),
    sb.from("commercial_closeout_items").select("package_id, included, item_status").in("package_id", pkgIds),
  ]);
  const oppById = new Map((((oppsData ?? []) as { id: string; deleted_at: string | null }[]).filter((o) => !o.deleted_at)).map((o) => [o.id, o as unknown as Record<string, unknown>]));
  const acctById = new Map((((acctsData ?? []) as { id: string; company_name: string | null; deleted_at: string | null }[]).filter((a) => !a.deleted_at)).map((a) => [a.id, a]));
  const itemsByPkg = new Map<string, { included: boolean; item_status: CloseoutItemStatus }[]>();
  for (const it of (itemsData ?? []) as { package_id: string; included: boolean; item_status: CloseoutItemStatus }[]) {
    const arr = itemsByPkg.get(it.package_id) ?? [];
    arr.push({ included: it.included, item_status: it.item_status });
    itemsByPkg.set(it.package_id, arr);
  }

  const { derivedOppName } = await import("@/lib/commercial/opportunities/db");
  const { computeWarrantyEndDate, closeoutProgressPct } = await import("./constants");

  let out: CloseoutIndexRow[] = [];
  for (const r of rows) {
    const opp = oppById.get(r.opportunity_id);
    const acct = acctById.get(r.account_id);
    if (!opp || !acct) continue;
    out.push({
      id: r.id,
      opportunityId: r.opportunity_id,
      accountId: r.account_id,
      accountName: acct.company_name ?? "",
      dealName: derivedOppName(opp as never, acct.company_name ?? null),
      status: r.status,
      progressPct: closeoutProgressPct(itemsByPkg.get(r.id) ?? []),
      warrantyThrough: computeWarrantyEndDate(r.substantial_completion_date, r.warranty_years),
      sentAt: r.sent_at,
      updatedAt: r.updated_at,
    });
  }
  if (opts.search && opts.search.trim()) {
    const t = opts.search.trim().toLowerCase();
    out = out.filter((r) => r.dealName.toLowerCase().includes(t) || r.accountName.toLowerCase().includes(t));
  }
  return out;
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

/**
 * Stamp the warranty letter as issued.
 *
 * Its own function, and its own timestamp, because issuing the warranty is a
 * decision rather than a step: Katie's rule is that it goes out only when the
 * GC asks, and the letter carries Brendan's signature over a twelve-month
 * guarantee. Re-issuing (a second copy, a corrected term) is allowed and simply
 * moves the date — the document trail on the deal keeps every copy.
 */
export async function markWarrantyIssued(
  id: string,
  actorUserId: string
): Promise<Result<CloseoutPackage>> {
  const sb = commercialDb();
  const before = await getCloseoutPackage(id);
  if (!before) return { ok: false, error: "not_found" };
  if (before.status === "voided") {
    return { ok: false, error: "This package is voided — nothing can be issued from it." };
  }
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from("commercial_closeout_packages")
    .update({ warranty_issued_at: now, updated_at: now, updated_by_user_id: actorUserId })
    .eq("id", id)
    .select(PKG_COLS)
    .maybeSingle();
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Couldn't record the warranty as issued." };
  }
  await logUpdate("commercial_closeout_packages", id, before, data as CloseoutPackage, actorUserId);
  return { ok: true, value: data as CloseoutPackage };
}
