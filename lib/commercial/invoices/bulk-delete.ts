import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logDelete } from "@/lib/commercial/audit-log";
import { releaseTickedChangeOrders } from "@/lib/commercial/invoices/status";

/**
 * Bulk-delete every live invoice under one deal or one account — the orphan
 * cleanup behind the "Delete all N invoices" buttons.
 *
 * ONE COPY. This lived as three server actions (two on the invoices list, one
 * on the invoice detail page) that had already drifted: the detail-page copy
 * never wrote the platform audit log. And all three shared the bug this file
 * exists to fix — not one write was read. supabase RESOLVES with `{ error }`
 * rather than throwing, so:
 *
 *  · a failed VOID was ignored and the paid invoices were soft-deleted anyway,
 *    which is "paid invoices wiped with no void record" — the exact outcome
 *    the void-first step is there to prevent;
 *  · a failed DELETE still redirected with `bulk_deleted=N`, N being the
 *    number ATTEMPTED, so the green "N invoices deleted" banner could be a
 *    flat lie about a screen that had not changed;
 *  · the audit and status-log rows were written for the attempted ids, so the
 *    trail recorded deletions that never happened.
 *
 * Now each step is checked, every later step is driven by the ids the
 * database actually RETURNED, and a paid invoice is never deleted unless its
 * void landed first.
 */

export type BulkInvoiceDeleteResult =
  | { ok: true; deleted: number; warning?: string }
  | { ok: false; deleted: number; error: string };

type Row = { id: string; status: string; paid_cents: number };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function bulkVoidAndDeleteInvoices(
  scope: { column: "opportunity_id" | "account_id"; id: string },
  actorUserId: string,
  /** Shown in the status log, e.g. "orphan cleanup on deleted deal". */
  reason: string,
): Promise<BulkInvoiceDeleteResult> {
  const sb = commercialDb();
  const { data: invRows, error: readErr } = await sb
    .from("commercial_invoices")
    .select("id, status, paid_cents")
    .eq(scope.column, scope.id)
    .is("deleted_at", null);
  if (readErr || !invRows) {
    return { ok: false, deleted: 0, error: "Couldn't read the invoices, so nothing was deleted. Please try again." };
  }
  const rows = invRows as Row[];
  if (rows.length === 0) return { ok: true, deleted: 0 };

  // Auto-void paid non-void invoices FIRST, so the payment history survives as
  // a void rather than vanishing with the delete.
  const now = new Date().toISOString();
  const paidNonVoid = rows.filter((r) => (r.paid_cents ?? 0) > 0 && r.status !== "void");
  const voided = new Set<string>();
  if (paidNonVoid.length > 0) {
    const { data: voidRows, error: voidErr } = await sb
      .from("commercial_invoices")
      .update({ status: "void", voided_at: now })
      .in("id", paidNonVoid.map((r) => r.id))
      .is("deleted_at", null)
      .select("id");
    if (voidErr || !voidRows) {
      return {
        ok: false,
        deleted: 0,
        error: `Couldn't void the ${plural(paidNonVoid.length, "invoice")} with payments on ${paidNonVoid.length === 1 ? "it" : "them"} first, so nothing was deleted. Please try again.`,
      };
    }
    for (const r of voidRows as { id: string }[]) voided.add(r.id);
  }
  // A paid invoice whose void didn't land is NOT deleted — that is the case
  // the void exists for.
  const unvoided = paidNonVoid.filter((r) => !voided.has(r.id));
  const deletable = rows.filter((r) => !unvoided.some((u) => u.id === r.id));

  let deletedIds = new Set<string>();
  let deleteError: string | null = null;
  if (deletable.length > 0) {
    const { data: delRows, error: delErr } = await sb
      .from("commercial_invoices")
      .update({ deleted_at: now })
      .in("id", deletable.map((r) => r.id))
      .is("deleted_at", null)
      .select("id");
    if (delErr || !delRows) deleteError = delErr?.message ?? "no rows returned";
    else deletedIds = new Set((delRows as { id: string }[]).map((r) => r.id));
  }
  const deleted = rows.filter((r) => deletedIds.has(r.id));

  // Free change orders billed on the invoices that really went, so they can be
  // re-billed (audit M1 — the single-invoice delete does this too).
  for (const r of deleted) {
    await releaseTickedChangeOrders(r.id);
  }
  // Audit what HAPPENED. The platform audit log answers "who removed these";
  // the status log carries the money that was on each one.
  for (const r of deleted) {
    const { data: full } = await sb.from("commercial_invoices").select("*").eq("id", r.id).maybeSingle();
    if (full) await logDelete("commercial_invoices", r.id, full, actorUserId);
  }
  const changed = rows.filter((r) => deletedIds.has(r.id) || voided.has(r.id));
  let logFailed = false;
  if (changed.length > 0) {
    const { error: logErr } = await sb.from("commercial_invoice_status_log").insert(
      changed.map((r) => ({
        invoice_id: r.id,
        from_status: r.status,
        to_status: "void",
        actor_user_id: actorUserId,
        note: `${deletedIds.has(r.id) ? "Bulk-deleted" : "Auto-voided for a bulk delete that did not complete"} (${reason})${(r.paid_cents ?? 0) > 0 ? ` — had $${((r.paid_cents ?? 0) / 100).toFixed(2)} paid; auto-voided` : ""}`.slice(0, 500),
      })),
    );
    logFailed = !!logErr;
  }

  const notDeleted = rows.length - deleted.length;
  const voidedOnly = [...voided].filter((id) => !deletedIds.has(id)).length;
  const parts: string[] = [];
  if (notDeleted > 0) {
    parts.push(
      `${plural(notDeleted, "invoice")} ${notDeleted === 1 ? "wasn't" : "weren't"} deleted${deleteError ? " — the delete failed" : ""}.`,
    );
    if (voidedOnly > 0) parts.push(`${plural(voidedOnly, "paid invoice")} ${voidedOnly === 1 ? "was" : "were"} voided but not deleted.`);
    parts.push("Reload and try again.");
  }
  if (logFailed) parts.push("The status-log entries for this couldn't be written.");
  const message = parts.join(" ");

  if (deleted.length === 0) {
    return { ok: false, deleted: 0, error: message || "Nothing was deleted. Please try again." };
  }
  return { ok: true, deleted: deleted.length, warning: message || undefined };
}
