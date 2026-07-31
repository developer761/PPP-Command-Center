import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import {
  addLineItem,
  removeLineItem,
  listInvoiceLineItems,
  getCommercialInvoice,
} from "@/lib/commercial/invoices/db";
import { uploadDocument, getDocument, softDeleteDocument } from "@/lib/commercial/documents/db";
import type { CommercialDocument } from "@/lib/commercial/documents/db";

/**
 * Invoice milestones (2026-08, Karan smoke-test rework).
 *
 * A deal's invoice can be broken into MILESTONES — a Schedule-of-Values
 * breakdown WITHIN the invoice (e.g. $10,000 → 4 × $2,500), each with its own
 * NAME, DUE DATE and LIEN WAIVER. Milestones are OPTIONAL (a flat invoice has
 * none).
 *
 * Consistency by construction: every milestone pairs 1:1 with an invoice line
 * item (`line_item_id`) whose subtotal == the milestone amount. So the invoice
 * total (Σ line items) ALWAYS equals Σ milestones — there is no separate stored
 * total. KPIs stay invoice-level and unchanged; milestones only layer
 * scheduling + lien-waiver metadata on top.
 */

export type InvoiceMilestone = {
  id: string;
  invoice_id: string;
  position: number;
  name: string;
  amount_cents: number;
  due_at: string | null;
  line_item_id: string | null;
  lien_waiver_document_id: string | null;
  change_order_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** One milestone row as entered on the create form. */
export type MilestoneDraft = {
  name: string;
  amount_cents: number;
  due_at?: string | null;
  notes?: string | null;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const MILESTONE_COLS =
  "id, invoice_id, position, name, amount_cents, due_at, line_item_id, lien_waiver_document_id, change_order_id, notes, created_at, updated_at, deleted_at";

// ────────────── Reads ──────────────

/** All live milestones for one invoice, ordered by position. */
export async function listMilestonesForInvoice(invoiceId: string): Promise<InvoiceMilestone[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_invoice_milestones")
    .select(MILESTONE_COLS)
    .eq("invoice_id", invoiceId)
    .is("deleted_at", null)
    .order("position", { ascending: true });
  if (error) {
    // Tolerate an unapplied migration — the invoice UI degrades to "no
    // milestones" rather than crashing.
    console.warn("[commercial/milestones] list failed:", error.message);
    return [];
  }
  return (data ?? []) as InvoiceMilestone[];
}

/** Live milestones for many invoices at once (deal list). Keyed by invoice_id. */
export async function listMilestonesForInvoices(
  invoiceIds: string[]
): Promise<Map<string, InvoiceMilestone[]>> {
  const out = new Map<string, InvoiceMilestone[]>();
  if (invoiceIds.length === 0) return out;
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_invoice_milestones")
    .select(MILESTONE_COLS)
    .in("invoice_id", invoiceIds)
    .is("deleted_at", null)
    .order("position", { ascending: true });
  if (error) {
    console.warn("[commercial/milestones] batch list failed:", error.message);
    return out;
  }
  for (const row of (data ?? []) as InvoiceMilestone[]) {
    const arr = out.get(row.invoice_id) ?? [];
    arr.push(row);
    out.set(row.invoice_id, arr);
  }
  return out;
}

export async function getMilestone(id: string): Promise<InvoiceMilestone | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_invoice_milestones")
    .select(MILESTONE_COLS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as InvoiceMilestone | null) ?? null;
}

// ────────────── Create ──────────────

/**
 * Seed milestones for a FRESHLY-created invoice whose line items were created
 * 1:1 from the same drafts (same order). Pairs milestone[i] to the line item at
 * position (i+1)*1000. No subtotal recompute needed — the invoice total was
 * already computed from those line items at create time.
 *
 * Best-effort: a milestone insert failure is logged, never thrown — the invoice
 * (with correct total) still stands; it just reads as flat until re-broken.
 */
export async function seedMilestonesFromLineItems(
  invoiceId: string,
  drafts: MilestoneDraft[]
): Promise<void> {
  if (drafts.length === 0) return;
  const sb = commercialDb();
  const lineItems = await listInvoiceLineItems(invoiceId); // ordered by position asc
  const rows = drafts.map((d, i) => ({
    invoice_id: invoiceId,
    position: (i + 1) * 1000,
    name: d.name.slice(0, 200),
    amount_cents: Math.max(0, Math.round(d.amount_cents)),
    due_at: d.due_at ?? null,
    line_item_id: lineItems[i]?.id ?? null,
    notes: d.notes ?? null,
  }));
  const { error } = await sb.from("commercial_invoice_milestones").insert(rows);
  if (error) console.warn("[commercial/milestones] seed failed:", error.message);
}

/**
 * Add ONE milestone to an EXISTING invoice: creates the paired line item (which
 * recomputes the invoice subtotal + reconciles status) then the milestone row.
 * Used by the invoice-detail "add milestone" form and by change-order billing.
 */
export async function addMilestone(
  invoiceId: string,
  draft: MilestoneDraft & { change_order_id?: string | null },
  actorUserId: string
): Promise<Result<InvoiceMilestone>> {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "Name the milestone." };
  const amount = Math.round(draft.amount_cents);
  if (!Number.isFinite(amount) || amount < 0) return { ok: false, error: "Enter a valid amount." };

  // 1) The paired line item (also recomputes subtotal + status + audit).
  const li = await addLineItem(
    invoiceId,
    { description: name.slice(0, 500), quantity: 1, unit_price_cents: amount },
    actorUserId
  );
  if (!li.ok) return { ok: false, error: li.error ?? "Could not add the milestone charge." };

  // 2) Find the line item we just appended (highest position on this invoice).
  const items = await listInvoiceLineItems(invoiceId);
  const lineItemId = items.length ? items[items.length - 1].id : null;
  const nextPos = items.length * 1000 || 1000;

  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_invoice_milestones")
    .insert({
      invoice_id: invoiceId,
      position: nextPos,
      name: name.slice(0, 200),
      amount_cents: amount,
      due_at: draft.due_at ?? null,
      line_item_id: lineItemId,
      change_order_id: draft.change_order_id ?? null,
      notes: draft.notes ?? null,
    })
    .select(MILESTONE_COLS)
    .maybeSingle();
  if (error || !data) {
    // The charge landed but the milestone row didn't — roll the line item back
    // so we don't inflate the invoice with an untracked charge.
    if (lineItemId) await removeLineItem(invoiceId, lineItemId, actorUserId).catch(() => {});
    return { ok: false, error: error?.message ?? "Could not add the milestone." };
  }
  return { ok: true, value: data as InvoiceMilestone };
}

