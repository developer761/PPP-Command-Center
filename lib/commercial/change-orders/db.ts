/**
 * Change Order data layer (Phase G). Service-role only — every caller is a
 * server action or cron that has already passed assertCommercialAccess.
 *
 * Model notes:
 *  - A CO attaches to the post-sale opportunity (the "Project") + carries a
 *    denormalized account_id, mirroring commercial_invoices.
 *  - amount_cents is SIGNED. Approved COs feed the AIA net-change-orders sum
 *    (Phase H). A CO is billed as its OWN invoice (never folded into the base
 *    contract), linked via invoiced_invoice_id — which is also the double-bill
 *    guard.
 *  - The invoice schema forbids negative totals (unit_price_cents >= 0), so a
 *    deduct (negative) CO cannot be billed separately: it only adjusts the
 *    contract sum. billChangeOrder blocks it with a clear message.
 */

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import {
  createCommercialInvoice,
  notifyCommercialInvoiceCreated,
  type CommercialInvoice,
} from "@/lib/commercial/invoices/db";
import { formatChangeOrderNumber, type ChangeOrderStatus } from "./constants";
import { isPostSaleProject } from "@/lib/commercial/opportunities/constants";

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

  // Chain-of-trust: opp must exist, be live, AND be a post-sale Project; take
  // account_id from it. The post-sale gate matches the CO page/UI so a hand-
  // crafted POST can't attach a change order to a pre-sale deal.
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at, status, sub_status")
    .eq("id", input.opportunity_id)
    .maybeSingle();
  if (!opp || (opp as { deleted_at: string | null }).deleted_at) {
    return { ok: false, error: "opportunity_not_found" };
  }
  const row = opp as { account_id: string; status: string | null; sub_status: string | null };
  if (!isPostSaleProject({ status: row.status, sub_status: row.sub_status })) {
    return { ok: false, error: "Change orders can only be added to a Won/in-progress project." };
  }
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
export async function billChangeOrder(
  id: string,
  userId: string
): Promise<Result<CommercialInvoice>> {
  const co = await getChangeOrder(id);
  if (!co) return { ok: false, error: "not_found" };
  if (!(await oppIsLive(co.opportunity_id))) return { ok: false, error: DELETED_DEAL_ERROR };
  if (co.status !== "approved") {
    return { ok: false, error: "Approve the change order before billing it." };
  }
  if (co.amount_cents <= 0) {
    return {
      ok: false,
      error:
        "Deduct change orders reduce the contract sum and aren't billed separately — the amount is reflected in the AIA net change orders.",
    };
  }
  // `invoiced_invoice_id` is only ever SET, never cleared (the app soft-deletes
  // / voids invoices, it never hard-deletes, so the FK's ON DELETE SET NULL
  // doesn't fire). So a CO whose invoice was voided or removed still points at
  // that dead id. If the linked invoice is still live, it's genuinely billed;
  // if it's dead, this is a re-bill (e.g. the first invoice was voided to
  // reissue), which we allow.
  const priorInvoiceId = co.invoiced_invoice_id;
  if (priorInvoiceId && (await invoiceIsLive(priorInvoiceId))) {
    return { ok: false, error: "This change order is already billed." };
  }

  const created = await createCommercialInvoice({
    opportunity_id: co.opportunity_id,
    account_id: co.account_id,
    created_by_user_id: userId,
    notes: `Bills ${formatChangeOrderNumber(co.co_number)} — ${co.title}`,
    // Suppress the create-time notification — we only want the team to hear
    // about this invoice if it wins the claim below (a loser gets voided).
    skipCreatedNotification: true,
    line_items: [
      {
        description: `${formatChangeOrderNumber(co.co_number)} — ${co.title}`,
        quantity: 1,
        unit_price_cents: co.amount_cents,
      },
    ],
  });
  if (!created.ok) return { ok: false, error: created.error };

  const sb = commercialDb();
  // Atomic claim (compare-and-swap): link the new invoice ONLY if the CO's
  // link column is still exactly what we saw a moment ago — null for a fresh
  // bill, or the dead invoice id for a re-bill. Either way a concurrent bill
  // (double-click, second tab, second user, raced resubmit) can only have ONE
  // request match, so we can't mint two live invoices for one CO. The `.eq`
  // on status also closes a decline-during-bill race. The loser (and the
  // link-write-failure path) soft-deletes its just-created draft so no orphan
  // is left behind and a literal retry can't double-bill.
  const claim = sb
    .from("commercial_change_orders")
    .update({ invoiced_invoice_id: created.invoice.id, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "approved");
  const { data: claimed, error } = await (
    priorInvoiceId
      ? claim.eq("invoiced_invoice_id", priorInvoiceId)
      : claim.is("invoiced_invoice_id", null)
  )
    .select("id")
    .maybeSingle();

  if (error || !claimed) {
    // Lost the race (0 rows) or the link write errored — void the orphan draft
    // we just created so it can't be sent, then tell the user it's already
    // billed. Best-effort: even if this soft-delete fails, the invoice is an
    // unsent draft and the CO already carries the winning invoice's id.
    await sb
      .from("commercial_invoices")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", created.invoice.id);
    return {
      ok: false,
      error: error
        ? "Couldn't link the invoice to the change order — please try again."
        : "This change order was just billed on another invoice — refresh to see it.",
    };
  }

  await logUpdate(
    "commercial_change_orders",
    id,
    { invoiced_invoice_id: co.invoiced_invoice_id },
    { invoiced_invoice_id: created.invoice.id },
    userId
  );
  // Claim won — NOW tell the team about the invoice (suppressed at create time).
  void notifyCommercialInvoiceCreated(created.invoice, userId);
  return { ok: true, value: created.invoice };
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
