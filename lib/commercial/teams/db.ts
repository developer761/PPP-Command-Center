import "server-only";

import { commercialDb } from "@/lib/commercial/db";
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
  const { data } = await sb
    .from("profiles")
    .select("user_id, email, sf_user_name, is_active, has_new_platform_access")
    .eq("has_new_platform_access", true)
    .neq("is_active", false);
  return ((data ?? []) as { user_id: string; email: string | null; sf_user_name: string | null }[])
    .map((p) => ({ user_id: p.user_id, name: displayName(p.email, p.sf_user_name), email: (p.email ?? "").trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listTeams(): Promise<TeamSummary[]> {
  const sb = commercialDb();
  const { data: teams } = await sb.from("commercial_teams").select("id, name").is("deleted_at", null).order("name");
  const rows = (teams ?? []) as { id: string; name: string }[];
  if (rows.length === 0) return [];
  const ids = rows.map((t) => t.id);
  const { data: members } = await sb
    .from("commercial_team_members")
    .select("team_id, user_id, is_team_admin")
    .in("team_id", ids)
    .is("removed_at", null);
  const mem = (members ?? []) as { team_id: string; user_id: string; is_team_admin: boolean }[];
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
  const { data: members } = await sb
    .from("commercial_team_members")
    .select("id, user_id, role, is_team_admin")
    .eq("team_id", id)
    .is("removed_at", null);
  const mem = (members ?? []) as { id: string; user_id: string; role: AssignmentRole; is_team_admin: boolean }[];
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
  const r: AssignmentRole = isRole(role) ? role : "other";
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

export async function removeTeamMember(memberId: string, actorUserId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { error } = await sb.from("commercial_team_members").update({ removed_at: new Date().toISOString() }).eq("id", memberId);
  if (error) return { ok: false, error: error.message };
  await logDelete("commercial_team_members", memberId, { id: memberId }, actorUserId);
  return { ok: true };
}

/** Assign (or clear, with null) the team on an account or opportunity — the
 *  "add a Team by name" flow. `parent` is 'account' or 'opportunity'. */
export async function setOwnerTeam(
  parent: "account" | "opportunity",
  ownerId: string,
  teamId: string | null,
  actorUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const table = parent === "account" ? "commercial_accounts" : "commercial_opportunities";
  if (teamId) {
    const { data: t } = await sb.from("commercial_teams").select("id").eq("id", teamId).is("deleted_at", null).maybeSingle();
    if (!t) return { ok: false, error: "Team not found." };
  }
  const { error } = await sb.from(table).update({ team_id: teamId }).eq("id", ownerId).is("deleted_at", null);
  if (error) return { ok: false, error: error.message };
  await logUpdate(table, ownerId, {}, { team_id: teamId }, actorUserId);
  return { ok: true };
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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = commercialDb();
  const { data: row } = await sb.from("commercial_team_members").select("team_id, role, is_team_admin").eq("id", memberId).maybeSingle();
  if (!row) return { ok: false, error: "Member not found." };
  const cur = row as { team_id: string; role: AssignmentRole; is_team_admin: boolean };
  const update: { role?: AssignmentRole; is_team_admin?: boolean } = {};
  if (patch.role !== undefined) update.role = isRole(patch.role) ? patch.role : "other";
  if (patch.is_team_admin !== undefined) update.is_team_admin = patch.is_team_admin;
  if (update.is_team_admin === true) {
    // One admin per team — clear the flag on the others first.
    await sb.from("commercial_team_members").update({ is_team_admin: false }).eq("team_id", cur.team_id).is("removed_at", null);
  }
  const { error } = await sb.from("commercial_team_members").update(update).eq("id", memberId);
  if (error) return { ok: false, error: error.message };
  await logUpdate("commercial_team_members", memberId, cur, update, actorUserId);
  return { ok: true };
}