// ────────────── Update / delete ──────────────

/** Edit a milestone's name/amount/due date. Keeps the paired line item in sync
 *  (description + unit_price) so the invoice total tracks the edit. */
export async function updateMilestone(
  id: string,
  patch: { name?: string; amount_cents?: number; due_at?: string | null; notes?: string | null },
  actorUserId: string
): Promise<Result<InvoiceMilestone>> {
  const existing = await getMilestone(id);
  if (!existing) return { ok: false, error: "Milestone not found." };

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) return { ok: false, error: "Name can't be blank." };
    update.name = n.slice(0, 200);
  }
  if (patch.amount_cents !== undefined) {
    const a = Math.round(patch.amount_cents);
    if (!Number.isFinite(a) || a < 0) return { ok: false, error: "Enter a valid amount." };
    update.amount_cents = a;
  }
  if (patch.due_at !== undefined) update.due_at = patch.due_at;
  if (patch.notes !== undefined) update.notes = patch.notes;

  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_invoice_milestones")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select(MILESTONE_COLS)
    .maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? "Could not save the milestone." };

  // Keep the paired charge in sync: rewrite the line item, then recompute the
  // invoice subtotal via a remove+add would lose position, so update in place.
  if (existing.line_item_id && (patch.name !== undefined || patch.amount_cents !== undefined)) {
    const liPatch: Record<string, unknown> = {};
    if (patch.name !== undefined) liPatch.description = (update.name as string).slice(0, 500);
    if (patch.amount_cents !== undefined) liPatch.unit_price_cents = update.amount_cents;
    await sb.from("commercial_invoice_line_items").update(liPatch).eq("id", existing.line_item_id);
    await resyncInvoiceSubtotal(existing.invoice_id);
  }
  return { ok: true, value: data as InvoiceMilestone };
}

/** Soft-delete a milestone + remove its paired charge (which recomputes the
 *  invoice total). The stored lien waiver is retired too. */
export async function deleteMilestone(id: string, actorUserId: string): Promise<Result<null>> {
  const existing = await getMilestone(id);
  if (!existing) return { ok: false, error: "Milestone not found." };
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_invoice_milestones")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  if (existing.line_item_id) {
    await removeLineItem(existing.invoice_id, existing.line_item_id, actorUserId).catch(() => {});
  }
  if (existing.lien_waiver_document_id) {
    await softDeleteDocument(existing.lien_waiver_document_id, actorUserId).catch(() => {});
  }
  return { ok: true, value: null };
}

/** Re-sum this invoice's line items into subtotal_cents (total/balance are
 *  GENERATED so they follow), then reconcile paid/partial/sent status the same
 *  way db.recomputeSubtotal + the payment trigger do — so lowering a milestone
 *  below what's already paid flips the invoice to paid, etc. */
