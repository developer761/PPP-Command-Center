import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";

/**
 * PPP staff assignments per commercial Account.
 *
 * One row per (account, user, role). A staffer can hold multiple roles on
 * the same account; one row per role. Soft delete via `removed_at` so we
 * keep the audit trail.
 *
 * Identity is Supabase `profiles.user_id` (= auth.users.id). The Account
 * detail page → Team tab uses these helpers.
 */

export const ASSIGNMENT_ROLES = [
  "sales_rep",
  "account_manager",
  "primary_pm",
  "superintendent",
  "foreman",
  "billing_contact",
  "other",
] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export function assignmentRoleLabel(role: AssignmentRole): string {
  return {
    sales_rep: "Sales Rep",
    account_manager: "Account Manager",
    primary_pm: "Project Manager",
    superintendent: "Superintendent",
    foreman: "Foreman",
    billing_contact: "Billing Contact",
    other: "Other",
  }[role];
}

export type AssignedStaff = {
  id: string;            // commercial_account_assignments.id (the junction row)
  user_id: string;       // profiles.user_id
  user_email: string;
  user_full_name: string | null;
  role: AssignmentRole;
  is_primary: boolean;
  notes: string | null;
  assigned_at: string;
};

/**
 * List CURRENT (not-removed) staff for an account, grouped by person so the
 * UI can render "Sarah · Sales Rep + Account Manager" as one row.
 */
export async function listAccountTeam(accountId: string): Promise<
  Array<{
    user_id: string;
    user_email: string;
    user_full_name: string | null;
    assignments: Array<{
      id: string;
      role: AssignmentRole;
      is_primary: boolean;
      notes: string | null;
      assigned_at: string;
    }>;
  }>
> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_account_assignments")
    .select(
      "id, role, is_primary, notes, assigned_at, removed_at, user_id, user:profiles!commercial_account_assignments_user_id_fkey(user_id, email, sf_user_name)"
    )
    .eq("account_id", accountId)
    .is("removed_at", null);

  if (error) {
    console.warn("[commercial/assignments] list failed:", error.message);
    return [];
  }

  // Supabase typegen surfaces the joined row as either object or array.
  type Row = {
    id: string;
    role: AssignmentRole;
    is_primary: boolean;
    notes: string | null;
    assigned_at: string;
    removed_at: string | null;
    user_id: string;
    user:
      | { user_id: string; email: string; sf_user_name: string | null }
      | Array<{ user_id: string; email: string; sf_user_name: string | null }>
      | null;
  };

  const byUser = new Map<
    string,
    {
      user_id: string;
      user_email: string;
      user_full_name: string | null;
      assignments: Array<{
        id: string;
        role: AssignmentRole;
        is_primary: boolean;
        notes: string | null;
        assigned_at: string;
      }>;
    }
  >();

  for (const raw of (data ?? []) as unknown as Row[]) {
    const user = Array.isArray(raw.user) ? raw.user[0] ?? null : raw.user;
    if (!user) continue;
    const existing = byUser.get(user.user_id);
    const att = {
      id: raw.id,
      role: raw.role,
      is_primary: raw.is_primary,
      notes: raw.notes,
      assigned_at: raw.assigned_at,
    };
    if (existing) {
      existing.assignments.push(att);
    } else {
      byUser.set(user.user_id, {
        user_id: user.user_id,
        user_email: user.email,
        user_full_name: user.sf_user_name,
        assignments: [att],
      });
    }
  }

  return Array.from(byUser.values()).sort((a, b) =>
    (a.user_full_name ?? a.user_email).localeCompare(b.user_full_name ?? b.user_email)
  );
}

/**
 * List PPP staff who can be assigned. Anyone with New Platform access.
 * Used to populate the "Assign" dropdown on the Team tab.
 */
export async function listAssignableStaff(): Promise<
  Array<{ user_id: string; email: string; full_name: string | null }>
> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("profiles")
    .select("user_id, email, sf_user_name, is_active")
    .eq("has_new_platform_access", true)
    .order("email");
  if (error) {
    console.warn("[commercial/assignments] listAssignableStaff failed:", error.message);
    return [];
  }
  // Filter inactive at app layer so a deactivated user can still appear in
  // audit logs but not in the assign-new dropdown.
  return (data ?? [])
    .filter((r) => r.is_active !== false)
    .map((r) => ({
      user_id: r.user_id as string,
      email: r.email as string,
      full_name: (r.sf_user_name as string | null) ?? null,
    }));
}

export type AddAssignmentInput = {
  account_id: string;
  user_id: string;
  role: AssignmentRole;
  is_primary?: boolean;
  notes?: string | null;
  assigned_by_user_id?: string | null;
};

