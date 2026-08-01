/**
 * Change Order data layer (Phase G). Service-role only — every caller is a
 * server action or cron that has already passed assertCommercialAccess.
 *
 * Model notes:
 *  - A CO attaches to the post-sale opportunity (the "Project") + carries a
 *    denormalized account_id, mirroring commercial_invoices.
 *  - amount_cents is SIGNED. Approved COs feed the AIA net-change-orders sum
 *    (Phase H) AND the deal's "contract to date".
 *  - Phase 1A billing (setChangeOrderInvoiced): ticking an approved CO folds it
 *    onto the deal's current invoice as a LINE (flat invoice) or MILESTONE
 *    (milestone invoice) — creating a draft if there's none — linked via
 *    invoiced_invoice_id (the double-bill guard) + the CO tag on the line/
 *    milestone. A DEDUCT CO shows as a negative line/milestone (migration 093
 *    relaxes the >=0 CHECK for CO-tagged rows only), capped so the invoice never
 *    totals below $0. Untick reverses it.
 */

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import {
  createCommercialInvoice,
  notifyCommercialInvoiceCreated,
  listCommercialInvoices,
  getCommercialInvoice,
  addLineItem,
  recomputeSubtotal,
  type CommercialInvoice,
} from "@/lib/commercial/invoices/db";
import { addMilestone, deleteMilestone, listMilestonesForInvoice } from "@/lib/commercial/invoices/milestones";
import { TERMINAL_INVOICE_STATUSES } from "@/lib/commercial/invoices/constants";
import { getCommercialOpportunity } from "@/lib/commercial/opportunities/db";
import { listTaxJurisdictions } from "@/lib/commercial/tax/db";
import { resolveTaxForZip, thouToPct } from "@/lib/commercial/tax/constants";
import { formatCentsFull } from "@/lib/commercial/invoices/format";
import { formatChangeOrderNumber, type ChangeOrderStatus } from "./constants";

export type CommercialChangeOrder = {
  id: string;
  opportunity_id: string;
  account_id: string;
  co_number: number;
  title: string;
  description: string | null;
  amount_cents: number;
  status: ChangeOrderStatus;
  /** Phase G v3 — the proposal this CO amends (migration 086). Nullable. */
  proposal_id: string | null;
  decided_by_user_id: string | null;
  decided_at: string | null;
  invoiced_invoice_id: string | null;
  created_by_user_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// Supabase's typed client can't resolve a long explicit column string for a
// table that isn't in the generated schema types (→ GenericStringError). The
// sibling modules use "*" + an app-side cast; we do the same.
const COLS = "*";

/** All live COs for a project, oldest first (CO-001, CO-002 …). */
export async function listChangeOrders(opportunityId: string): Promise<CommercialChangeOrder[]> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_change_orders")
    .select(COLS)
    .eq("opportunity_id", opportunityId)
    .is("deleted_at", null)
    .order("co_number", { ascending: true });
  return (data ?? []) as CommercialChangeOrder[];
}

/** Single live CO by id. */
export async function getChangeOrder(id: string): Promise<CommercialChangeOrder | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_change_orders")
    .select(COLS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as CommercialChangeOrder | null) ?? null;
}

/**
 * Net signed value of APPROVED change orders on a project — the number the AIA
 * "net change orders" line (Phase H) consumes. Pending + declined COs are
 * excluded, so a declined CO never touches the contract sum.
 */
export async function netApprovedChangeOrderCents(opportunityId: string): Promise<number> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_change_orders")
    .select("amount_cents")
    .eq("opportunity_id", opportunityId)
    .eq("status", "approved")
    .is("deleted_at", null);
  return (data ?? []).reduce((acc, r) => acc + Number((r as { amount_cents: number }).amount_cents), 0);
}

/**
 * Given a set of invoice ids, returns the subset that are still LIVE (not
 * soft-deleted, not voided). The Change Orders panel uses this to decide, per
 * CO, whether its linked invoice still counts as "billed" (show View invoice)
 * or has been voided/removed (show the re-bill flow) — keying on liveness, not
 * on the mere presence of invoiced_invoice_id.
 */
export async function liveInvoiceIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Set();
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_invoices")
    .select("id, deleted_at, status")
    .in("id", unique);
  const live = new Set<string>();
  for (const row of (data ?? []) as { id: string; deleted_at: string | null; status: string }[]) {
    if (!row.deleted_at && row.status !== "void") live.add(row.id);
  }
  return live;
}

