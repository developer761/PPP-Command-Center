/**
 * Phase 3 · Invoicing — DB layer (server-only).
 *
 * All money in cents. All calls scope to the caller by falling through
 * the platform-access + soft-delete gate. Never trust caller-supplied
 * account_id / opportunity_id — the lib re-fetches parent rows and
 * verifies existence + non-deletion before returning.
 */

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import {
  DEFAULT_INVOICE_PREFIX,
  DEFAULT_PAYMENT_TERMS,
  DEFAULT_DUE_DAYS,
  deriveInvoiceStatus,
  type InvoiceStatus,
} from "./constants";
import {
  insertCommercialInvoiceCreatedNotifications,
  insertCommercialInvoicePaymentRecordedNotifications,
  insertCommercialInvoicePaidNotifications,
} from "@/lib/notifications/commercial-events";

/** Resolve the actor's display name from profiles.sf_user_name (falls
 *  back to email → "PPP admin"). Every invoicing notification uses this
 *  so the bell body reads "Alex Chen recorded a payment" instead of a
 *  raw UUID. Failure is silent — worst case we send "PPP admin". */
async function resolveActorName(user_id: string | null | undefined): Promise<string> {
  if (!user_id) return "PPP admin";
  const sb = commercialDb();
  const { data } = await sb
    .from("profiles")
    .select("sf_user_name, email")
    .eq("user_id", user_id)
    .maybeSingle();
  const a = data as { sf_user_name?: string | null; email?: string | null } | null;
  return a?.sf_user_name || a?.email || "PPP admin";
}

/** Fetch the parent opp's display name (CEO {account}-{client}-{location}
 *  format when structural fields exist, else the raw title) in one
 *  round-trip. Used by the invoice notification fanouts so the bell/email
 *  body reads the same thing users see in the UI everywhere else.
 *  Returns null on any lookup miss — helpers fall back to
 *  "the opportunity" copy in that case. */
async function fetchOppTitle(opp_id: string): Promise<string | null> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_opportunities")
    .select("title, client_name, property_street, account_id")
    .eq("id", opp_id)
    .maybeSingle();
  const row = data as {
    title?: string | null;
    client_name?: string | null;
    property_street?: string | null;
    account_id?: string | null;
  } | null;
  if (!row?.title) return null;
  let accountName: string | null = null;
  if (row.account_id) {
    const { data: acct } = await sb
      .from("commercial_accounts")
      .select("company_name")
      .eq("id", row.account_id)
      .maybeSingle();
    accountName = (acct as { company_name?: string | null } | null)?.company_name ?? null;
  }
  return derivedOppName(
    {
      title: row.title,
      client_name: row.client_name ?? null,
      property_street: row.property_street ?? null,
    },
    accountName,
  );
}

// ────────────── Types ──────────────