async function resyncInvoiceSubtotal(invoiceId: string): Promise<void> {
  const sb = commercialDb();
  const { data: items } = await sb
    .from("commercial_invoice_line_items")
    .select("subtotal_cents")
    .eq("invoice_id", invoiceId);
  const subtotal = (items ?? []).reduce((acc, r) => acc + ((r.subtotal_cents as number) ?? 0), 0);
  await sb
    .from("commercial_invoices")
    .update({ subtotal_cents: subtotal, updated_at: new Date().toISOString() })
    .eq("id", invoiceId);
  // Re-read the GENERATED total, then reconcile status (mirrors the trigger).
  const { data: inv } = await sb
    .from("commercial_invoices")
    .select("total_cents, paid_cents, status")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return;
  const total = (inv.total_cents as number) ?? 0;
  const paid = (inv.paid_cents as number) ?? 0;
  const status = inv.status as string;
  if (status === "void") return; // terminal
  let next = status;
  if (paid >= total && total > 0) next = "paid";
  else if (paid > 0) next = "partial";
  else if (paid === 0 && (status === "paid" || status === "partial")) next = "sent";
  if (next !== status) {
    await sb
      .from("commercial_invoices")
      .update({ status: next, paid_at: next === "paid" ? new Date().toISOString() : null })
      .eq("id", invoiceId);
  }
}

// ────────────── Change-order → milestone ──────────────

/**
 * Bill a change order as a milestone on the deal's invoice. Adds a milestone
 * (+ paired line item, so the invoice total grows by the CO amount) tagged with
 * the CO. Only additive COs bill as a milestone (a credit CO isn't a payable
 * milestone). Returns the new milestone.
 */
export async function addChangeOrderMilestone(
  invoiceId: string,
  co: { id: string; title: string; amount_cents: number; due_at?: string | null },
  actorUserId: string
): Promise<Result<InvoiceMilestone>> {
  if (co.amount_cents <= 0) return { ok: false, error: "Only added-scope change orders bill as a milestone." };
  return addMilestone(
    invoiceId,
    {
      name: co.title.slice(0, 200),
      amount_cents: co.amount_cents,
      due_at: co.due_at ?? null,
      change_order_id: co.id,
    },
    actorUserId
  );
}

// ────────────── Per-milestone lien waiver ──────────────

async function fetchMilestoneScope(
  milestoneId: string
): Promise<{ opportunity_id: string; name: string; lien_waiver_document_id: string | null } | null> {
  const m = await getMilestone(milestoneId);
  if (!m) return null;
  const inv = await getCommercialInvoice(m.invoice_id);
  if (!inv) return null;
  return {
    opportunity_id: inv.opportunity_id,
    name: `${inv.invoice_number} — ${m.name}`,
    lien_waiver_document_id: m.lien_waiver_document_id,
  };
}

export async function getMilestoneLienWaiver(milestoneId: string): Promise<CommercialDocument | null> {
  const scope = await fetchMilestoneScope(milestoneId);
  if (!scope?.lien_waiver_document_id) return null;
  return (await getDocument(scope.lien_waiver_document_id)) ?? null;
}

/** Store a lien waiver against a milestone: file → per-deal document (category
 *  lien_waiver) → link to the milestone. Replaces + retires any prior one. */
export async function attachMilestoneLienWaiver(input: {
  milestoneId: string;
  file_name: string;
  mime_type: string;
  data: Uint8Array;
  actorUserId: string;
}): Promise<Result<CommercialDocument>> {
  const scope = await fetchMilestoneScope(input.milestoneId);
  if (!scope) return { ok: false, error: "Milestone not found." };

  const uploaded = await uploadDocument({
    parent_type: "opportunity",
    parent_id: scope.opportunity_id,
    category: "lien_waiver",
    file_name: input.file_name,
    size_bytes: input.data.length,
    mime_type: input.mime_type,
    notes: `Lien waiver — ${scope.name}`,
    data: input.data,
    uploaded_by_user_id: input.actorUserId,
  });
  if (!uploaded.ok) return uploaded;

  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_invoice_milestones")
    .update({ lien_waiver_document_id: uploaded.document.id, updated_at: new Date().toISOString() })
    .eq("id", input.milestoneId);
  if (error) {
    await softDeleteDocument(uploaded.document.id, input.actorUserId).catch(() => {});
    return { ok: false, error: error.message };
  }
  if (scope.lien_waiver_document_id && scope.lien_waiver_document_id !== uploaded.document.id) {
    await softDeleteDocument(scope.lien_waiver_document_id, input.actorUserId).catch(() => {});
  }
  return { ok: true, value: uploaded.document };
}

export async function removeMilestoneLienWaiver(
  milestoneId: string,
  actorUserId: string
): Promise<Result<null>> {
  const scope = await fetchMilestoneScope(milestoneId);
  if (!scope) return { ok: false, error: "Milestone not found." };
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_invoice_milestones")
    .update({ lien_waiver_document_id: null, updated_at: new Date().toISOString() })
    .eq("id", milestoneId);
  if (error) return { ok: false, error: error.message };
  if (scope.lien_waiver_document_id) {
    await softDeleteDocument(scope.lien_waiver_document_id, actorUserId).catch(() => {});
  }
  return { ok: true, value: null };
}
