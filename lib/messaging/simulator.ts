"use server";

/**
 * The sandbox.
 *
 * Kate plays a customer, the real agent logic answers, she grades it.
 *
 * SAFETY: this file never imports the transport and never calls the gate. Not
 * a disabled send path — no send path. The simulator has no phone number, no
 * conversation row and no scheduled action; it calls the model and returns
 * what it said. There is nothing here that could reach a person even if every
 * other guard were removed.
 */
import { messagingDb } from "./db";
import { runAgentTurn, agentAvailable, type AgentConfigForRun, type Turn } from "./agent-run";
import { resolveAgentConfig, stateOfWorkspace, type AgentConfigLayer } from "./agent-resolve";

export type SimTurn = {
  ordinal: number;
  customerText: string;
  intent: string | null;
  confidence: number | null;
  message: string;
  escalate: boolean;
  error?: string;
  rejected?: string;
};

export type SimResult =
  | { ok: true; turn: SimTurn }
  | { ok: false; error: string };

/**
 * Resolve the config the way a live conversation would — global, then state,
 * then workspace. Using the same resolver is the point: if Kate tests as a New
 * York workspace, she is testing the New York prompt, Garden City and all.
 */
async function configFor(workspaceId?: string): Promise<{ cfg: AgentConfigForRun; hardNos: string[] } | null> {
  const sb = messagingDb();
  const [{ data: rows }, { data: ws }] = await Promise.all([
    sb.from("sms_agent_configs").select("*"),
    workspaceId ? sb.from("sms_sub_accounts").select("name").eq("id", workspaceId).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (!rows?.length) return null;

  const state = ws?.name ? stateOfWorkspace(ws.name) : null;
  const layers = (rows as AgentConfigLayer[]).filter((r) =>
    r.scope === "global"
    || (r.scope === "state" && state !== null && r.state_code === state)
    || (r.scope === "workspace" && workspaceId && r.workspace_id === workspaceId)
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
  };
}

/** Whether the simulator can run at all, and why not if it cannot. */
export async function simulatorStatus(): Promise<{ ready: boolean; reason?: string }> {
  if (!agentAvailable()) {
    return { ready: false, reason: "No Anthropic API key is set on this environment, so the bot cannot be asked anything." };
  }
  const cfg = await configFor();
  if (!cfg) return { ready: false, reason: "No agent configuration has been seeded yet — run migration 185." };
  return { ready: true };
}

export async function runSimTurn(input: {
  workspaceId?: string;
  history: Turn[];
  customerText: string;
  /** The last thing the bot said asked the customer to PROVIDE something.
   *  Decides whether a reaction counts as an answer. */
  lastAskedForInfo?: boolean;
}): Promise<SimResult> {
  const resolved = await configFor(input.workspaceId);
  if (!resolved) return { ok: false, error: "No agent configuration found." };

  const res = await runAgentTurn(resolved.cfg, input.history, input.customerText, {
    hardNos: resolved.hardNos,
    lastAskedForInfo: input.lastAskedForInfo,
  });

  if (!res.ok) {
    return {
      ok: true,
      turn: {
        ordinal: input.history.length + 1,
        customerText: input.customerText,
        intent: null, confidence: null, message: "", escalate: true,
        error: res.error, rejected: res.rejected,
      },
    };
  }

  return {
    ok: true,
    turn: {
      ordinal: input.history.length + 1,
      customerText: input.customerText,
      intent: res.action.intent,
      confidence: res.action.confidence,
      message: res.rendered,
      escalate: res.escalate,
    },
  };
}

/** Persist a graded run so it can be replayed after a prompt change. */
export async function saveScenario(input: {
  name: string;
  customerBrief: string;
  tagKey?: string;
  workspaceId?: string;
  turns: (SimTurn & { verdict?: "good" | "acceptable" | "wrong"; verdictNote?: string; expectedIntent?: string })[];
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const sb = messagingDb();
  const { data: scenario, error } = await sb.from("sms_scenarios").insert({
    name: input.name,
    customer_brief: input.customerBrief,
    tag_key: input.tagKey ?? null,
    workspace_id: input.workspaceId ?? null,
    // Only a run where every turn was judged acceptable becomes a test. A
    // scenario with a known-wrong turn is a bug report, not a baseline.
    is_regression_test: input.turns.length > 0 && input.turns.every((t) => t.verdict === "good" || t.verdict === "acceptable"),
  }).select().single();
  if (error) return { ok: false, error: error.message };

  const rows = input.turns.map((t) => ({
    scenario_id: scenario.id,
    ordinal: t.ordinal,
    customer_text: t.customerText,
    bot_intent: t.intent,
    bot_message: t.message,
    confidence: t.confidence,
    verdict: t.verdict ?? null,
    verdict_note: t.verdictNote ?? null,
    expected_intent: t.expectedIntent ?? null,
    graded_at: t.verdict ? new Date().toISOString() : null,
  }));
  const { error: turnErr } = await sb.from("sms_scenario_turns").insert(rows);
  if (turnErr) return { ok: false, error: turnErr.message };

  return { ok: true, id: scenario.id };
}