export type CommercialInvoice = {
  id: string;
  opportunity_id: string;
  account_id: string;
  invoice_number: string;
  status: InvoiceStatus;
  issued_at: string | null;
  due_at: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  subtotal_cents: number;
  tax_pct: number;
  paid_cents: number;
  total_cents: number;
  balance_cents: number;
  payment_terms: string | null;
  customer_message: string | null;
  po_number: string | null;
  notes: string | null;
  /** Migration 085: accepted proposal this invoice bills against (progress
   *  billing). NULL for change-order + free-text invoices. */
  proposal_id: string | null;
  proposal_total_cents_at_bill: number | null;
  /** Migration 089: the stored lien-waiver document for this invoice/milestone
   *  (parent_type=opportunity, category=lien_waiver). NULL until uploaded. */
  lien_waiver_document_id: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type CommercialInvoiceLineItem = {
  id: string;
  invoice_id: string;
  position: number;
  description: string;
  quantity: number;
  unit: string | null;
  unit_price_cents: number;
  subtotal_cents: number;
  created_at: string;
};

export type CommercialInvoicePayment = {
  id: string;
  invoice_id: string;
  /** Migration 091: the milestone this payment is credited to. NULL =
   *  invoice-level payment. Invoice paid_cents = SUM of all payments (trigger);
   *  a milestone's paid = SUM of payments with its milestone_id. */
  milestone_id: string | null;
  amount_cents: number;
  paid_at: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
  recorded_by_user_id: string | null;
  created_at: string;
};

export type CreateInvoiceInput = {
  opportunity_id: string;
  account_id: string;
  created_by_user_id: string;
  customer_message?: string | null;
  po_number?: string | null;
  payment_terms?: string;
  /** Explicit ISO due date. If present, wins over due_days. */
  due_at?: string;
  due_days?: number;
  /** Flat tax % applied to the subtotal. Defaults to 0. */
  tax_pct?: number;
  /** Internal notes; never on customer copy. */
  notes?: string | null;
  /** Migration 085: the accepted proposal this invoice bills against (progress
   *  billing). NULL for CO invoices + free-text invoices. */
  proposal_id?: string | null;
  /** Snapshot of the proposal's total at bill time (defensive denominator). */
  proposal_total_cents_at_bill?: number | null;
  /** Optional starting line items — usually blank and filled after create. */
  line_items?: Array<{
    description: string;
    quantity: number;
    unit?: string | null;
    unit_price_cents: number;
    /** Phase D: optional catalog FK. NULL for legacy free-text rows. */
    product_id?: string | null;
  }>;
  /**
   * Phase G: suppress the "new invoice created" bell/email fanout. The change-
   * order bill flow may create an invoice it then immediately voids if it loses
   * the atomic claim race — skipping the fanout avoids a phantom notification
   * for an invoice that never really existed. The caller fires its own notify
   * only after the claim succeeds.
   */
  skipCreatedNotification?: boolean;
};

export type ListInvoicesFilters = {
  status?: InvoiceStatus;
  accountId?: string;
  opportunityId?: string;
  search?: string;
};

/**
 * Given an invoice_id, returns the parent opportunity + account IDs so
 * server actions can revalidate every surface that shows this invoice's
 * data (opp detail's InvoicesPanel, account 360's rollup tiles, etc).
 * Returns nulls if the invoice or its parents don't exist.
 */
export async function getInvoiceContext(invoice_id: string): Promise<{
  opportunity_id: string | null;
  account_id: string | null;
}> {
  const sb = commercialDb();
  const { data } = await sb
    .from("commercial_invoices")
    .select("opportunity_id, account_id")
    .eq("id", invoice_id)
    .maybeSingle();
  return {
    opportunity_id: (data?.opportunity_id as string | undefined) ?? null,
    account_id: (data?.account_id as string | undefined) ?? null,
  };
}

// ────────────── Reads ──────────────

export async function listCommercialInvoices(
  filters: ListInvoicesFilters = {}
): Promise<CommercialInvoice[]> {
  const sb = commercialDb();
  let q = sb
    .from("commercial_invoices")
    .select("*")
    .is("deleted_at", null);
  if (filters.status && filters.status !== "overdue") q = q.eq("status", filters.status);
  if (filters.accountId) q = q.eq("account_id", filters.accountId);
  if (filters.opportunityId) q = q.eq("opportunity_id", filters.opportunityId);
  if (filters.search) {
    const term = `%${filters.search.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    q = q.ilike("invoice_number", term);
  }
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) {
    console.warn("[commercial/invoices] list failed:", error.message);
    return [];
  }
  const rows = (data ?? []) as CommercialInvoice[];
  // Handle the computed "overdue" status filter client-side (DB status column
  // doesn't store overdue; deriveInvoiceStatus returns it based on due_at).
  if (filters.status === "overdue") {
    return rows.filter((r) => deriveInvoiceStatus(r) === "overdue");
  }
  return rows;
}

export async function getCommercialInvoice(id: string): Promise<CommercialInvoice | null> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_invoices")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.warn("[commercial/invoices] get failed:", error.message);
    return null;
  }
  return (data as CommercialInvoice | null) ?? null;
}

export async function listInvoiceLineItems(invoiceId: string): Promise<CommercialInvoiceLineItem[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_invoice_line_items")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("position", { ascending: true });
  if (error) {
    console.warn("[commercial/invoices] line items list failed:", error.message);
    return [];
  }
  return (data ?? []) as CommercialInvoiceLineItem[];
}

/**
 * Sum of payment amounts recorded with a paid_at in [fromIso, toIso) (Karan
 * 2026-07-27 audit; refined 2026-07-28 re-audit). Sums the actual payment rows
 * by recorded date (not lifetime paid_cents) so partials + multi-month invoices
 * count right. Excludes payments on soft-deleted OR VOIDED invoices (a voided
 * invoice's payments shouldn't count as collected — matches the Account 360
 * rollup). The upper bound keeps a future-dated payment from counting forever.
 * Optional accountId scopes it so the "Paid this month" tile matches the other
 * account-scoped tiles on a single-customer view.
 */
export async function sumCommercialPaymentsSince(
  fromIso: string,
  toIso: string,
  accountId?: string
): Promise<number> {
  const sb = commercialDb();
  let q = sb
    .from("commercial_invoice_payments")
    .select("amount_cents, commercial_invoices!inner(deleted_at, status, account_id)")
    .gte("paid_at", fromIso)
    .lt("paid_at", toIso)
    .is("commercial_invoices.deleted_at", null)
    .neq("commercial_invoices.status", "void");
  if (accountId) q = q.eq("commercial_invoices.account_id", accountId);
  const { data, error } = await q;
  if (error) {
    console.warn("[commercial/invoices] payments-since sum failed:", error.message);
    return 0;
  }
  return ((data ?? []) as Array<{ amount_cents: number | null }>).reduce(
    (acc, r) => acc + (r.amount_cents ?? 0),
    0
  );
}

export async function listInvoicePayments(invoiceId: string): Promise<CommercialInvoicePayment[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_invoice_payments")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("paid_at", { ascending: false });
  if (error) {
    console.warn("[commercial/invoices] payments list failed:", error.message);
    return [];
  }
  return (data ?? []) as CommercialInvoicePayment[];
}

// ────────────── Writes ──────────────

/** Generate the next invoice number via the DB sequence (migration 078
 *  wrapper commercial_next_invoice_seq → nextval('commercial_invoice_seq')). */
async function nextInvoiceNumber(): Promise<string> {
  const sb = commercialDb();
  const { data, error } = await sb.rpc("commercial_next_invoice_seq");
  // Fall back to a random suffix only if the RPC genuinely fails (e.g. the
  // migration hasn't been applied yet). Number stays unique via the UNIQUE
  // constraint on invoice_number; a UI collision would 500 the create, which
  // is acceptable for the fallback path.
  const seq = typeof data === "number" ? data : Number(data);
  if (error || !Number.isFinite(seq)) {
    console.warn("[commercial/invoices] sequence nextval failed:", error?.message);
    const suffix = Date.now().toString(36).toUpperCase().slice(-6);
    return `${DEFAULT_INVOICE_PREFIX}-${suffix}`;
  }
  const n = String(seq).padStart(4, "0");
  return `${DEFAULT_INVOICE_PREFIX}-${n}`;
}

export async function createCommercialInvoice(
  input: CreateInvoiceInput
): Promise<{ ok: true; invoice: CommercialInvoice } | { ok: false; error: string }> {
  const sb = commercialDb();

  // Chain-of-trust: verify opportunity + account exist + aren't deleted.
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", input.opportunity_id)
    .maybeSingle();
  if (!opp || opp.deleted_at) return { ok: false, error: "opportunity_not_found" };
  if (opp.account_id !== input.account_id) return { ok: false, error: "account_mismatch" };

  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", input.account_id)
    .maybeSingle();
  if (!acct || acct.deleted_at) return { ok: false, error: "account_not_found" };

  const invoice_number = await nextInvoiceNumber();

  const subtotal_cents = (input.line_items ?? []).reduce(
    (acc, li) => acc + Math.round(li.quantity * li.unit_price_cents),
    0
  );

  const { data: inserted, error } = await sb
    .from("commercial_invoices")
    .insert({
      opportunity_id: input.opportunity_id,
      account_id: input.account_id,
      invoice_number,
      status: "draft",
      subtotal_cents,
      tax_pct: typeof input.tax_pct === "number" && input.tax_pct >= 0 && input.tax_pct <= 100 ? input.tax_pct : 0,
      paid_cents: 0,
      payment_terms: input.payment_terms ?? DEFAULT_PAYMENT_TERMS,
      customer_message: input.customer_message ?? null,
      po_number: input.po_number ?? null,
      notes: input.notes ?? null,
      proposal_id: input.proposal_id ?? null,
      proposal_total_cents_at_bill: input.proposal_total_cents_at_bill ?? null,
      // No silent auto-due-date (Karan 2026-08): if the user didn't set one, it
      // stays empty ("No due date set") rather than inventing Net-30. A caller
      // that wants a default passes due_at/due_days explicitly.
      due_at: input.due_at ?? (input.due_days ? new Date(Date.now() + input.due_days * 86_400_000).toISOString() : null),
      created_by_user_id: input.created_by_user_id,
    })
    .select("*")
    .maybeSingle();
  if (error || !inserted) {
    return { ok: false, error: error?.message ?? "insert_failed" };
  }

  // Insert line items in one round-trip. Sparse position (1000, 2000, ...)
  // so drag-reorder doesn't need a full re-write of the sibling rows.
  if (input.line_items && input.line_items.length > 0) {
    const rows = input.line_items.map((li, idx) => ({
      invoice_id: inserted.id,
      position: (idx + 1) * 1000,
      description: li.description.slice(0, 500),
      quantity: li.quantity,
      unit: li.unit ?? null,
      unit_price_cents: li.unit_price_cents,
      product_id: li.product_id ?? null,
    }));
    const { error: liErr } = await sb.from("commercial_invoice_line_items").insert(rows);
    if (liErr) {
      console.warn("[commercial/invoices] line items insert failed:", liErr.message);
    }
  }

  await logStatusChange(inserted.id, null, "draft", input.created_by_user_id, "Created");
  // Central audit trail (Karan 2026-07-27 audit): invoice mutations were the
  // only domain with no logInsert/logUpdate/logDelete — the money had no trail.
  await logInsert("commercial_invoices", inserted.id, inserted, input.created_by_user_id);

  // Bell + email fanout — fire-and-forget. Team members on the parent
  // opp see the new invoice in their bell without polling. Skipped when the
  // caller fires its own notify after a downstream claim (Phase G change-order
  // billing) so a voided-loser invoice doesn't notify.
  if (!input.skipCreatedNotification) {
    void notifyCommercialInvoiceCreated(inserted as CommercialInvoice, input.created_by_user_id);
  }

  return { ok: true, invoice: inserted as CommercialInvoice };
}

/**
 * Fire the "new invoice created" bell + email fanout for one invoice. Extracted
 * so a caller that suppressed it at create time (skipCreatedNotification) can
 * fire it itself once a downstream step commits — e.g. change-order billing
 * fires this only after it wins the atomic claim, so a voided loser never
 * notifies. Fire-and-forget: errors are caught + logged, never thrown.
 */
export async function notifyCommercialInvoiceCreated(
  invoice: CommercialInvoice,
  actingUserId: string
): Promise<void> {
  try {
    const [actorName, oppTitle] = await Promise.all([
      resolveActorName(actingUserId),
      fetchOppTitle(invoice.opportunity_id),
    ]);
    await insertCommercialInvoiceCreatedNotifications({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      opportunityId: invoice.opportunity_id,
      oppTitle: oppTitle ?? "the opportunity",
      totalCents: invoice.total_cents,
      actingUserId,
      actorName,
    });
  } catch (err) {
    console.warn(
      "[commercial/invoices] invoice_created notify failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** Fetches the current status + returns an "editable?" verdict.
 *
 *  Karan 2026-07-07: opened line-item edits to any non-void status. His
 *  words: "update the total of the invoice even if it's not the full
 *  invoice" — a Sent invoice that needs a scope adjustment shouldn't
 *  require a void-and-recreate cycle. The customer never sees the
 *  invoice unless we print it ourselves (no auto-email yet), so this
 *  is safe. Void invoices remain immutable. Tax pct still uses this
 *  gate to prevent Sent-invoice tax changes (which would silently
 *  reprice a sent bill). Line items and details use it more loosely. */
async function verifyEditable(invoice_id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_invoices")
    .select("status, deleted_at")
    .eq("id", invoice_id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "invoice_not_found" };
  if (data.deleted_at) return { ok: false, error: "invoice_deleted" };
  if (data.status === "void") return { ok: false, error: "void_invoices_are_immutable" };
  return { ok: true };
}

export async function updateInvoiceCoreFields(
  invoice_id: string,
  patch: {
    tax_pct?: number;
    payment_terms?: string;
    customer_message?: string | null;
    po_number?: string | null;
    notes?: string | null;
    due_at?: string | null;
  },
  actorUserId?: string | null
): Promise<{ ok: boolean; error?: string }> {
  const sb = commercialDb();
  // Karan 2026-07-07: due_at + payment_terms + po_number + customer_message
  // are safe to edit at any status (they're presentation fields that
  // don't affect balance). tax_pct changes the total, so we still gate
  // it to drafts only. `notes` is internal-only — safe anytime.
  const changingBalanceFields = patch.tax_pct !== undefined;
  if (changingBalanceFields) {
    const gate = await verifyEditable(invoice_id);
    if (!gate.ok) return gate;
  } else {
    // Still verify the invoice exists + isn't soft-deleted.
    const { data } = await sb
      .from("commercial_invoices")
      .select("deleted_at")
      .eq("id", invoice_id)
      .maybeSingle();
    if (!data) return { ok: false, error: "invoice_not_found" };
    if (data.deleted_at) return { ok: false, error: "invoice_deleted" };
  }
  const clean: Record<string, unknown> = {};
  if (patch.tax_pct !== undefined) {
    if (patch.tax_pct < 0 || patch.tax_pct > 100) return { ok: false, error: "tax_pct_out_of_range" };
    clean.tax_pct = patch.tax_pct;
  }
  if (patch.payment_terms !== undefined) clean.payment_terms = patch.payment_terms.slice(0, 60);
  if (patch.customer_message !== undefined) clean.customer_message = patch.customer_message?.slice(0, 1000) ?? null;
  if (patch.po_number !== undefined) clean.po_number = patch.po_number?.slice(0, 80) ?? null;
  if (patch.notes !== undefined) clean.notes = patch.notes?.slice(0, 2000) ?? null;
  if (patch.due_at !== undefined) clean.due_at = patch.due_at;
  clean.updated_at = new Date().toISOString();
  // Snapshot the affected fields before + after for the audit trail.
  const beforeCols = Object.keys(clean).join(", ");
  const { data: before } = await sb
    .from("commercial_invoices")
    .select(beforeCols)
    .eq("id", invoice_id)
    .maybeSingle();
  const { error } = await sb.from("commercial_invoices").update(clean).eq("id", invoice_id);
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_invoices", invoice_id, before, clean, actorUserId);
  return { ok: true };
}

export async function addLineItem(
  invoice_id: string,
  input: {
    description: string;
    quantity: number;
    unit?: string | null;
    unit_price_cents: number;
    /** Phase D: optional catalog FK when the user picked from ProductPicker.
     *  The snapshotted unit_price_cents remains the source of truth for the
     *  invoice — this only lets margin/reporting group by SKU later. */
    product_id?: string | null;
  },
  actorUserId?: string | null
): Promise<{ ok: boolean; error?: string }> {
  const gate = await verifyEditable(invoice_id);
  if (!gate.ok) return gate;
  const sb = commercialDb();
  if (!input.description.trim()) return { ok: false, error: "description_required" };
  if (input.quantity <= 0) return { ok: false, error: "quantity_must_be_positive" };
  if (input.unit_price_cents < 0) return { ok: false, error: "unit_price_negative" };
  // Get the current max position + 1000 so new rows land at the end.
  const { data: last } = await sb
    .from("commercial_invoice_line_items")
    .select("position")
    .eq("invoice_id", invoice_id)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextPos = ((last?.position as number | undefined) ?? 0) + 1000;
  const { data: insertedLi, error } = await sb
    .from("commercial_invoice_line_items")
    .insert({
      invoice_id,
      position: nextPos,
      description: input.description.slice(0, 500),
      quantity: input.quantity,
      unit: input.unit ?? null,
      unit_price_cents: input.unit_price_cents,
      product_id: input.product_id ?? null,
    })
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (insertedLi) await logInsert("commercial_invoice_line_items", (insertedLi as { id: string }).id, insertedLi, actorUserId);
  await recomputeSubtotal(invoice_id);
  return { ok: true };
}

export async function removeLineItem(
  invoice_id: string,
  item_id: string,
  actorUserId?: string | null
): Promise<{ ok: boolean; error?: string }> {
  const gate = await verifyEditable(invoice_id);
  if (!gate.ok) return gate;
  const sb = commercialDb();
  // Guard (edge-case D): a line item paired to a live milestone can't be removed
  // directly — that would orphan the milestone (its schedule row + due date +
  // lien waiver survive with no charge, breaking Σ milestones == subtotal).
  // Remove it via the milestone instead. Tolerates an unapplied 090 migration.
  const { data: pairedMs } = await sb
    .from("commercial_invoice_milestones")
    .select("id")
    .eq("line_item_id", item_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (pairedMs) return { ok: false, error: "milestone_line_item" };
  // Capture the row before delete so the audit trail records what was removed.
  const { data: beforeLi } = await sb
    .from("commercial_invoice_line_items")
    .select("*")
    .eq("id", item_id)
    .eq("invoice_id", invoice_id)
    .maybeSingle();
  const { error } = await sb
    .from("commercial_invoice_line_items")
    .delete()
    .eq("id", item_id)
    .eq("invoice_id", invoice_id);
  if (error) return { ok: false, error: error.message };
  if (beforeLi) await logDelete("commercial_invoice_line_items", item_id, beforeLi, actorUserId);
  await recomputeSubtotal(invoice_id);
  return { ok: true };
}

/** Re-sum line items into the parent's subtotal_cents (total + balance
 *  are GENERATED, so they follow automatically via the DB). Then
 *  reconcile status.
 *
 *  Karan 2026-07-07: since verifyEditable now allows line-item changes
 *  on any non-void invoice, the total can shift AFTER a payment lands.
 *  The payment trigger only fires on payment mutations, not line-item
 *  changes, so we manually re-run the paid/partial/sent decision here.
 *
 *  Rules mirror the trigger:
 *   - void invoices are immutable (verifyEditable rejects; unreachable)
 *   - paid_cents >= total_cents (and total>0) → paid
 *   - paid_cents > 0 → partial
 *   - paid_cents = 0 AND status IN (paid,partial) → sent
 *   - else unchanged */
async function recomputeSubtotal(invoice_id: string): Promise<void> {
  const sb = commercialDb();
  const { data: items } = await sb
    .from("commercial_invoice_line_items")
    .select("subtotal_cents")
    .eq("invoice_id", invoice_id);
  const subtotal = (items ?? []).reduce((acc, r) => acc + (r.subtotal_cents as number ?? 0), 0);
  await sb
    .from("commercial_invoices")
    .update({ subtotal_cents: subtotal, updated_at: new Date().toISOString() })
    .eq("id", invoice_id);
  // Re-read the row so we see the GENERATED total_cents post-update,
  // then reconcile status if the change moved the paid/balance line.
  const { data: after } = await sb
    .from("commercial_invoices")
    .select("status, total_cents, paid_cents, paid_at")
    .eq("id", invoice_id)
    .maybeSingle();
  if (!after) return;
  const status = after.status as InvoiceStatus;
  const total = after.total_cents as number;
  const paid = after.paid_cents as number;
  let nextStatus: InvoiceStatus | null = null;
  let nextPaidAt: string | null | undefined = undefined;
  if (status === "void") return;
  if (paid >= total && total > 0 && status !== "paid") {
    nextStatus = "paid";
    if (!after.paid_at) nextPaidAt = new Date().toISOString();
  } else if (paid > 0 && paid < total && status === "paid") {
    // Total went up (line item added) beyond what's been paid — regress
    // to partial so the balance surfaces again.
    nextStatus = "partial";
    nextPaidAt = null;
  } else if (paid === 0 && (status === "paid" || status === "partial")) {
    // Line item added on an invoice with no payments recorded (rare;
    // more likely on a fresh draft that had status flipped manually).
    nextStatus = "sent";
    nextPaidAt = null;
  }
  if (nextStatus) {
    const patch: Record<string, unknown> = { status: nextStatus, updated_at: new Date().toISOString() };
    if (nextPaidAt !== undefined) patch.paid_at = nextPaidAt;
    await sb.from("commercial_invoices").update(patch).eq("id", invoice_id);
  }
}

// ────────────── Payments ──────────────

export async function addPayment(
  invoice_id: string,
  input: {
    amount_cents: number;
    paid_at?: string;
    method?: string | null;
    reference?: string | null;
    notes?: string | null;
    recorded_by_user_id: string;
    /** Migration 091: credit this payment to a specific milestone. Must belong
     *  to this invoice. Caps the payment to that milestone's remaining balance
     *  (as well as the invoice balance). NULL/undefined = invoice-level. */
    milestone_id?: string | null;
  }
): Promise<{ ok: boolean; error?: string; applied_cents?: number; requested_cents?: number; capped?: boolean }> {
  const sb = commercialDb();
  if (input.amount_cents <= 0) return { ok: false, error: "amount_must_be_positive" };
  // Cap at balance so a fat-fingered overpayment doesn't create a negative
  // balance. We return `capped: true` + `applied_cents` so the UI can
  // surface "Payment capped to $X" instead of silently swallowing the diff.
  const { data: inv } = await sb
    .from("commercial_invoices")
    .select("balance_cents, status")
    .eq("id", invoice_id)
    .maybeSingle();
  if (!inv) return { ok: false, error: "invoice_not_found" };
  if (inv.status === "void") return { ok: false, error: "cannot_pay_voided" };
  // Karan 2026-07-07: "don't make me mark as sent in order to record
  // payments. Mark as sent should just be for UI purposes." Dropped the
  // draft-only gate. The trigger will flip draft → partial → paid
  // automatically as payments come in. "Mark as sent" is now a passive
  // status pill Alex flips when he actually sends the customer copy.
  const balance = inv.balance_cents as number;

  // Milestone-scoped payment (Karan 2026-08): validate the milestone belongs to
  // this invoice, then cap to its REMAINING balance too so a milestone can't be
  // over-collected. Milestone remaining = its amount − Σ payments already tagged
  // to it.
  let milestone_id: string | null = null;
  let milestoneCap = Infinity;
  if (input.milestone_id) {
    const { data: ms } = await sb
      .from("commercial_invoice_milestones")
      .select("id, invoice_id, amount_cents, deleted_at")
      .eq("id", input.milestone_id)
      .maybeSingle();
    if (!ms || (ms as { invoice_id: string }).invoice_id !== invoice_id || (ms as { deleted_at: string | null }).deleted_at) {
      return { ok: false, error: "milestone_not_found" };
    }
    const { data: prior } = await sb
      .from("commercial_invoice_payments")
      .select("amount_cents")
      .eq("milestone_id", input.milestone_id);
    const milestonePaid = (prior ?? []).reduce((s, r) => s + ((r.amount_cents as number) ?? 0), 0);
    milestoneCap = Math.max(0, (ms as { amount_cents: number }).amount_cents - milestonePaid);
    milestone_id = input.milestone_id;
  }

  const cappedAmount = Math.min(input.amount_cents, balance, milestoneCap);
  if (cappedAmount <= 0) return { ok: false, error: milestone_id ? "milestone_already_paid" : "no_balance_due" };
  const capped = input.amount_cents > cappedAmount;

  const { data: insertedPayment, error } = await sb
    .from("commercial_invoice_payments")
    .insert({
      invoice_id,
      milestone_id,
      amount_cents: cappedAmount,
      paid_at: input.paid_at ?? new Date().toISOString(),
      method: input.method ?? null,
      reference: input.reference ?? null,
      notes: input.notes?.slice(0, 500) ?? null,
      recorded_by_user_id: input.recorded_by_user_id,
    })
    .select("*")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  // Audit trail — a recorded payment must leave a record with the amount + actor.
  if (insertedPayment) {
    await logInsert("commercial_invoice_payments", (insertedPayment as { id: string }).id, insertedPayment, input.recorded_by_user_id);
  }
  // The DB trigger `trg_recompute_paid_cents` should auto-update
  // paid_cents (which feeds the generated balance_cents column) + flip
  // status. Karan 2026-07-07 defense: an older version of the trigger
  // (pre-commit 3ed6b2b) gated the draft → partial flip on
  // `status != 'draft'`, which meant recording a payment on a Draft
  // invoice would leave paid_cents advanced but status stuck at Draft.
  // If the deployed DB is still running the older trigger, our
  // notification fanout would fire the wrong variant + the UI would
  // show a mismatched status. Re-fetch the after-row + explicitly
  // reconcile status if the trigger left it inconsistent. This is a
  // no-op when the current trigger is deployed.
  let { data: after } = await sb
    .from("commercial_invoices")
    .select("status, balance_cents, total_cents, paid_cents, invoice_number, opportunity_id")
    .eq("id", invoice_id)
    .maybeSingle();
  if (after) {
    const paid = (after as { paid_cents: number }).paid_cents;
    const total = (after as { total_cents: number }).total_cents;
    const currentStatus = (after as { status: InvoiceStatus }).status;
    // Expected status per the current trigger contract.
    const expectedStatus: InvoiceStatus | null =
      currentStatus === "void"
        ? "void"
        : paid > 0 && paid >= total && total > 0
        ? "paid"
        : paid > 0
        ? "partial"
        : null; // no reconcile needed
    if (expectedStatus && currentStatus !== expectedStatus) {
      const patch: Record<string, unknown> = { status: expectedStatus };
      // Stamp paid_at when force-flipping to paid so downstream reads
      // don't see paid=paid_at=null.
      if (expectedStatus === "paid") patch.paid_at = new Date().toISOString();
      await sb.from("commercial_invoices").update(patch).eq("id", invoice_id);
      // Re-fetch so the notification below sees the corrected state.
      const { data: reFetched } = await sb
        .from("commercial_invoices")
        .select("status, balance_cents, total_cents, paid_cents, invoice_number, opportunity_id")
        .eq("id", invoice_id)
        .maybeSingle();
      after = reFetched;
    }
  }
  if (after?.status && after.status !== inv.status) {
    await logStatusChange(invoice_id, inv.status as InvoiceStatus, after.status as InvoiceStatus, input.recorded_by_user_id, "Payment received");
  }

  // Bell + email fanout — fire-and-forget. If the payment brought the
  // balance to zero, fire the celebratory "PAID" variant. Otherwise fire
  // the partial "payment recorded" variant. Team members on the parent
  // opp see the cash-flow moment in their bell without polling.
  if (after) {
    const afterRow = after as {
      status: InvoiceStatus;
      balance_cents: number;
      total_cents: number;
      invoice_number: string;
      opportunity_id: string;
    };
    void (async () => {
      try {
        const [actorName, oppTitle] = await Promise.all([
          resolveActorName(input.recorded_by_user_id),
          fetchOppTitle(afterRow.opportunity_id),
        ]);
        const isPaidInFull = afterRow.status === "paid" || afterRow.balance_cents <= 0;
        if (isPaidInFull) {
          await insertCommercialInvoicePaidNotifications({
            invoiceId: invoice_id,
            invoiceNumber: afterRow.invoice_number,
            opportunityId: afterRow.opportunity_id,
            oppTitle: oppTitle ?? "the opportunity",
            totalCents: afterRow.total_cents,
            actingUserId: input.recorded_by_user_id,
            actorName,
          });
        } else {
          await insertCommercialInvoicePaymentRecordedNotifications({
            invoiceId: invoice_id,
            invoiceNumber: afterRow.invoice_number,
            opportunityId: afterRow.opportunity_id,
            oppTitle: oppTitle ?? "the opportunity",
            amountCents: cappedAmount,
            balanceRemainingCents: afterRow.balance_cents,
            actingUserId: input.recorded_by_user_id,
            actorName,
          });
        }
      } catch (err) {
        console.warn(
          "[commercial/invoices] payment notify failed:",
          err instanceof Error ? err.message : String(err)
        );
      }
    })();
  }

  return { ok: true, applied_cents: cappedAmount, requested_cents: input.amount_cents, capped };
}

export async function removePayment(
  invoice_id: string,
  payment_id: string,
  actor_user_id: string
): Promise<{ ok: boolean; error?: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_invoices")
    .select("status")
    .eq("id", invoice_id)
    .maybeSingle();
  // Capture the payment row before delete — deleting a payment (esp. a large
  // one) must leave an auditable record of what was removed + by whom.
  const { data: beforePayment } = await sb
    .from("commercial_invoice_payments")
    .select("*")
    .eq("id", payment_id)
    .eq("invoice_id", invoice_id)
    .maybeSingle();
  const { error } = await sb
    .from("commercial_invoice_payments")
    .delete()
    .eq("id", payment_id)
    .eq("invoice_id", invoice_id);
  if (error) return { ok: false, error: error.message };
  if (beforePayment) await logDelete("commercial_invoice_payments", payment_id, beforePayment, actor_user_id);
  const { data: after } = await sb
    .from("commercial_invoices")
    .select("status")
    .eq("id", invoice_id)
    .maybeSingle();
  if (before?.status && after?.status && before.status !== after.status) {
    await logStatusChange(invoice_id, before.status as InvoiceStatus, after.status as InvoiceStatus, actor_user_id, "Payment removed");
  }
  return { ok: true };
}

// ────────────── Status log ──────────────

export async function logStatusChange(
  invoice_id: string,
  from_status: InvoiceStatus | null,
  to_status: InvoiceStatus,
  actor_user_id: string | null,
  note?: string
): Promise<void> {
  const sb = commercialDb();
  await sb.from("commercial_invoice_status_log").insert({
    invoice_id,
    from_status,
    to_status,
    actor_user_id,
    note: note?.slice(0, 500) ?? null,
  });
}

export async function listInvoiceStatusLog(invoice_id: string): Promise<Array<{
  id: string;
  from_status: string | null;
  to_status: string;
  actor_user_id: string | null;
  note: string | null;
  created_at: string;
}>> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_invoice_status_log")
    .select("*")
    .eq("invoice_id", invoice_id)
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("[commercial/invoices] status log failed:", error.message);
    return [];
  }
  return data ?? [];
}
