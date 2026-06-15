import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";

/**
 * PPP staff assignments per opportunity (migration 030).
 *
 * Mirrors the Phase 1 commercial_account_assignments pattern: same
 * is_primary partial UNIQUE + removed_at soft-delete + restore-by-
 * re-adding. Role enum is opp-specific (5 roles vs accounts' 7) —
 * pre-bid / execution focus, no billing/foreman.
 *
 * Strict separation: no salesforce imports.
 */

export const OPPORTUNITY_ASSIGNMENT_ROLES = [
  "sales_rep",
  "lead_estimator",
  "primary_pm",
  "superintendent",
  "other",
] as const;
export type OpportunityAssignmentRole = (typeof OPPORTUNITY_ASSIGNMENT_ROLES)[number];

export function opportunityAssignmentRoleLabel(role: OpportunityAssignmentRole): string {
  return {
    sales_rep: "Sales Rep",
    lead_estimator: "Lead Estimator",
    primary_pm: "Project Manager",
    superintendent: "Superintendent",
    other: "Other",
  }[role];
}

export type OpportunityAssignmentPerson = {
  user_id: string;
  user_email: string;
  user_full_name: string | null;
  assignments: Array<{
    id: string;
    role: OpportunityAssignmentRole;
    is_primary: boolean;
    notes: string | null;
    assigned_at: string;
  }>;
};

/** Current team for an opportunity, grouped by person. Mirrors
 *  listAccountTeam — one card per user with N role pills, not N
 *  separate cards. */
export async function listOpportunityTeam(
  opportunity_id: string
): Promise<OpportunityAssignmentPerson[]> {
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunity_assignments")
    .select(
      "id, role, is_primary, notes, assigned_at, removed_at, user_id, user:profiles!commercial_opportunity_assignments_user_id_fkey(user_id, email, sf_user_name)"
    )
    .eq("opportunity_id", opportunity_id)
    .is("removed_at", null);
  if (error) {
    console.warn("[commercial/opportunities/assignments] list failed:", error.message);
    return [];
  }
  type Row = {
    id: string;
    role: OpportunityAssignmentRole;
    is_primary: boolean;
    notes: string | null;
    assigned_at: string;
    user_id: string;
    user:
      | { user_id: string; email: string; sf_user_name: string | null }
      | Array<{ user_id: string; email: string; sf_user_name: string | null }>
      | null;
  };
  const byUser = new Map<string, OpportunityAssignmentPerson>();
  for (const raw of (data ?? []) as unknown as Row[]) {
    const u = Array.isArray(raw.user) ? raw.user[0] ?? null : raw.user;
    if (!u) continue;
    const existing = byUser.get(u.user_id);
    const row = {
      id: raw.id,
      role: raw.role,
      is_primary: raw.is_primary,
      notes: raw.notes,
      assigned_at: raw.assigned_at,
    };
    if (existing) {
      existing.assignments.push(row);
    } else {
      byUser.set(u.user_id, {
        user_id: u.user_id,
        user_email: u.email,
        user_full_name: u.sf_user_name,
        assignments: [row],
      });
    }
  }
  return Array.from(byUser.values()).sort((a, b) =>
    (a.user_full_name ?? a.user_email).localeCompare(b.user_full_name ?? b.user_email)
  );
}

export type AddOpportunityAssignmentInput = {
  opportunity_id: string;
  user_id: string;
  role: OpportunityAssignmentRole;
  is_primary?: boolean;
  notes?: string | null;
  assigned_by_user_id?: string | null;
};

export async function addOpportunityAssignment(
  input: AddOpportunityAssignmentInput
): Promise<{ ok: true; assignment_id: string } | { ok: false; error: string }> {
  const sb = commercialDb();

  // Guard the parent opp + the underlying account (chain of trust).
  const { data: opp } = await sb
    .from("commercial_opportunities")
    .select("id, account_id, deleted_at")
    .eq("id", input.opportunity_id)
    .maybeSingle();
  if (!opp || opp.deleted_at) return { ok: false, error: "Opportunity not found." };
  const { data: acct } = await sb
    .from("commercial_accounts")
    .select("id, deleted_at")
    .eq("id", opp.account_id)
    .maybeSingle();
  if (!acct || acct.deleted_at) return { ok: false, error: "Account not found." };

  // Guard the assignee: must exist + be active + have Commercial CC access.
  const { data: assignee } = await sb
    .from("profiles")
    .select("user_id, is_active, has_new_platform_access")
    .eq("user_id", input.user_id)
    .maybeSingle();
  if (!assignee) return { ok: false, error: "Staff member not found." };
  if (assignee.is_active === false) {
    return { ok: false, error: "Can't assign an inactive staff member." };
  }
  if (!assignee.has_new_platform_access) {
    return { ok: false, error: "Staff member doesn't have Commercial CC access." };
  }

  // Look for an existing row (active OR previously removed).
  const { data: existing } = await sb
    .from("commercial_opportunity_assignments")
    .select("*")
    .eq("opportunity_id", input.opportunity_id)
    .eq("user_id", input.user_id)
    .eq("role", input.role)
    .maybeSingle();

  if (existing) {
    const e = existing as { id: string; removed_at: string | null; is_primary: boolean };
    if (!e.removed_at) {
      // Active row — usually a no-op error, but allow ONE thing through:
      // promoting a current-secondary to primary. Alex re-submits the
      // same person + role with the primary checkbox flipped on. Without
      // this branch he'd have to remove + re-add, which is silly.
      if (input.is_primary && !e.is_primary) {
        await demoteCurrentPrimary(
          input.opportunity_id,
          input.role,
          input.assigned_by_user_id ?? null
        );
        const { data: promoted, error: promoteErr } = await sb
          .from("commercial_opportunity_assignments")
          .update({
            is_primary: true,
            notes: input.notes?.trim() || null,
            assigned_by_user_id: input.assigned_by_user_id ?? null,
          })
          .eq("id", e.id)
          .select("*")
          .single();
        if (promoteErr) return { ok: false, error: promoteErr.message };
        await logUpdate(
          "commercial_opportunity_assignments",
          e.id,
          existing,
          promoted,
          input.assigned_by_user_id
        );
        return { ok: true, assignment_id: e.id };
      }
      return { ok: false, error: "This person is already on this opp in that role." };
    }
    // Restore path — previously removed. Bring back online.
    if (input.is_primary) {
      await demoteCurrentPrimary(
        input.opportunity_id,
        input.role,
        input.assigned_by_user_id ?? null
      );
    }
    const { data: restored, error: restoreErr } = await sb
      .from("commercial_opportunity_assignments")
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
      "commercial_opportunity_assignments",
      e.id,
      existing,
      restored,
      input.assigned_by_user_id
    );
    return { ok: true, assignment_id: e.id };
  }

  if (input.is_primary) {
    await demoteCurrentPrimary(
      input.opportunity_id,
      input.role,
      input.assigned_by_user_id ?? null
    );
  }

  const { data: inserted, error: insertErr } = await sb
    .from("commercial_opportunity_assignments")
    .insert({
      opportunity_id: input.opportunity_id,
      user_id: input.user_id,
      role: input.role,
      is_primary: input.is_primary ?? false,
      notes: input.notes?.trim() || null,
      assigned_by_user_id: input.assigned_by_user_id ?? null,
    })
    .select("*")
    .single();
  if (insertErr) {
    if (insertErr.message.toLowerCase().includes("duplicate")) {
      return { ok: false, error: "This person is already on this opp in that role." };
    }
    return { ok: false, error: insertErr.message };
  }
  const row = inserted as { id: string };
  await logInsert(
    "commercial_opportunity_assignments",
    row.id,
    inserted,
    input.assigned_by_user_id
  );
  return { ok: true, assignment_id: row.id };
}

