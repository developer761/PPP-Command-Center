import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { paginateAll } from "@/lib/commercial/paginate";
import { logInsert, logUpdate, logDelete } from "@/lib/commercial/audit-log";
import { ASSIGNMENT_ROLES, type AssignmentRole } from "@/lib/commercial/accounts/assignment-roles";

/**
 * Teams — reusable named groups of staff (Karan meeting 2026-08). A team has a
 * name, a team admin, and members with roles. Assigned to an account/opportunity
 * by name. Members are Supabase users (profiles.user_id = auth.users.id), same
 * identity as commercial_account_assignments.
 */

export type TeamMember = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: AssignmentRole;
  is_team_admin: boolean;
};
export type TeamSummary = { id: string; name: string; member_count: number; admin_name: string | null };
export type TeamWithMembers = { id: string; name: string; members: TeamMember[] };

function displayName(email: string | null, sf: string | null): string {
  return (sf ?? "").trim() || (email ?? "").trim() || "(user)";
}
function isRole(r: string): r is AssignmentRole {
  return (ASSIGNMENT_ROLES as readonly string[]).includes(r);
}

/** Users who can be team members — active commercial-platform profiles. */
export async function listAssignableUsers(): Promise<{ user_id: string; name: string; email: string }[]> {
  const sb = commercialDb();
  // paginateAll + a stable order: Supabase silently caps a bare select at
  // 1000 rows, and this one selects EVERY profile with platform access — the
  // most likely of the team queries to hit it. A truncated list here doesn't
  // error, it just quietly hides people from the add-member picker.
  const data = await paginateAll<{ user_id: string; email: string | null; sf_user_name: string | null }>(() =>
    sb
      .from("profiles")
      .select("user_id, email, sf_user_name, is_active, has_new_platform_access")
      .eq("has_new_platform_access", true)
      .neq("is_active", false)
      .order("user_id", { ascending: true })
  );
  return (data ?? [])
    .map((p) => ({ user_id: p.user_id, name: displayName(p.email, p.sf_user_name), email: (p.email ?? "").trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listTeams(): Promise<TeamSummary[]> {
  const sb = commercialDb();
  const rows = await paginateAll<{ id: string; name: string }>(() =>
    sb.from("commercial_teams").select("id, name").is("deleted_at", null).order("name").order("id")
  );
  if (rows.length === 0) return [];
  const ids = rows.map((t) => t.id);
  const mem = await paginateAll<{ team_id: string; user_id: string; is_team_admin: boolean }>(() =>
    sb
      .from("commercial_team_members")
      .select("team_id, user_id, is_team_admin")
      .in("team_id", ids)
      .is("removed_at", null)
      .order("id", { ascending: true })
  );
  const countByTeam = new Map<string, number>();
  const adminUserByTeam = new Map<string, string>();
  for (const m of mem) {
    countByTeam.set(m.team_id, (countByTeam.get(m.team_id) ?? 0) + 1);
    if (m.is_team_admin) adminUserByTeam.set(m.team_id, m.user_id);
  }
  const adminUserIds = [...new Set(adminUserByTeam.values())];
  const nameByUser = new Map<string, string>();
  if (adminUserIds.length) {
    const { data: profs } = await sb.from("profiles").select("user_id, email, sf_user_name").in("user_id", adminUserIds);
    for (const p of (profs ?? []) as { user_id: string; email: string | null; sf_user_name: string | null }[]) {
      nameByUser.set(p.user_id, displayName(p.email, p.sf_user_name));
    }
  }
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    member_count: countByTeam.get(t.id) ?? 0,
    admin_name: adminUserByTeam.has(t.id) ? nameByUser.get(adminUserByTeam.get(t.id)!) ?? null : null,
  }));
}

export async function getTeam(id: string): Promise<TeamWithMembers | null> {
  const sb = commercialDb();
  const { data: team } = await sb.from("commercial_teams").select("id, name").eq("id", id).is("deleted_at", null).maybeSingle();
  if (!team) return null;
  const t = team as { id: string; name: string };
  const mem = await paginateAll<{ id: string; user_id: string; role: AssignmentRole; is_team_admin: boolean }>(() =>
    sb
      .from("commercial_team_members")
      .select("id, user_id, role, is_team_admin")
      .eq("team_id", id)
      .is("removed_at", null)
      .order("id", { ascending: true })
  );
  const userIds = mem.map((m) => m.user_id);
  const nameByUser = new Map<string, { name: string; email: string }>();
  if (userIds.length) {
    const { data: profs } = await sb.from("profiles").select("user_id, email, sf_user_name").in("user_id", userIds);
    for (const p of (profs ?? []) as { user_id: string; email: string | null; sf_user_name: string | null }[]) {
      nameByUser.set(p.user_id, { name: displayName(p.email, p.sf_user_name), email: (p.email ?? "").trim() });
    }
  }
  const members2: TeamMember[] = mem
    .map((m) => ({
      id: m.id,
      user_id: m.user_id,
      name: nameByUser.get(m.user_id)?.name ?? "(user)",
      email: nameByUser.get(m.user_id)?.email ?? "",
      role: m.role,
      is_team_admin: m.is_team_admin,
    }))
    .sort((a, b) => Number(b.is_team_admin) - Number(a.is_team_admin) || a.name.localeCompare(b.name));
  return { id: t.id, name: t.name, members: members2 };
}

export async function createTeam(name: string, actorUserId: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const n = name.trim().slice(0, 120);
  if (!n) return { ok: false, error: "Team name is required." };
  const sb = commercialDb();
  const { data, error } = await sb
    .from("commercial_teams")
    .insert({ name: n, created_by_user_id: actorUserId })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  await logInsert("commercial_teams", (data as { id: string }).id, { name: n }, actorUserId);
  return { ok: true, id: (data as { id: string }).id };
}

export async function renameTeam(id: string, name: string, actorUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const n = name.trim().slice(0, 120);
  if (!n) return { ok: false, error: "Team name is required." };
  const sb = commercialDb();
  const { error } = await sb.from("commercial_teams").update({ name: n, updated_at: new Date().toISOString() }).eq("id", id).is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_teams", id, {}, { name: n }, actorUserId);
  return { ok: true };
}

export async function deleteTeam(id: string, actorUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { error } = await sb.from("commercial_teams").update({ deleted_at: new Date().toISOString() }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  // Detach from any account/opp that referenced it so nothing points at a dead team.
  await sb.from("commercial_accounts").update({ team_id: null }).eq("team_id", id);
  await sb.from("commercial_opportunities").update({ team_id: null }).eq("team_id", id);
  await logDelete("commercial_teams", id, { id }, actorUserId);
  return { ok: true };
}

export async function addTeamMember(
  teamId: string,
  userId: string,
  role: string,
  actorUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  // "other" was retired with the seven-role list (Brendan 2026-08-12). An
  // unrecognised role falls back to Sales Rep — the most common assignment —
  // rather than to a value the enum no longer contains.
  const r: AssignmentRole = isRole(role) ? role : "sales_rep";
  const sb = commercialDb();
  // Revive a soft-removed membership instead of compounding duplicates.
  const { data: existing } = await sb
    .from("commercial_team_members")
    .select("id, removed_at")
    .eq("team_id", teamId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) {
    const ex = existing as { id: string; removed_at: string | null };
    if (!ex.removed_at) return { ok: false, error: "Already on this team." };
    const { error } = await sb.from("commercial_team_members").update({ removed_at: null, role: r }).eq("id", ex.id);
    if (error) return { ok: false, error: error.message };
    await logUpdate("commercial_team_members", ex.id, { removed_at: "set" }, { removed_at: null, role: r }, actorUserId);
    return { ok: true };
  }
  const { data, error } = await sb
    .from("commercial_team_members")
    .insert({ team_id: teamId, user_id: userId, role: r })
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  await logInsert("commercial_team_members", (data as { id: string }).id, { team_id: teamId, user_id: userId, role: r }, actorUserId);
  return { ok: true };
}

/**
 * A team must always have exactly one admin. If the current one just left (or
 * was demoted), hand the flag to the longest-standing remaining member.
 *
 * Auto-promote rather than refuse the removal: blocking "you can't remove the
 * last admin" makes the user fight the tool to do something reasonable, and
 * an admin-less team is a silently broken one. Returns the name of whoever
 * was promoted so the caller can mention it — a small heads-up, not a wall.
 */
async function ensureTeamHasAdmin(
  teamId: string,
  actorUserId: string
): Promise<string | null> {
  const sb = commercialDb();
  const { data: rows } = await sb
    .from("commercial_team_members")
    .select("id, user_id, is_team_admin, created_at")
    .eq("team_id", teamId)
    .is("removed_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  const members = (rows ?? []) as {
    id: string;
    user_id: string;
    is_team_admin: boolean;
    created_at: string;
  }[];
  if (members.length === 0) return null; // empty team — nothing to promote
  if (members.some((m) => m.is_team_admin)) return null; // still has one
  const heir = members[0];
  const { error } = await sb
    .from("commercial_team_members")
    .update({ is_team_admin: true })
    .eq("id", heir.id);
  if (error) return null;
  await logUpdate(
    "commercial_team_members",
    heir.id,
    { is_team_admin: false },
    { is_team_admin: true },
    actorUserId
  );
  const { data: prof } = await sb
    .from("profiles")
    .select("email, sf_user_name")
    .eq("user_id", heir.user_id)
    .maybeSingle();
  const p = prof as { email: string | null; sf_user_name: string | null } | null;
  return displayName(p?.email ?? null, p?.sf_user_name ?? null);
}

export async function removeTeamMember(
  memberId: string,
  actorUserId: string
): Promise<{ ok: true; promotedAdmin?: string | null } | { ok: false; error: string }> {
  const sb = commercialDb();
  // Read the team BEFORE the soft-delete — afterwards we'd have to hunt for
  // it through a removed row.
  const { data: before } = await sb
    .from("commercial_team_members")
    .select("team_id")
    .eq("id", memberId)
    .maybeSingle();
  const teamId = (before as { team_id: string } | null)?.team_id ?? null;
  const { error } = await sb.from("commercial_team_members").update({ removed_at: new Date().toISOString() }).eq("id", memberId);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_team_members", memberId, { id: memberId }, actorUserId);
  const promotedAdmin = teamId ? await ensureTeamHasAdmin(teamId, actorUserId) : null;
  return { ok: true, promotedAdmin };
}

/**
 * Write a team's members into the account's role-based assignments.
 *
 * Karan 2026-08, asked directly: "should assigning a team also expand into
 * commercial_account_assignments so PM/rep lookups see them?" — YES. Picking a
 * team by name is meant to APPLY those people, not just label the account.
 * Without this, `team_id` was a decoration: every role lookup (primary PM,
 * sales rep, foreman, billing contact) reads assignments and saw nobody.
 *
 * ADDITIVE, never destructive. It does not remove anyone who was assigned
 * individually — those stay as overrides, which is exactly what the account
 * Team tab already tells the user. Re-applying the same team is a no-op
 * because addAssignment restores/dedupes on (account, user, role).
 *
 * Best-effort per member: one member who can't be assigned (deactivated
 * between page load and submit, no platform access) must not abort the rest.
 * Returns counts so the caller can give a small, honest heads-up instead of
 * silently doing half the job.
 */
export async function applyTeamToAccountAssignments(
  accountId: string,
  teamId: string,
  actorUserId: string
): Promise<{ added: number; alreadyThere: number; skipped: string[] }> {
  const team = await getTeam(teamId);
  if (!team) return { added: 0, alreadyThere: 0, skipped: [] };
  const { addAssignment } = await import("@/lib/commercial/accounts/assignments");
  let added = 0;
  let alreadyThere = 0;
  const skipped: string[] = [];
  for (const m of team.members) {
    const res = await addAssignment({
      account_id: accountId,
      user_id: m.user_id,
      role: m.role,
      assigned_by_user_id: actorUserId,
    });
    if (res.ok) {
      added += 1;
    } else if (res.error.toLowerCase().includes("already assigned")) {
      // Idempotent: the person already holds that role here.
      alreadyThere += 1;
    } else {
      skipped.push(`${m.name} (${res.error})`);
    }
  }
  return { added, alreadyThere, skipped };
}

/** Assign (or clear, with null) the team on an account or opportunity — the
 *  "add a Team by name" flow. `parent` is 'account' or 'opportunity'.
 *
 *  Assigning to an ACCOUNT also expands the team into that account's
 *  role-based assignments (see applyTeamToAccountAssignments). Opportunities
 *  don't have their own assignment table — a deal's crew is the account's —
 *  so setting a team there is the label + the getEffectiveOwnerTeam lookup. */
export async function setOwnerTeam(
  parent: "account" | "opportunity",
  ownerId: string,
  teamId: string | null,
  actorUserId: string
): Promise<{ ok: true; applied?: { added: number; alreadyThere: number; skipped: string[] } } | { ok: false; error: string }> {
  const sb = commercialDb();
  const table = parent === "account" ? "commercial_accounts" : "commercial_opportunities";
  if (teamId) {
    const { data: t } = await sb.from("commercial_teams").select("id").eq("id", teamId).is("deleted_at", null).maybeSingle();
    if (!t) return { ok: false, error: "Team not found." };
  }
  const { error } = await sb.from(table).update({ team_id: teamId }).eq("id", ownerId).is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  await logUpdate(table, ownerId, {}, { team_id: teamId }, actorUserId);
  // Clearing a team deliberately leaves the people in place: they may have
  // been doing the work for weeks, and silently un-assigning a whole crew
  // because someone blanked a dropdown is a far worse surprise than a stale
  // name on the roster (which the user can remove individually).
  const applied =
    parent === "account" && teamId
      ? await applyTeamToAccountAssignments(ownerId, teamId, actorUserId)
      : undefined;
  return { ok: true, applied };
}

/** Team assigned to an account/opportunity (with members), or null. */
export async function getOwnerTeam(teamId: string | null | undefined): Promise<TeamWithMembers | null> {
  if (!teamId) return null;
  return getTeam(teamId);
}

/**
 * The team that actually applies to a deal: its own if set, otherwise the
 * account's.
 *
 * The new-deal form offers "Account's team (default)", which stores NULL —
 * but nothing resolved a null deal team back to the account's, so a deal
 * labelled "default" in fact had NO team, and anything reading the deal's
 * crew came up empty. This makes the inheritance the label promises real.
 *
 * `inherited` tells the UI which of the two it got, so a deal can show
 * "Team · Coastal Crew (from customer)" rather than implying someone picked
 * it on this deal specifically.
 */
export async function getEffectiveOwnerTeam(
  ownTeamId: string | null | undefined,
  accountTeamId: string | null | undefined
): Promise<{ team: TeamWithMembers | null; inherited: boolean }> {
  if (ownTeamId) {
    const team = await getTeam(ownTeamId);
    // A deleted team leaves a dangling id — fall through to the account's
    // rather than reporting "no team" on a deal that has an obvious answer.
    if (team) return { team, inherited: false };
  }
  if (!accountTeamId) return { team: null, inherited: false };
  return { team: await getTeam(accountTeamId), inherited: true };
}

/** Set a member's role and/or team-admin flag. Setting a new admin clears the
 *  others so a team has exactly one admin. */
export async function updateTeamMember(
  memberId: string,
  patch: { role?: string; is_team_admin?: boolean },
  actorUserId: string
): Promise<{ ok: true; promotedAdmin?: string | null } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: row } = await sb.from("commercial_team_members").select("team_id, role, is_team_admin").eq("id", memberId).maybeSingle();
  if (!row) return { ok: false, error: "Member not found." };
  const cur = row as { team_id: string; role: AssignmentRole; is_team_admin: boolean };
  const update: { role?: AssignmentRole; is_team_admin?: boolean } = {};
  if (patch.role !== undefined) update.role = isRole(patch.role) ? patch.role : "sales_rep";
  if (patch.is_team_admin !== undefined) update.is_team_admin = patch.is_team_admin;
  if (update.is_team_admin === true) {
    // One admin per team — clear the flag on the others first.
    await sb.from("commercial_team_members").update({ is_team_admin: false }).eq("team_id", cur.team_id).is("removed_at", null);
  }
  const { error } = await sb.from("commercial_team_members").update(update).eq("id", memberId);
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_team_members", memberId, cur, update, actorUserId);
  // Demoting the only admin would leave the team without one — hand it on
  // rather than refusing the edit.
  const promotedAdmin =
    update.is_team_admin === false
      ? await ensureTeamHasAdmin(cur.team_id, actorUserId)
      : null;
  return { ok: true, promotedAdmin };
}
