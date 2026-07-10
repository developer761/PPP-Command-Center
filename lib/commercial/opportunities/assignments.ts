import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { logInsert, logUpdate } from "@/lib/commercial/audit-log";
import { sendEmail } from "@/lib/email/resend";
import { insertCommercialTeamAssignedNotification } from "@/lib/notifications/insert";
import { derivedOppName } from "@/lib/commercial/opportunities/db";

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
        const demoteRes = await demoteCurrentPrimary(
          input.opportunity_id,
          input.role,
          input.assigned_by_user_id ?? null
        );
        if (!demoteRes.ok) return { ok: false, error: demoteRes.error };
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
        // Heads-up on promotion — they're now the buck-stops-here person.
        void notifyAssignment(
          e.id,
          input.opportunity_id,
          input.user_id,
          input.role,
          true,
          input.assigned_by_user_id ?? null,
          "promoted"
        ).catch((err) => {
          console.warn(`[commercial/opportunities/assignments] notify-on-promote failed:`, err);
        });
        return { ok: true, assignment_id: e.id };
      }
      return { ok: false, error: "This person is already on this opp in that role." };
    }
    // Restore path — previously removed. Bring back online.
    if (input.is_primary) {
      const demoteRes = await demoteCurrentPrimary(
        input.opportunity_id,
        input.role,
        input.assigned_by_user_id ?? null
      );
      if (!demoteRes.ok) return { ok: false, error: demoteRes.error };
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
    void notifyAssignment(
      e.id,
      input.opportunity_id,
      input.user_id,
      input.role,
      input.is_primary ?? false,
      input.assigned_by_user_id ?? null,
      "restored"
    ).catch((err) => {
      console.warn(`[commercial/opportunities/assignments] notify-on-restore failed:`, err);
    });
    return { ok: true, assignment_id: e.id };
  }

  if (input.is_primary) {
    const demoteRes = await demoteCurrentPrimary(
      input.opportunity_id,
      input.role,
      input.assigned_by_user_id ?? null
    );
    if (!demoteRes.ok) return { ok: false, error: demoteRes.error };
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
  // Fire-and-forget — never block the assignment write on a Resend hiccup.
  void notifyAssignment(
    row.id,
    input.opportunity_id,
    input.user_id,
    input.role,
    input.is_primary ?? false,
    input.assigned_by_user_id ?? null,
    "assigned"
  ).catch((err) => {
    console.warn(`[commercial/opportunities/assignments] notify-on-assign failed:`, err);
  });
  return { ok: true, assignment_id: row.id };
}

/**
 * Email the assignee with a short heads-up + link to the opp detail page.
 * Fire-and-forget — never blocks the assignment write. Mirrors the accounts
 * `notifyAssignment` shape; opp version pulls the opp title (and parent
 * account name for context) instead of a single account name.
 */