export async function removeOpportunityAssignment(
  opportunity_id: string,
  assignment_id: string,
  removed_by_user_id?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunity_assignments")
    .select("*")
    .eq("id", assignment_id)
    .eq("opportunity_id", opportunity_id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Assignment not found." };
  const beforeRow = before as { removed_at: string | null };
  if (beforeRow.removed_at) return { ok: false, error: "Already removed." };

  const { data: after, error } = await sb
    .from("commercial_opportunity_assignments")
    .update({
      removed_at: new Date().toISOString(),
      removed_by_user_id: removed_by_user_id ?? null,
      is_primary: false,
    })
    .eq("id", assignment_id)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };
  await logUpdate(
    "commercial_opportunity_assignments",
    assignment_id,
    before,
    after,
    removed_by_user_id
  );
  return { ok: true };
}

async function demoteCurrentPrimary(
  opportunity_id: string,
  role: OpportunityAssignmentRole,
  actingUserId: string | null
): Promise<void> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunity_assignments")
    .select("*")
    .eq("opportunity_id", opportunity_id)
    .eq("role", role)
    .eq("is_primary", true)
    .is("removed_at", null)
    .maybeSingle();
  if (!before) return;
  const beforeRow = before as { id: string };
  const { data: after } = await sb
    .from("commercial_opportunity_assignments")
    .update({ is_primary: false })
    .eq("id", beforeRow.id)
    .select("*")
    .single();
  if (!after) return;
  await logUpdate(
    "commercial_opportunity_assignments",
    beforeRow.id,
    before,
    after,
    actingUserId
  );
}

/** Bulk-fetch the primary lead (whoever is is_primary=TRUE in any role,
 *  taking the most senior — primary_pm > lead_estimator > sales_rep)
 *  per opportunity, for the list page row badges. */
export async function listPrimaryLeadByOpp(
  opportunity_ids: string[]
): Promise<Map<string, { user_email: string; user_full_name: string | null; role: OpportunityAssignmentRole }>> {
  if (opportunity_ids.length === 0) return new Map();
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_opportunity_assignments")
    .select(
      "opportunity_id, role, user:profiles!commercial_opportunity_assignments_user_id_fkey(email, sf_user_name)"
    )
    .in("opportunity_id", opportunity_ids)
    .eq("is_primary", true)
    .is("removed_at", null);
  if (error) {
    console.warn("[commercial/opportunities/assignments] listPrimaryLeadByOpp:", error.message);
    return new Map();
  }
  type Row = {
    opportunity_id: string;
    role: OpportunityAssignmentRole;
    user:
      | { email: string; sf_user_name: string | null }
      | Array<{ email: string; sf_user_name: string | null }>
      | null;
  };
  // Seniority order — same role per opp shouldn't conflict (only one
  // is_primary per role) so we just pick the highest-ranked.
  const seniority: Record<OpportunityAssignmentRole, number> = {
    primary_pm: 0,
    lead_estimator: 1,
    sales_rep: 2,
    superintendent: 3,
    other: 9,
  };
  const out = new Map<string, { user_email: string; user_full_name: string | null; role: OpportunityAssignmentRole }>();
  for (const raw of (data ?? []) as unknown as Row[]) {
    const u = Array.isArray(raw.user) ? raw.user[0] ?? null : raw.user;
    if (!u) continue;
    const prev = out.get(raw.opportunity_id);
    if (!prev || seniority[raw.role] < seniority[prev.role]) {
      out.set(raw.opportunity_id, {
        user_email: u.email,
        user_full_name: u.sf_user_name,
        role: raw.role,
      });
    }
  }
  return out;
}