/**
 * Phase 1A — per-CO "where is it billed" chip data for the Change Orders tool.
 * Given the COs, returns coId → { invoiceNumber, kind } for those billed on a
 * LIVE invoice (line vs milestone). Two batched queries, no N+1.
 */
export async function billedChangeOrderChips(
  cos: CommercialChangeOrder[]
): Promise<Map<string, { invoiceId: string; invoiceNumber: string; kind: "line" | "milestone" }>> {
  const out = new Map<string, { invoiceId: string; invoiceNumber: string; kind: "line" | "milestone" }>();
  const billed = cos.filter((c) => !!c.invoiced_invoice_id);
  if (billed.length === 0) return out;
  const sb = commercialDb();
  const invIds = [...new Set(billed.map((c) => c.invoiced_invoice_id as string))];
  const [{ data: invs }, { data: msRows }] = await Promise.all([
    sb.from("commercial_invoices").select("id, invoice_number, deleted_at, status").in("id", invIds),
    sb.from("commercial_invoice_milestones").select("change_order_id").in("change_order_id", billed.map((c) => c.id)).is("deleted_at", null),
  ]);
  const liveInv = new Map<string, string>();
  for (const r of (invs ?? []) as { id: string; invoice_number: string; deleted_at: string | null; status: string }[]) {
    if (!r.deleted_at && r.status !== "void") liveInv.set(r.id, r.invoice_number);
  }
  const milestoneCoIds = new Set(
    ((msRows ?? []) as { change_order_id: string | null }[]).map((r) => r.change_order_id).filter(Boolean) as string[]
  );
  for (const c of billed) {
    const num = liveInv.get(c.invoiced_invoice_id as string);
    if (!num) continue; // invoice not live → CO reads as un-billed (re-tickable)
    out.set(c.id, {
      invoiceId: c.invoiced_invoice_id as string,
      invoiceNumber: num,
      kind: milestoneCoIds.has(c.id) ? "milestone" : "line",
    });
  }
  return out;
}

export type CreateChangeOrderInput = {
  opportunity_id: string;
  title: string;
  description?: string | null;
  amount_cents: number;
  /** Phase G v3 — the proposal this CO amends (optional). Validated against
   *  the opp before it's stored; an id that doesn't belong to the deal is
   *  dropped to null rather than rejected. */
  proposal_id?: string | null;
  created_by_user_id: string;
};

/**
 * Verify a proposal id belongs to this opportunity (chain-of-trust) before we
 * store it on a CO. Returns the id if valid + owned, else null — a stray/other-
 * deal id is silently dropped, never persisted.
 */
async function validProposalForOpp(
  sb: ReturnType<typeof commercialDb>,
  proposalId: string | null | undefined,
  opportunityId: string
): Promise<string | null> {
  if (!proposalId) return null;
  const { data } = await sb
    .from("commercial_proposals")
    .select("id")
    .eq("id", proposalId)
    .eq("opportunity_id", opportunityId)
    .is("deleted_at", null)
    .maybeSingle();
  return data ? proposalId : null;
}

/**
 * Create a pending CO. account_id is derived from the opportunity (never
 * trusted from the caller). co_number is max+1 for the opp; the UNIQUE
 * constraint catches a concurrent-insert race, which we retry once.
 */
