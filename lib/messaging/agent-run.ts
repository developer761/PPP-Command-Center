/**
 * Ask Claude what to do next.
 *
 * The model returns a structured ACTION, never a message. It picks an intent
 * and fills slots; the message is rendered from that. It can be wrong about
 * what to do — the confidence gate catches it and a person corrects it — but
 * it cannot promise a price or invent an appointment, because there is no
 * field in which to say so.
 *
 * Follows the pattern already in lib/commercial/reports/receivables-brief.ts:
 * an availability check, a graceful failure rather than a throw, and no key
 * means no call.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  validateAction, shouldEscalate, END_INTENTS, CONTINUE_INTENTS,
  type AgentAction, type ValidateContext,
} from "./agent-output";
import { normalizeInbound, reactionResponse } from "./inbound-normalize";

const MODEL = "claude-opus-5";

export function agentAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export type AgentConfigForRun = {
  persona_name: string;
  persona_role: string;
  required_flow: string[];
  services_included: string | null;
  services_excluded: string | null;
  offsite_rules: string | null;
  tone_rules: string | null;
  office_location: string | null;
  service_area_note: string | null;
  confidence_threshold: number;
};

export type Turn = { role: "customer" | "assistant"; text: string };

export type RunResult =
  | { ok: true; action: AgentAction; escalate: boolean; rendered: string }
  | { ok: false; error: string; rejected?: string };

/**
 * The system prompt, built from config rather than hard-coded.
 *
 * Everything here comes from sms_agent_configs, which is what makes the state
 * tier meaningful: change the office location for New York and this prompt
 * changes for every New York workspace without an edit.
 */
export function buildSystemPrompt(cfg: AgentConfigForRun, hardNos: string[]): string {
  const flow = cfg.required_flow.map((f, i) => `${i + 1}. ${f.replace(/_/g, " ")}`).join("\n");
  return `You are ${cfg.persona_name}, ${cfg.persona_role} at Precision Painting Plus. You are texting somebody who asked for a free estimate.

Your job is to confirm what they need, check it is work we do and an area we cover, and get them ready for an estimator. You never quote a price and you never offer an appointment time — the office does both.

COLLECT IN THIS ORDER, and do not reorder or skip:
${flow}

WHAT WE DO:
${cfg.services_included ?? "Interior and exterior painting."}

WHAT WE DO NOT DO:
${cfg.services_excluded ?? "Anything that is not painting."}

OFF-SITE QUOTES:
${cfg.offsite_rules ?? "Offer one when an in-person visit does not suit."}

HOW YOU SOUND:
${cfg.tone_rules ?? "Friendly, brief, one question at a time."}

${cfg.office_location ? `Our office is in ${cfg.office_location}.` : ""}
${cfg.service_area_note ? `Where we serve: ${cfg.service_area_note}` : ""}
${hardNos.length ? `\nNEVER, under any circumstances:\n${hardNos.map((h) => `- ${h}`).join("\n")}` : ""}

You reply by choosing an intent and filling its slots. You never write the
message that is sent. If you are unsure, choose "escalate" — a person picking
it up costs far less than a wrong answer to a customer.`;
}

const ACTION_SCHEMA = {
  type: "object" as const,
  properties: {
    intent: { type: "string", enum: [...END_INTENTS, ...CONTINUE_INTENTS] },
    freeText: { type: "string", description: "Optional short rapport only. Never a price, a time, or a commitment." },
    slots: { type: "object", additionalProperties: true },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reasoning: { type: "string", description: "One sentence on why this intent." },
  },
  required: ["intent", "confidence"],
  additionalProperties: false,
};

export async function runAgentTurn(
  cfg: AgentConfigForRun,
  history: Turn[],
  inboundRaw: string,
  opts: { hardNos?: string[]; mediaCount?: number; lastAskedForInfo?: boolean; ctx?: ValidateContext } = {}
): Promise<RunResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "No Anthropic API key is configured on this environment." };

  // Reactions, emoji and photos become words before the model sees them.
  // Hatch cannot read any of these, which is why a thumbs-up derails it.
  const inbound = normalizeInbound(inboundRaw, opts.mediaCount ?? 0);
  const reaction = reactionResponse(inbound, opts.lastAskedForInfo ?? false);

  const transcript = history
    .map((t) => `${t.role === "customer" ? "Customer" : cfg.persona_name}: ${t.text}`)
    .join("\n");

  const prompt = `${transcript ? `Conversation so far:\n${transcript}\n\n` : ""}The customer has just sent:
${inbound.description}
${reaction.guidance ? `\nHow to treat that: ${reaction.guidance}` : ""}

Choose the next action.`;

  try {
    const client = new Anthropic({ apiKey });
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      system: buildSystemPrompt(cfg, opts.hardNos ?? []),
      messages: [{ role: "user", content: prompt }],
      output_config: { format: { type: "json_schema", schema: ACTION_SCHEMA } },
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "The model did not return usable JSON." };
    }

    // The post-filter. Even with a constrained schema, freeText is free text.
    const v = validateAction(parsed, {
      confidenceThreshold: cfg.confidence_threshold,
      hardNoPhrases: opts.hardNos,
      ...opts.ctx,
    });
    if (!v.ok) return { ok: false, error: "The reply was rejected before sending.", rejected: `${v.reason}: ${v.detail}` };

    return {
      ok: true,
      action: v.action,
      escalate: shouldEscalate(v.action, { confidenceThreshold: cfg.confidence_threshold }),
      rendered: v.action.freeText ?? "",
    };
  } catch (err) {
    // Typed first, so a rate limit reads differently from a bad request.
    if (err instanceof Anthropic.RateLimitError) return { ok: false, error: "Rate limited — try again shortly." };
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: "The Anthropic API key was rejected." };
    if (err instanceof Anthropic.APIError) return { ok: false, error: `Anthropic API error ${err.status}.` };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
