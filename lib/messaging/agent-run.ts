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
  NURTURE_END_INTENTS, NURTURE_CONTINUE_INTENTS, intentsForTrack,
  type AgentAction, type ValidateContext, type Track,
} from "./agent-output";
import { normalizeInbound, reactionResponse } from "./inbound-normalize";
import { knownCustomerPrompt, knownFields, type KnownCustomer } from "./known-customer";
import { renderMessage } from "./render";

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
export function buildSystemPrompt(cfg: AgentConfigForRun, hardNos: string[], track: Track = "new_lead", known?: KnownCustomer): string {
  const flow = cfg.required_flow.map((f, i) => `${i + 1}. ${f.replace(/_/g, " ")}`).join("\n");

  // Nurture is talking to somebody who has already had an estimator in their
  // home. Everything the new-lead prompt exists to collect, they have already
  // given — so the opening paragraph has to change, not just the tone.
  const opening = track === "nurture"
    ? `You are ${cfg.persona_name}, ${cfg.persona_role} at Precision Painting Plus. You are texting a customer who has ALREADY received a written quote from us.

They are not a lead. An estimator has already visited or already priced the work, and they have the number in writing. Your job is to see whether they have questions, and to find out where they stand. You never quote a price, never re-quote, never discount and never offer an appointment time — the estimator owns the number and the office owns the calendar.

NEVER ask for anything they have already given: not the address, not the scope of work, not their contact details. Asking again is the clearest possible sign that nobody is reading.

WHERE THE CONVERSATION IS TRYING TO GET, in order:
${flow}`
    : `You are ${cfg.persona_name}, ${cfg.persona_role} at Precision Painting Plus. You are texting somebody who asked for a free estimate.

Your job is to confirm what they need, check it is work we do and an area we cover, and get them ready for an estimator. You never quote a price and you never offer an appointment time — the office does both.

COLLECT IN THIS ORDER, and do not reorder or skip:
${flow}`;

  return `${opening}

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
${knownCustomerPrompt(known)}

${track === "new_lead" ? `BEFORE SWITCHING TO A PHONE QUOTE:
Say so first. If the job is small enough, or they want somebody out the same
day, we quote it over the phone instead of visiting — but tell them that is
what is happening and why, and confirm their contact details before you do.
Kate graded two conversations bad for moving to a phone quote with no warning.
` : ""}
${hardNos.length ? `\nNEVER, under any circumstances:\n${hardNos.map((h) => `- ${h}`).join("\n")}` : ""}

You reply by choosing an intent and filling its slots. You never write the
message that is sent. If you are unsure, choose "escalate" — a person picking
it up costs far less than a wrong answer to a customer.`;
}

/**
 * The action, as a TOOL rather than an output format.
 *
 * "Choose what to do next" is literally a tool call, and strict tool use gives
 * the same schema guarantee as structured outputs with no extra dependency —
 * the first cut used output_config with a hand-written json_schema shape and
 * the API returned a 400. A tool definition is a shape both sides already
 * agree on.
 *
 * strict: true requires additionalProperties: false and an explicit required
 * list, so every field the model may return is declared here and nowhere else.
 */
function actionTool(track: Track): Anthropic.Tool {
  return {
  name: "choose_action",
  description:
    "Choose the next action in the conversation. This is the ONLY way to respond — you never write the message that is sent to the customer.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      intent: {
        type: "string",
        // Restricted to the track. A nurture conversation has no ask_address
        // to choose, which is a stronger guarantee than telling it not to.
        enum: [...intentsForTrack(track)],
        description: "What to do next.",
      },
      freeText: {
        type: "string",
        description:
          "Short rapport only, or empty. Never a price, never a specific time, never a commitment.",
      },
      confidence: {
        type: "number",
        description: "0 to 1. Be honest — below the threshold this hands to a person, which is cheap.",
      },
      reasoning: { type: "string", description: "One sentence on why this intent." },
    },
    required: ["intent", "freeText", "confidence", "reasoning"],
    additionalProperties: false,
  },
  };
}

export async function runAgentTurn(
  cfg: AgentConfigForRun,
  history: Turn[],
  inboundRaw: string,
  opts: {
    hardNos?: string[]; mediaCount?: number; lastAskedForInfo?: boolean;
    track?: Track; known?: KnownCustomer; ctx?: ValidateContext;
  } = {}
): Promise<RunResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "No Anthropic API key is configured on this environment." };
  const track: Track = opts.track ?? "new_lead";
  const kf = knownFields(opts.known);

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
      // Choosing one of eighteen intents and a line of rapport is a
      // classification, not a reasoning problem. Adaptive thinking plus a
      // 2000-token ceiling made every simulator turn a multi-second wait for a
      // reply that is two sentences long, and the extra thinking changed the
      // chosen intent in none of the cases that were checked.
      max_tokens: 700,
      system: buildSystemPrompt(cfg, opts.hardNos ?? [], track, opts.known),
      messages: [{ role: "user", content: prompt }],
      tools: [actionTool(track)],
      // One tool, and it must be used. There is no path where the model
      // replies with prose instead of choosing an action.
      tool_choice: { type: "tool", name: "choose_action" },
    });

    const call = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "choose_action"
    );
    if (!call) {
      return { ok: false, error: "The model replied without choosing an action." };
    }
    // tool_use.input is already parsed. Never string-match it — escaping
    // differs between models.
    const parsed: unknown = call.input;

    // The post-filter. Even with a constrained schema, freeText is free text.
    const v = validateAction(parsed, {
      confidenceThreshold: cfg.confidence_threshold,
      hardNoPhrases: opts.hardNos,
      track,
      knownFields: {
        name: !!kf.name, phone: !!kf.phone, email: !!kf.email,
        address: !!kf.address, inquiryScope: !!kf.inquiryScope,
      },
      ...opts.ctx,
    });
    if (!v.ok) return { ok: false, error: "The reply was rejected before sending.", rejected: `${v.reason}: ${v.detail}` };

    return {
      ok: true,
      action: v.action,
      escalate: shouldEscalate(v.action, { confidenceThreshold: cfg.confidence_threshold }),
      // Rendered from the intent, NOT from the model's prose. This is the line
      // that used to read `v.action.freeText ?? ""`, which is why a correctly
      // chosen ask_project_details went out as "Hi there!".
      rendered: renderMessage({
        intent: v.action.intent,
        freeText: v.action.freeText,
        turn: history.length,
        photos: opts.mediaCount ?? 0,
        known: { address: kf.address, phone: kf.phone, email: kf.email, scope: kf.inquiryScope },
      }),
    };
  } catch (err) {
    // Typed first, so a rate limit reads differently from a bad request.
    // Carry the API's own message through. The first version reported only
    // "Anthropic API error 400", which is unactionable — the 400 that shipped
    // took a round trip to diagnose because the reason had been discarded.
    if (err instanceof Anthropic.RateLimitError) return { ok: false, error: "Rate limited — try again shortly." };
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, error: "The Anthropic API key was rejected." };
    if (err instanceof Anthropic.APIError) return { ok: false, error: `Anthropic API error ${err.status}: ${err.message}` };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
