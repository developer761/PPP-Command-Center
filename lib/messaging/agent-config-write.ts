"use server";

/**
 * Editing the agent's rules.
 *
 * Karan, 2026-09-08: "is there any way we can edit them whenever we want and
 * the bot changes its information and rules instantly?"
 *
 * Yes, and instantly is literal: the config is read from the database on every
 * turn, so a save changes the next message. There is no deploy, no cache and
 * no restart between Kate editing a rule and the bot following it.
 *
 * WHAT IS DELIBERATELY NOT EDITABLE HERE:
 *
 *   Quiet hours, the opt-out list and the per-customer daily cap. Those live
 *   in the send gate. An agent must not be able to configure its way into a
 *   message somebody told us not to receive, so there is no field for them —
 *   changing those is a code change with a test behind it.
 *
 *   autosend. Switching a workspace from draft-review to sending on its own is
 *   the single highest-consequence toggle in the system, and it is earned per
 *   workspace after a clean run rather than typed into a form. It stays out of
 *   this editor on purpose.
 *
 * INHERIT vs BLANK. The resolver treats NULL as "inherit from the tier above"
 * and an empty string as "deliberately blank". A cleared field here saves NULL,
 * because that is what somebody clearing a box means every time: go back to
 * what the level above says.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";

/** Only these columns. Anything not listed cannot be written by this path. */
const EDITABLE = [
  "persona_name", "persona_role", "office_location", "service_area_note",
  "services_included", "services_excluded", "offsite_rules", "tone_rules",
] as const;

type EditableField = (typeof EDITABLE)[number];

export type AgentConfigEdit = Partial<Record<EditableField, string>> & {
  confidence_threshold?: number;
  max_turns?: number;
};

export type SaveScope =
  | { scope: "global" }
  | { scope: "state"; stateCode: string }
  | { scope: "workspace"; workspaceId: string };

export async function saveAgentConfig(input: {
  where: SaveScope;
  track: "new_lead" | "nurture";
  values: AgentConfigEdit;
}): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  await assertMessagingAccess();
  const { where, track, values } = input;

  const patch: Record<string, unknown> = {};
  for (const f of EDITABLE) {
    if (!(f in values)) continue;
    const raw = values[f];
    const trimmed = (raw ?? "").trim();
    // Cleared means inherit, not blank. See the note at the top.
    patch[f] = trimmed === "" ? null : trimmed;
  }

  if (values.confidence_threshold !== undefined) {
    const c = Number(values.confidence_threshold);
    if (!Number.isFinite(c) || c < 0 || c > 1) {
      return { ok: false, error: "Confidence threshold must be between 0 and 1." };
    }
    patch.confidence_threshold = c;
  }
  if (values.max_turns !== undefined) {
    const m = Number(values.max_turns);
    if (!Number.isInteger(m) || m < 1 || m > 100) {
      return { ok: false, error: "Max turns must be a whole number between 1 and 100." };
    }
    patch.max_turns = m;
  }

  // The global row is the floor. Everything below it may inherit, so it is the
  // one tier that must always be able to answer.
  if (where.scope === "global" && patch.persona_name === null) {
    return { ok: false, error: "The default needs a name — every other level can inherit it, so this one cannot be blank." };
  }

  if (!Object.keys(patch).length) return { ok: false, error: "Nothing to save." };

  const sb = messagingDb();
  const keys = {
    scope: where.scope,
    track,
    state_code: where.scope === "state" ? where.stateCode : null,
    workspace_id: where.scope === "workspace" ? where.workspaceId : null,
  };

  let q = sb.from("sms_agent_configs").select("id").eq("scope", keys.scope).eq("track", track);
  q = keys.state_code ? q.eq("state_code", keys.state_code) : q.is("state_code", null);
  q = keys.workspace_id ? q.eq("workspace_id", keys.workspace_id) : q.is("workspace_id", null);
  const { data: existing } = await q.maybeSingle();

  if (existing) {
    const { error } = await sb.from("sms_agent_configs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, created: false };
  }

  // No row at this tier yet — this is a workspace being given rules of its own
  // for the first time, which is the whole point of the tier.
  const { error } = await sb.from("sms_agent_configs").insert({ ...keys, ...patch });
  if (error) return { ok: false, error: error.message };
  return { ok: true, created: true };
}

/**
 * Remove a tier's own rules so it goes back to inheriting completely.
 *
 * Only ever offered for state and workspace. Deleting the global row would
 * leave nothing to inherit FROM, and the bot would answer with defaults nobody
 * chose.
 */
export async function clearAgentConfig(input: {
  where: Exclude<SaveScope, { scope: "global" }>;
  track: "new_lead" | "nurture";
}): Promise<{ ok: true } | { ok: false; error: string }> {
  await assertMessagingAccess();
  const sb = messagingDb();
  let q = sb.from("sms_agent_configs").delete()
    .eq("scope", input.where.scope).eq("track", input.track);
  q = input.where.scope === "state"
    ? q.eq("state_code", input.where.stateCode)
    : q.eq("workspace_id", input.where.workspaceId);
  const { error } = await q;
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
