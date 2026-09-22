import { messagingDb } from "./db";
import { resolveAgentConfig, stateOfWorkspace, type AgentConfigLayer } from "./agent-resolve";
import type { AgentConfigForRun } from "./agent-run";
import type { Track } from "./agent-output";

/**
 * Resolve the config the way a live conversation does — global, then state,
 * then workspace.
 *
 * Lifted out of the simulator so the sandbox and the real scheduler resolve
 * IDENTICALLY. That was already the claim ("if Kate tests as a New York
 * workspace she is testing the New York prompt") and it was only true of the
 * sandbox, because the live path had no agent turn at all. The moment it got
 * one, a second copy of this would have made the two quietly disagree — which
 * is the third time this session that two implementations of one idea were
 * about to drift.
 */
export async function agentConfigFor(
  workspaceId?: string,
  track: Track = "new_lead"
): Promise<{
  cfg: AgentConfigForRun;
  hardNos: string[];
  /** The caller's leash on the model — see below. Null means no cap is set. */
  maxTurns: number | null;
} | null> {
  const sb = messagingDb();
  const [{ data: rows }, { data: ws }] = await Promise.all([
    sb.from("sms_agent_configs").select("*"),
    workspaceId ? sb.from("sms_sub_accounts").select("name").eq("id", workspaceId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!rows?.length) return null;

  const state = ws?.name ? stateOfWorkspace(ws.name) : null;
  const layers = (rows as AgentConfigLayer[]).filter((r) =>
    // Track first. A nurture conversation resolving the new-lead global row
    // would inherit the collect-the-address flow, which is the exact mistake
    // this track exists to prevent.
    (r.track ?? "new_lead") === track
    && (r.scope === "global"
    || (r.scope === "state" && state !== null && r.state_code === state)
    || (r.scope === "workspace" && workspaceId && r.workspace_id === workspaceId))
  );
  const { value } = resolveAgentConfig(layers);

  const { data: nos } = await sb.from("sms_hard_nos")
    .select("rule, state_code").eq("is_active", true);
  const hardNos = (nos ?? [])
    .filter((n) => !n.state_code || n.state_code === state)
    .map((n) => n.rule);

  return {
    cfg: {
      persona_name: value.persona_name ?? "Emily",
      persona_role: value.persona_role ?? "the team's assistant",
      required_flow: value.required_flow ?? ["project_details", "full_address", "contact_information", "appointment_availability"],
      services_included: value.services_included ?? null,
      services_excluded: value.services_excluded ?? null,
      offsite_rules: value.offsite_rules ?? null,
      tone_rules: value.tone_rules ?? null,
      office_location: value.office_location ?? null,
      service_area_note: value.service_area_note ?? null,
      confidence_threshold: Number(value.confidence_threshold ?? 0.95),
    },
    hardNos,
    /**
     * How many replies the bot may send before a person takes over.
     *
     * Resolved here at last. max_turns has been validated on save, stored,
     * resolved through the config layers and displayed on the Agent page under
     * the words "Longer than this hands to a human rather than looping" — and
     * read by nothing. There was no conversation-length cap anywhere in the
     * system, and therefore no ceiling on tokens or cost either.
     *
     * Kept OUT of cfg on purpose: cfg is what reaches the model, and the model
     * has no business knowing how long its own leash is. This is the caller's
     * rule about the model, not an instruction to it.
     */
    maxTurns: value.max_turns == null ? null : Number(value.max_turns),
  };
}