export async function createChangeOrder(
  input: CreateChangeOrderInput
): Promise<Result<CommercialChangeOrder>> {
  const amount = Math.round(input.amount_cents);
  if (!Number.isFinite(amount) || amount === 0) {
    return { ok: false, error: "Enter a non-zero amount (use a minus sign for a deduct)." };
  }
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Give the change order a title." };

  const sb = commercialDb();

  // Chain-of-trust: opp must exist + be live; take account_id from it. No
  // Won-gate (Karan 2026-08: change orders are available on every deal — the UI
  // exposes them on bids too; a bid simply has none yet).
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at, status, sub_status")
    .eq("id", input.opportunity_id)
    .maybeSingle();
  if (!opp || (opp as { deleted_at: string | null }).deleted_at) {
    return { ok: false, error: "opportunity_not_found" };
  }
  const row = opp as { account_id: string; status: string | null; sub_status: string | null };
  const account_id = row.account_id;
  const proposal_id = await validProposalForOpp(sb, input.proposal_id, input.opportunity_id);

  for (let attempt = 0; attempt < 2; attempt++) {
    // Next per-opp CO number. Only live rows count toward the max, but the
    // UNIQUE index spans all rows — a soft-deleted CO-002 keeps its number, so
    // we compute max over ALL rows (incl. deleted) to avoid reusing it.
    const { data: last } = await sb
      .from("commercial_change_orders")
      .select("co_number")
      .eq("opportunity_id", input.opportunity_id)
      .order("co_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const co_number = ((last as { co_number: number } | null)?.co_number ?? 0) + 1;

    const { data: inserted, error } = await sb
      .from("commercial_change_orders")
      .insert({
        opportunity_id: input.opportunity_id,
        account_id,
        co_number,
        title: title.slice(0, 200),
        description: input.description?.trim().slice(0, 4000) || null,
        amount_cents: amount,
        proposal_id,
        status: "pending",
        created_by_user_id: input.created_by_user_id,
      })
      .select(COLS)
      .maybeSingle();

    if (!error && inserted) {
      const row = inserted as CommercialChangeOrder;
      await logInsert("commercial_change_orders", row.id, row, input.created_by_user_id);
      return { ok: true, value: row };
    }
    // 23505 = unique_violation → another insert grabbed this co_number. Retry.
    if (error && (error as { code?: string }).code === "23505") continue;
    return { ok: false, error: error?.message ?? "insert_failed" };
  }
  return { ok: false, error: "Couldn't assign a change-order number — please try again." };
}

/** Edit a PENDING, un-billed CO. Decided or billed COs are locked. */
export async function updateChangeOrder(
  id: string,
  patch: { title?: string; description?: string | null; amount_cents?: number; proposal_id?: string | null },
  userId: string
): Promise<Result<CommercialChangeOrder>> {
  const before = await getChangeOrder(id);
  if (!before) return { ok: false, error: "not_found" };
  if (!(await oppIsLive(before.opportunity_id))) return { ok: false, error: DELETED_DEAL_ERROR };
  if (before.status !== "pending") {
    return { ok: false, error: "Only a pending change order can be edited. Reopen it to pending first." };
  }
  if (before.invoiced_invoice_id) {
    return { ok: false, error: "This change order is already billed — it can't be edited." };
  }

  const next: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof patch.title === "string") {
    const t = patch.title.trim();
    if (!t) return { ok: false, error: "Give the change order a title." };
    next.title = t.slice(0, 200);
  }
  if (patch.description !== undefined) {
    next.description = patch.description?.trim().slice(0, 4000) || null;
  }
  if (patch.amount_cents !== undefined) {
    const amount = Math.round(patch.amount_cents);
    if (!Number.isFinite(amount) || amount === 0) {
      return { ok: false, error: "Enter a non-zero amount (use a minus sign for a deduct)." };
    }
    next.amount_cents = amount;
  }

  const sb = commercialDb();
  if (patch.proposal_id !== undefined) {
    next.proposal_id = await validProposalForOpp(sb, patch.proposal_id, before.opportunity_id);
  }
  // 2026-07-29 re-audit: CAS on status='pending' so a concurrent approve
  // can't interleave with an edit and mutate an already-decided CO.
  const { data: updated, error } = await sb
    .from("commercial_change_orders")
    .update(next)
    .eq("id", id)
    .eq("status", "pending")
    .is("deleted_at", null)
    .select(COLS)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!updated) return { ok: false, error: "This change order changed in another tab — reload and try again." };
  const row = updated as CommercialChangeOrder;
  await logUpdate("commercial_change_orders", id, before, row, userId);
  return { ok: true, value: row };
}

/**
 * Approve or decline a CO. NOTE: this is currently open to any commercial user
 * (no manager-only RBAC gate exists for commercial yet — only admin gating).
 * If CO approval should require a manager, add that gate in the calling action.
 * A CO that's already billed can't have its decision changed (would strand the
 * invoice); un-bill by voiding/deleting the invoice first.
 */
