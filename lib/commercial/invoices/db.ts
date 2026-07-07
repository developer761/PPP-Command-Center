/**
 * Phase 3 · Invoicing — DB layer (server-only).
 *
 * All money in cents. All calls scope to the caller by falling through
 * the platform-access + soft-delete gate. Never trust caller-supplied
 * account_id / opportunity_id — the lib re-fetches parent rows and
 * verifies existence + non-deletion before returning.
 */

import { commercialDb } from "@/lib/commercial/db";
import {
  DEFAULT_INVOICE_PREFIX,
  DEFAULT_PAYMENT_TERMS,
  DEFAULT_DUE_DAYS,
  deriveInvoiceStatus,
  type InvoiceStatus,
} from "./constants";

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
  due_days?: number;
  /** Optional starting line items — usually blank and filled after create. */
  line_items?: Array<{
    description: string;
    quantity: number;
    unit?: string | null;
    unit_price_cents: number;
  }>;
};

export type ListInvoicesFilters = {
  status?: InvoiceStatus;
  accountId?: string;
  opportunityId?: string;
  search?: string;
};

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

/** Generate the next invoice number via the DB sequence. */
async function nextInvoiceNumber(): Promise<string> {
  const sb = commercialDb();
  const { data, error } = await sb.rpc("nextval", { seq_name: "commercial_invoice_seq" });
  // Fall back to a timestamp-suffixed random ID if the RPC isn't wired
  // (some Supabase projects gate RPC on nextval). Number stays unique
  // via the UNIQUE constraint on invoice_number; a UI collision would
  // 500 the create, which is acceptable for the fallback path.
  if (error || typeof data !== "number") {
    console.warn("[commercial/invoices] sequence nextval failed:", error?.message);
    const suffix = Date.now().toString(36).toUpperCase().slice(-6);
    return `${DEFAULT_INVOICE_PREFIX}-${suffix}`;
  }
  const n = String(data).padStart(4, "0");
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
  const due_days = input.due_days ?? DEFAULT_DUE_DAYS;

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
      tax_pct: 0,
      paid_cents: 0,
      payment_terms: input.payment_terms ?? DEFAULT_PAYMENT_TERMS,
      customer_message: input.customer_message ?? null,
      po_number: input.po_number ?? null,
      due_at: new Date(Date.now() + due_days * 86_400_000).toISOString(),
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
    }));
    const { error: liErr } = await sb.from("commercial_invoice_line_items").insert(rows);
    if (liErr) {
      console.warn("[commercial/invoices] line items insert failed:", liErr.message);
    }
  }

  await logStatusChange(inserted.id, null, "draft", input.created_by_user_id, "Created");
  return { ok: true, invoice: inserted as CommercialInvoice };
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
  }
): Promise<{ ok: boolean; error?: string }> {
  const sb = commercialDb();
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
  const { error } = await sb.from("commercial_invoices").update(clean).eq("id", invoice_id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function addLineItem(
  invoice_id: string,
  input: { description: string; quantity: number; unit?: string | null; unit_price_cents: number }
): Promise<{ ok: boolean; error?: string }> {
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
  const { error } = await sb.from("commercial_invoice_line_items").insert({
    invoice_id,
    position: nextPos,
    description: input.description.slice(0, 500),
    quantity: input.quantity,
    unit: input.unit ?? null,
    unit_price_cents: input.unit_price_cents,
  });
  if (error) return { ok: false, error: error.message };
  await recomputeSubtotal(invoice_id);
  return { ok: true };
}

export async function removeLineItem(
  invoice_id: string,
  item_id: string
): Promise<{ ok: boolean; error?: string }> {
  const sb = commercialDb();
  const { error } = await sb
    .from("commercial_invoice_line_items")
    .delete()
    .eq("id", item_id)
    .eq("invoice_id", invoice_id);
  if (error) return { ok: false, error: error.message };
  await recomputeSubtotal(invoice_id);
  return { ok: true };
}

/** Re-sum line items into the parent's subtotal_cents (total + balance
 *  are GENERATED, so they follow automatically via the DB). */
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
  const balance = inv.balance_cents as number;
  const cappedAmount = Math.min(input.amount_cents, balance);
  if (cappedAmount <= 0) return { ok: false, error: "no_balance_due" };
  const capped = input.amount_cents > balance;

  const { error } = await sb.from("commercial_invoice_payments").insert({
    invoice_id,
    amount_cents: cappedAmount,
    paid_at: input.paid_at ?? new Date().toISOString(),
    method: input.method ?? null,
    reference: input.reference ?? null,
    notes: input.notes?.slice(0, 500) ?? null,
    recorded_by_user_id: input.recorded_by_user_id,
  });
  if (error) return { ok: false, error: error.message };
  // Trigger auto-flips status to partial/paid. Log the status change.
  const { data: after } = await sb
    .from("commercial_invoices")
    .select("status")
    .eq("id", invoice_id)
    .maybeSingle();
  if (after?.status && after.status !== inv.status) {
    await logStatusChange(invoice_id, inv.status as InvoiceStatus, after.status as InvoiceStatus, input.recorded_by_user_id, "Payment received");
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
  const { error } = await sb
    .from("commercial_invoice_payments")
    .delete()
    .eq("id", payment_id)
    .eq("invoice_id", invoice_id);
  if (error) return { ok: false, error: error.message };
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