async function notifyAssignment(
  assignment_id: string,
  opportunity_id: string,
  user_id: string,
  role: OpportunityAssignmentRole,
  is_primary: boolean,
  assigned_by_user_id: string | null,
  action: "assigned" | "promoted" | "restored"
): Promise<void> {
  // Skip the email when a user assigns/promotes themself — Alice already
  // knows she's now on the deal because she literally just clicked it.
  if (assigned_by_user_id && assigned_by_user_id === user_id) return;
  const sb = commercialDb();
  const [oppRes, userRes, byRes] = await Promise.all([
    sb
      .from("commercial_opportunities")
      // Phase B: pull client_name + location_short so derivedOppName can
      // return the CEO's {account} - {client} - {location} format.
      .select("title, client_name, location_short, account:commercial_accounts!commercial_opportunities_account_id_fkey(company_name)")
      .eq("id", opportunity_id)
      .maybeSingle(),
    sb.from("profiles").select("email, sf_user_name").eq("user_id", user_id).maybeSingle(),
    assigned_by_user_id
      ? sb.from("profiles").select("sf_user_name, email").eq("user_id", assigned_by_user_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  type OppRow = {
    title?: string;
    client_name?: string | null;
    location_short?: string | null;
    account?: { company_name?: string } | Array<{ company_name?: string }> | null;
  };
  const oppData = oppRes.data as OppRow | null;
  const accountName = Array.isArray(oppData?.account)
    ? oppData.account[0]?.company_name
    : oppData?.account?.company_name;
  // Phase B: derived name replaces raw title in the assignment email
  // body so users see the CEO's standardized display everywhere.
  const oppTitle = oppData
    ? derivedOppName(
        {
          title: oppData.title ?? "an opportunity",
          client_name: oppData.client_name ?? null,
          location_short: oppData.location_short ?? null,
        },
        accountName ?? null,
      )
    : "an opportunity";
  const assigneeEmail = (userRes.data as { email?: string } | null)?.email;
  if (!assigneeEmail) {
    console.warn(`[commercial/opportunities/assignments] no email on user ${user_id} — skipping notify`);
    return;
  }
  const assignerName =
    (byRes.data as { sf_user_name?: string; email?: string } | null)?.sf_user_name ||
    (byRes.data as { sf_user_name?: string; email?: string } | null)?.email ||
    "PPP admin";
  const roleLabel = opportunityAssignmentRoleLabel(role);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "";
  const oppUrl = `${baseUrl}/commercial/opportunities/${opportunity_id}`;
  const verbLine =
    action === "promoted"
      ? `${assignerName} promoted you to PRIMARY ${roleLabel} on this opportunity.`
      : action === "restored"
        ? `${assignerName} added you back to this opportunity as ${roleLabel}.`
        : `${assignerName} assigned you to this opportunity as ${roleLabel}.`;
  const verbLineHtml =
    action === "promoted"
      ? `<strong>${escape(assignerName)}</strong> promoted you to <strong>PRIMARY ${escape(roleLabel)}</strong> on this opportunity.`
      : action === "restored"
        ? `<strong>${escape(assignerName)}</strong> added you <strong>back</strong> to this opportunity as <strong>${escape(roleLabel)}</strong>.`
        : `<strong>${escape(assignerName)}</strong> assigned you to this opportunity as <strong>${escape(roleLabel)}</strong>.`;
  const primaryNote =
    is_primary && action !== "promoted"
      ? `\n\nYou're set as the PRIMARY ${roleLabel.toLowerCase()} on this opp — first stop for ${roleLabel.toLowerCase()} questions.`
      : "";
  const accountLine = accountName ? `\n\nAccount: ${accountName}` : "";
  const text = [
    `Hi,`,
    ``,
    `${verbLine}${primaryNote}`,
    ``,
    `Opportunity: ${oppTitle}${accountLine}`,
    ``,
    `View the opp: ${oppUrl}`,
    ``,
    `— PPP Commercial Command Center`,
  ].join("\n");
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#222;max-width:560px;">
  <p>Hi,</p>
  <p>${verbLineHtml}${is_primary && action !== "promoted" ? `<br><br>You're set as the <strong>PRIMARY ${escape(roleLabel.toLowerCase())}</strong> on this opp — first stop for ${escape(roleLabel.toLowerCase())} questions.` : ""}</p>
  <p style="margin:18px 0;color:#444;"><strong>Opportunity:</strong> ${escape(oppTitle)}${accountName ? `<br><strong>Account:</strong> ${escape(accountName)}` : ""}</p>
  <p style="margin:24px 0;"><a href="${oppUrl}" style="display:inline-block;padding:10px 18px;background:#059669;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">View the opportunity →</a></p>
  <p style="font-size:12px;color:#666;margin-top:32px;">— PPP Commercial Command Center</p>
</div>`;
  const subjectVerb =
    action === "promoted"
      ? `Promoted to primary ${roleLabel}`
      : action === "restored"
        ? `Re-added to ${oppTitle}`
        : `You've been assigned to ${oppTitle}`;
  const result = await sendEmail({
    to: assigneeEmail,
    subject: `${subjectVerb} (${roleLabel})`,
    text,
    html,
    // Commercial channel — separate sender domain + Resend key from
    // customer-facing email so deliverability reputations stay isolated.
    channel: "commercial",
    tags: [
      { name: "kind", value: "commercial_opportunity_assignment" },
      { name: "assignment_id", value: assignment_id },
      { name: "action", value: action },
    ],
  });
  if (!result.ok) {
    console.warn(`[commercial/opportunities/assignments] notify send failed:`, result.error);
  }

  // In-app bell row — fire-and-forget. Survives email outages so the
  // assignee still sees a red dot the next time they open the platform.
  void insertCommercialTeamAssignedNotification({
    surface: "opportunity",
    parentId: opportunity_id,
    parentName: oppTitle,
    secondaryName: accountName ?? null,
    recipientUserId: user_id,
    roleLabel,
    isPrimary: is_primary,
    action,
    assignerName,
    actingUserId: assigned_by_user_id,
  }).catch((err) => {
    console.warn(`[commercial/opportunities/assignments] bell insert failed:`, err);
  });
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

/**
 * Demote the current primary holder for a (opportunity, role) pair so the
 * caller can promote a new primary atomically. Returns ok=true even when
 * there's nothing to demote (no current primary).
 *
 * Audit fix 2026-06-24 (logic-flow #6): previously this returned void and
 * swallowed both "nothing to demote" and update-failed errors into the
 * same silent code path. A failed demote left two primaries in the DB
 * violating the (opportunity_id, role, is_primary=true) invariant. Now
 * returns a discriminated result so the promote caller can abort + surface
 * the error instead of writing inconsistent state.
 */
async function demoteCurrentPrimary(
  opportunity_id: string,
  role: OpportunityAssignmentRole,
  actingUserId: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: before } = await sb
    .from("commercial_opportunity_assignments")
    .select("*")
    .eq("opportunity_id", opportunity_id)
    .eq("role", role)
    .eq("is_primary", true)
    .is("removed_at", null)
    .maybeSingle();
  if (!before) return { ok: true }; // nothing to demote — clean state
  const beforeRow = before as { id: string };
  const { data: after, error: updErr } = await sb
    .from("commercial_opportunity_assignments")
    .update({ is_primary: false })
    .eq("id", beforeRow.id)
    .eq("is_primary", true) // race guard — only demote if still primary
    .select("*")
    .maybeSingle();
  if (updErr) {
    return { ok: false, error: `Demote failed: ${updErr.message}` };
  }
  if (!after) {
    // Race: prior primary was already demoted by another concurrent call.
    // That's fine — caller can proceed.
    return { ok: true };
  }
  await logUpdate(
    "commercial_opportunity_assignments",
    beforeRow.id,
    before,
    after,
    actingUserId
  );
  return { ok: true };
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
      "opportunity_id, role, user:profiles!commercial_opportunity_assignments_user_id_fkey(email, sf_user_name, is_active)"
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
      | { email: string; sf_user_name: string | null; is_active: boolean | null }
      | Array<{ email: string; sf_user_name: string | null; is_active: boolean | null }>
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
    // Deactivated leads should not surface as the ★ on the list-page row
    // — a row that says "Primary: <deactivated person>" reads as a stale
    // signal worse than no lead at all. Team tab on opp detail still
    // shows them so admin sees the reassign-needed state.
    if (u.is_active === false) continue;
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