export async function decideChangeOrder(
  id: string,
  decision: "approved" | "declined",
  userId: string
): Promise<Result<CommercialChangeOrder>> {
  const before = await getChangeOrder(id);
  if (!before) return { ok: false, error: "not_found" };
  if (!(await oppIsLive(before.opportunity_id))) return { ok: false, error: DELETED_DEAL_ERROR };
  if (before.status === decision) {
    return { ok: false, error: `This change order is already ${decision}.` };
  }
  if (before.invoiced_invoice_id && (await invoiceIsLive(before.invoiced_invoice_id))) {
    return {
      ok: false,
      error: "This change order is billed — void or delete its invoice before changing the decision.",
    };
  }

  const sb = commercialDb();
  // 2026-07-29 re-audit: CAS on the status we read so two concurrent decisions
  // (or a decision racing an edit) can't both land.
  const { data: updated, error } = await sb
    .from("commercial_change_orders")
    .update({
      status: decision,
      decided_by_user_id: userId,
      decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", before.status)
    .is("deleted_at", null)
    .select(COLS)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!updated) return { ok: false, error: "This change order changed in another tab — reload and try again." };
  const row = updated as CommercialChangeOrder;
  await logUpdate("commercial_change_orders", id, before, row, userId);
  return { ok: true, value: row };
}

/**
 * Bill an approved, additive CO as its own draft invoice, then link it back.
 * Guards: must be approved; must be positive (deduct COs adjust the contract
 * sum but aren't billed — the invoice schema forbids negative totals); must
 * not already have a live invoice.
 */
// ═══════════════════════════════════════════════════════════════════════════
//  Phase 1A — the change-order billing TICK
//  Tick a CO on → fold it onto the deal's current invoice as a LINE (flat) or
//  MILESTONE (milestone invoice); no invoice → auto-create a DRAFT. Tick off →
//  peel it back off + un-bill. Deducts show as negatives, capped so the invoice
//  never totals below $0. Replaces the old per-CO-invoice button + the (unwired)
//  addChangeOrderMilestone.
// ═══════════════════════════════════════════════════════════════════════════

type TickResult =
  | { ok: true; invoice: CommercialInvoice | null; createdDraft: boolean; warning?: string }
  | { ok: false; error: string };

/** The deal's CURRENT billable invoice for a tick: newest DRAFT if one exists,
 *  else the newest non-terminal (not paid/void) invoice. Null → caller creates
 *  a draft. (listCommercialInvoices is created_at DESC, deleted_at-null.) */
async function resolveCurrentDealInvoice(oppId: string): Promise<CommercialInvoice | null> {
  const invoices = await listCommercialInvoices({ opportunityId: oppId });
  const draft = invoices.find((i) => i.status === "draft");
  if (draft) return draft;
  return invoices.find((i) => !TERMINAL_INVOICE_STATUSES.has(i.status)) ?? null;
}

/** Tax % for an auto-created draft, from the deal's property ZIP (mirrors the
 *  deal-invoice create form). 0 when no jurisdiction matches. */
async function dealTaxPct(oppId: string): Promise<number> {
  const opp = await getCommercialOpportunity(oppId);
  const hit = resolveTaxForZip(opp?.property_zip ?? null, await listTaxJurisdictions({ activeOnly: true }));
  return hit ? thouToPct(hit.jurisdiction.combined_rate_thou) : 0;
}

/**
 * Toggle whether an approved change order is billed on the deal's invoice.
 * `on=true` adds it (as a line or milestone); `on=false` removes it.
 */
export async function setChangeOrderInvoiced(
  coId: string,
  on: boolean,
  userId: string
): Promise<TickResult> {
  const co = await getChangeOrder(coId);
  if (!co) return { ok: false, error: "Change order not found." };
  if (!(await oppIsLive(co.opportunity_id))) return { ok: false, error: DELETED_DEAL_ERROR };
  return on ? tickChangeOrderOn(co, userId) : tickChangeOrderOff(co, userId);
}

async function tickChangeOrderOn(co: CommercialChangeOrder, userId: string): Promise<TickResult> {
  if (co.status !== "approved") return { ok: false, error: "Approve the change order before billing it." };
  if (co.amount_cents === 0) return { ok: false, error: "A $0 change order has nothing to bill." };
  // Already on a LIVE invoice → treat as a no-op success (it's a toggle, and a
  // voided/deleted prior invoice re-opens it for re-billing — invoiceIsLive).
  if (co.invoiced_invoice_id && (await invoiceIsLive(co.invoiced_invoice_id))) {
    return { ok: true, invoice: await getCommercialInvoice(co.invoiced_invoice_id), createdDraft: false };
  }

  const sb = commercialDb();
  const label = `${formatChangeOrderNumber(co.co_number)} — ${co.title}`.slice(0, 200);

  // Target invoice (existing current, else a fresh draft with ZIP tax).
  let invoiceId: string;
  let createdDraft = false;
  const current = await resolveCurrentDealInvoice(co.opportunity_id);
  if (current) {
    invoiceId = current.id;
  } else {
    const res = await createCommercialInvoice({
      opportunity_id: co.opportunity_id,
      account_id: co.account_id,
      created_by_user_id: userId,
      notes: `Change order billing`,
      tax_pct: await dealTaxPct(co.opportunity_id),
      // DRAFT (Karan's choice): the CO counts as invoiced once you send it.
      skipCreatedNotification: true,
    });
    if (!res.ok) return { ok: false, error: res.error };
    invoiceId = res.invoice.id;
    createdDraft = true;
  }

  // Deduct floor: an invoice can never total below $0. Cap a credit at the
  // current subtotal + surface a heads-up (never-reject).
  let applied = co.amount_cents;
  let warning: string | undefined;
  if (applied < 0) {
    const inv = await getCommercialInvoice(invoiceId);
    const subtotal = inv?.subtotal_cents ?? 0;
    if (subtotal + applied < 0) {
      warning = `That credit (${formatCentsFull(-applied)}) is larger than this invoice (${formatCentsFull(subtotal)}) — applied ${formatCentsFull(subtotal)}; the remaining ${formatCentsFull(-applied - subtotal)} needs a bigger invoice.`;
      applied = -subtotal;
    }
    if (applied === 0) {
      // Nothing to apply. If we minted an empty draft for this, retire it.
      if (createdDraft) await sb.from("commercial_invoices").update({ deleted_at: new Date().toISOString() }).eq("id", invoiceId);
      return { ok: true, invoice: null, createdDraft: false, warning };
    }
  }

  // Add as a milestone (milestone invoice) or a line (flat invoice).
  const hasMilestones = (await listMilestonesForInvoice(invoiceId)).length > 0;
  const addRes = hasMilestones
    ? await addMilestone(invoiceId, { name: label, amount_cents: applied, change_order_id: co.id }, userId)
    : await addLineItem(invoiceId, { description: label, quantity: 1, unit_price_cents: applied, change_order_id: co.id }, userId);
  if (!("ok" in addRes) || !addRes.ok) {
    if (createdDraft) await sb.from("commercial_invoices").update({ deleted_at: new Date().toISOString() }).eq("id", invoiceId);
    return { ok: false, error: ("error" in addRes && addRes.error) || "Couldn't add the change order to the invoice." };
  }

  // Atomic compare-and-swap claim: null (fresh) or the dead prior invoice id
  // (re-bill). A concurrent tick can only match once, so the CO can't attach
  // twice (the partial UNIQUE index on the line/milestone is the DB backstop).
  const prior = co.invoiced_invoice_id;
  let claim = sb
    .from("commercial_change_orders")
    .update({ invoiced_invoice_id: invoiceId, updated_at: new Date().toISOString() })
    .eq("id", co.id)
    .eq("status", "approved");
  claim = prior ? claim.eq("invoiced_invoice_id", prior) : claim.is("invoiced_invoice_id", null);
  const { data: claimed, error: claimErr } = await claim.select("id").maybeSingle();
  if (claimErr || !claimed) {
    // Lost the race — peel the line/milestone back off + drop an auto-draft.
    await removeTickedChangeOrder(invoiceId, co.id, userId);
    if (createdDraft) await sb.from("commercial_invoices").update({ deleted_at: new Date().toISOString() }).eq("id", invoiceId);
    return { ok: false, error: "This change order was just billed elsewhere — refresh to see it." };
  }

  await logUpdate("commercial_change_orders", co.id, { invoiced_invoice_id: prior }, { invoiced_invoice_id: invoiceId }, userId);
  // Only ping the team about a real (sent) invoice — a fresh draft is silent.
  const invRow = await getCommercialInvoice(invoiceId);
  if (invRow && invRow.status !== "draft") {
    await notifyCommercialInvoiceCreated(invRow, userId).catch(() => {});
  }
  return { ok: true, invoice: invRow, createdDraft, warning };
}

async function tickChangeOrderOff(co: CommercialChangeOrder, userId: string): Promise<TickResult> {
  if (!co.invoiced_invoice_id) return { ok: true, invoice: null, createdDraft: false }; // already off
  const sb = commercialDb();
  // Milestone variant → deleteMilestone already re-tags any payments to
  // invoice-level, clears the CO's invoiced_invoice_id, and drops the paired
  // line (never-reject: may leave a credit + warns).
  const { data: ms } = await sb
    .from("commercial_invoice_milestones")
    .select("id")
    .eq("change_order_id", co.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (ms) {
    const res = await deleteMilestone((ms as { id: string }).id, userId);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, invoice: null, createdDraft: false, warning: res.warning };
  }
  // Line variant → drop the tagged line + clear the claim. Flat-invoice CO lines
  // carry no per-line payment, but removing the charge can leave the invoice
  // overpaid (invoice-level payment now exceeds the lower total) → credit + warn.
  const { data: line } = await sb
    .from("commercial_invoice_line_items")
    .select("id, invoice_id")
    .eq("change_order_id", co.id)
    .maybeSingle();
  let warning: string | undefined;
  if (line) {
    const invoiceId = (line as { invoice_id: string }).invoice_id;
    await sb.from("commercial_invoice_line_items").delete().eq("id", (line as { id: string }).id);
    await recomputeSubtotal(invoiceId);
    const inv = await getCommercialInvoice(invoiceId);
    if (inv && (inv.balance_cents as number) < 0) warning = "Removing that change order left the invoice showing a credit.";
  }
  await sb
    .from("commercial_change_orders")
    .update({ invoiced_invoice_id: null, updated_at: new Date().toISOString() })
    .eq("id", co.id);
  await logUpdate("commercial_change_orders", co.id, { invoiced_invoice_id: co.invoiced_invoice_id }, { invoiced_invoice_id: null }, userId);
  return { ok: true, invoice: null, createdDraft: false, warning };
}

/** Rollback helper: peel a just-added CO line or milestone off an invoice
 *  (used when the CAS claim loses). Best-effort. */
async function removeTickedChangeOrder(invoiceId: string, coId: string, userId: string): Promise<void> {
  const sb = commercialDb();
  const { data: ms } = await sb
    .from("commercial_invoice_milestones")
    .select("id")
    .eq("change_order_id", coId)
    .eq("invoice_id", invoiceId)
    .is("deleted_at", null)
    .maybeSingle();
  if (ms) {
    await deleteMilestone((ms as { id: string }).id, userId).catch(() => {});
    return;
  }
  const { data: line } = await sb
    .from("commercial_invoice_line_items")
    .select("id")
    .eq("change_order_id", coId)
    .eq("invoice_id", invoiceId)
    .maybeSingle();
  if (line) {
    await sb.from("commercial_invoice_line_items").delete().eq("id", (line as { id: string }).id);
    await recomputeSubtotal(invoiceId).catch(() => {});
  }
}

/** Soft-delete a CO. A CO billed on a live invoice is blocked. */
export async function deleteChangeOrder(id: string, userId: string): Promise<Result<true>> {
  const before = await getChangeOrder(id);
  if (!before) return { ok: false, error: "not_found" };
  if (!(await oppIsLive(before.opportunity_id))) return { ok: false, error: DELETED_DEAL_ERROR };
  if (before.invoiced_invoice_id && (await invoiceIsLive(before.invoiced_invoice_id))) {
    return {
      ok: false,
      error: "This change order is billed — void or delete its invoice before deleting the change order.",
    };
  }
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_change_orders")
    .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_change_orders", id, before, userId);
  return { ok: true, value: true };
}

/**
 * True when the invoice exists and is neither soft-deleted NOR voided. Both a
 * removed and a voided invoice count as "not billed" so the CO frees up for
 * re-billing — which is exactly what the "void or delete its invoice first"
 * copy on the decide / delete / re-bill guards tells the operator to do.
 */
async function invoiceIsLive(invoiceId: string): Promise<boolean> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_invoices")
    .select("id, deleted_at, status")
    .eq("id", invoiceId)
    .maybeSingle();
  const row = data as { deleted_at: string | null; status: string } | null;
  return !!row && !row.deleted_at && row.status !== "void";
}

/**
 * True when the parent opportunity exists and isn't soft-deleted. Every CO
 * mutation checks this so a stale link / direct URL to a deleted deal can't
 * still approve, bill, edit, or delete a change order (re-audit 2026-07-28,
 * M2) — the CO panel is hidden for deleted deals, but the actions are the
 * real gate.
 */
async function oppIsLive(opportunityId: string): Promise<boolean> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_opportunities")
    .select("id, deleted_at")
    .eq("id", opportunityId)
    .maybeSingle();
  return !!data && !(data as { deleted_at: string | null }).deleted_at;
}

const DELETED_DEAL_ERROR =
  "This deal has been deleted — change orders can't be modified. Restore the deal first.";