/**
 * Assign a PPP staffer to an account in a role.
 *
 * - Same (account, user, role) row already exists AND not removed → friendly error.
 * - Same row exists AND is `removed_at IS NOT NULL` → restore it (clear removed_at).
 * - is_primary=TRUE → ensure no other row holds primary for this (account, role).
 *
 * Returns the junction row's id.
 */
export async function addAssignment(
  input: AddAssignmentInput
): Promise<{ ok: true; assignment_id: string } | { ok: false; error: string }> {
  const sb = commercialDb();

  // Guard: refuse to assign to a missing or soft-deleted account so a
  // restored account never resurrects with phantom team members.
  const { data: account } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", input.account_id)
    .maybeSingle();
  if (!account || account.deleted_at) {
    return { ok: false, error: "Account not found." };
  }

  // Look for an existing row (active OR previously removed).
  const { data: existing } = await sb
    .from("commercial_account_assignments")
    .select("*")
    .eq("account_id", input.account_id)
    .eq("user_id", input.user_id)
    .eq("role", input.role)
    .maybeSingle();

  if (existing) {
    const e = existing as { id: string; removed_at: string | null };
    if (!e.removed_at) {
      return { ok: false, error: "This person is already assigned in that role." };
    }
    // Restore: clear removed_at + reset is_primary if requested.
    if (input.is_primary) {
      await demoteCurrentPrimary(input.account_id, input.role, input.assigned_by_user_id ?? null);
    }
    const { data: restored, error: restoreErr } = await sb
      .from("commercial_account_assignments")
      .update({
        removed_at: null,
        removed_by_user_id: null,
        is_primary: input.is_primary ?? false,
        notes: input.notes?.trim() || null,
        assigned_at: new Date().toISOString(),
        assigned_by_user_id: input.assigned_by_user_id ?? null,
      })
      .eq("id", e.id)
      .select("*")
      .single();
    if (restoreErr) return { ok: false, error: restoreErr.message };
    await logUpdate(
      "commercial_account_assignments",
      e.id,
      existing,
      restored,
      input.assigned_by_user_id
    );
    return { ok: true, assignment_id: e.id };
  }

  // Fresh row. Demote any existing primary in this (account, role) first.
  if (input.is_primary) {
    await demoteCurrentPrimary(input.account_id, input.role, input.assigned_by_user_id ?? null);
  }

  const { data: inserted, error: insertErr } = await sb
    .from("commercial_account_assignments")
    .insert({
      account_id: input.account_id,
      user_id: input.user_id,
      role: input.role,
      is_primary: input.is_primary ?? false,
      notes: input.notes?.trim() || null,
      assigned_by_user_id: input.assigned_by_user_id ?? null,
    })
    .select("*")
    .single();

  if (insertErr) {
    // Surface the unique-constraint variant in a friendly way.
    if (insertErr.message.toLowerCase().includes("duplicate")) {
      return { ok: false, error: "This person is already assigned in that role." };
    }
    return { ok: false, error: insertErr.message };
  }
  const row = inserted as { id: string };
  await logInsert(
    "commercial_account_assignments",
    row.id,
    inserted,
    input.assigned_by_user_id
  );
  return { ok: true, assignment_id: row.id };
}

/**
 * Remove an assignment (soft delete — sets `removed_at`). The audit row
 * captures the before/after state; the row itself stays for history.
 */
export async function removeAssignment(
  assignmentId: string,
  removedByUserId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_account_assignments")
    .select("*")
    .eq("id", assignmentId)
    .maybeSingle();
  if (!before) return { ok: false, error: "Assignment not found." };
  const beforeRow = before as { removed_at: string | null };
  if (beforeRow.removed_at) return { ok: false, error: "Already removed." };

  const { data: after, error } = await sb
    .from("commercial_account_assignments")
    .update({
      removed_at: new Date().toISOString(),
      removed_by_user_id: removedByUserId ?? null,
      is_primary: false,
    })
    .eq("id", assignmentId)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate(
    "commercial_account_assignments",
    assignmentId,
    before,
    after,
    removedByUserId
  );
  return { ok: true };
}

/** Clears `is_primary` on whoever currently holds it for (account, role).
 *  Audit-logs the demote so the trail shows WHO was demoted when a new
 *  primary took over. */
async function demoteCurrentPrimary(
  account_id: string,
  role: AssignmentRole,
  actingUserId: string | null
): Promise<void> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_account_assignments")
    .select("*")
    .eq("account_id", account_id)
    .eq("role", role)
    .eq("is_primary", true)
    .is("removed_at", null)
    .maybeSingle();
  if (!before) return;

  const beforeRow = before as { id: string };
  const { data: after } = await sb
    .from("commercial_account_assignments")
    .update({ is_primary: false })
    .eq("id", beforeRow.id)
    .select("*")
    .single();
  if (!after) return;

  await logUpdate(
    "commercial_account_assignments",
    beforeRow.id,
    before,
    after,
    actingUserId
  );
}
