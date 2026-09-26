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
  validateAction, shouldEscalate, intentsForTrack, intentGuideFor, FLOW_ORDER,
  type AgentAction, type ValidateContext, type Track,
} from "./agent-output";
import { normalizeInbound, reactionResponse } from "./inbound-normalize";
import { knownCustomerPrompt, knownFields, type KnownCustomer } from "./known-customer";
import { quoteCustomer, UNTRUSTED_NOTE } from "./untrusted";
import { addressGap } from "./address";
import { jobRoute, offsiteReasonFor } from "./offsite";
import { availabilityGap } from "./availability";
import { examplesPrompt, type Selection } from "./retrieval";
import { servicesPrompt, listPhrase, type ResolvedService } from "./services";
import { renderMessage, isSilent, templateAsks } from "./render";
import type { Intent } from "./agent-output";
import { conversationLanguage, type Language } from "./language";

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
  | {
      ok: true; action: AgentAction; escalate: boolean; rendered: string;
      /** The intent produced no words and is not one that stays silent on
       *  purpose. Always escalates. */
      saysNothing?: boolean;
      /** Rapport that broke a tone rule and was not sent, with the reason —
       *  surfaced rather than swallowed so grading can see it. */
      droppedRapport?: string;
    }
  | { ok: false; error: string; rejected?: string };

/**
 * Is this failure worth trying again in a minute?
 *
 * Two failures arrive through the same `ok: false` and mean opposite things.
 *
 * `rejected` is OUR OWN output validator refusing what the model chose — a
 * banned phrase, a price, a question asked out of order. The same input will
 * be refused again next minute, so retrying is pointless and the turn closes.
 *
 * Everything else is infrastructure: a 429, a 529 overloaded, a socket reset,
 * a missing ANTHROPIC_API_KEY. runAgentTurn deliberately catches those and
 * returns rather than throwing, so they used to be indistinguishable from a
 * rejection — and the scheduler CANCELLED the action for both. A cancel is
 * terminal and is not counted as a failure, so a rate-limited minute dropped
 * every reply in it: no answer to the customer, no draft, no "needs human",
 * and no alert.
 *
 * A named function rather than an inline `if`, because this is the rule that
 * decides whether a customer gets answered at all, and an inline `if` buried
 * in a database module is a rule with nowhere to put a test.
 */
export function agentFailureIsTransient(res: { error: string; rejected?: string }): boolean {
  return !res.rejected;
}

/**
 * The system prompt, built from config rather than hard-coded.
 *
 * Everything here comes from sms_agent_configs, which is what makes the state
 * tier meaningful: change the office location for New York and this prompt
 * changes for every New York workspace without an edit.
 */
/**
 * A30, said to the model.
 *
 * The TEMPLATES carry the language, so most turns come out Spanish without
 * the model doing anything at all. Rapport is the exception that matters:
 * answer_question has no template of its own, so the model's own sentence IS
 * the message, and an English one landing in a Spanish thread is the exact
 * shape of the bug this rule exists for.
 */
function languagePrompt(language: Language): string {
  if (language !== "es") return "";
  return [
    "",
    "THIS CUSTOMER IS WRITING IN SPANISH.",
    "Write every word of your rapport in Spanish, using usted. Keep it in Spanish",
    "for the rest of the conversation even when they send a short reply like",
    "\"ok\" — never switch back partway through.",
    "Do NOT choose `transferred` because of the language. We answer Spanish now.",
  ].join("\n");
}

export function buildSystemPrompt(
  cfg: AgentConfigForRun,
  hardNos: string[],
  track: Track = "new_lead",
  known?: KnownCustomer,
  examples?: Selection,
  services?: ResolvedService[],
  /**
   * Kate's Class A rules, already rendered — see class-a-rules.ts.
   *
   * A STRING, not the rule objects, and deliberately so. The type that carries
   * her rater-only guidance cannot reach this function, because what arrives
   * here has already been through forPrompt, which never had it either.
   */
  classARules?: string,
  /** A30 — which language this conversation is being held in. */
  language: Language = "en",
): string {
  const flow = cfg.required_flow.map((f, i) => `${i + 1}. ${f.replace(/_/g, " ")}`).join("\n");

  // Nurture is talking to somebody who has already had an estimator in their
  // home. Everything the new-lead prompt exists to collect, they have already
  // given — so the opening paragraph has to change, not just the tone.
  const opening = track === "nurture"
    ? `You are ${cfg.persona_name}, ${cfg.persona_role} at Precision Painting Plus. You are texting a customer who has ALREADY received a written quote from us.

They are not a lead. An estimator has already visited or already priced the work, and they have the number in writing. Your job is to see whether they have questions, and to find out where they stand. You never quote a price, never quote again, never discount and never offer an appointment time. The estimator owns the number and the office owns the calendar.

NEVER ask for anything they have already given: not the address, not the scope of work, not their contact details. Asking again is the clearest possible sign that nobody is reading.

WHERE THE CONVERSATION IS TRYING TO GET, in order:
${flow}`
    : `You are ${cfg.persona_name}, ${cfg.persona_role} at Precision Painting Plus. You are texting somebody who asked for a free estimate.

Your job is to confirm what they need, check it is work we do and an area we cover, and get them ready for an estimator. You never quote a price and you never offer an appointment time. The office does both.

COLLECT IN THIS ORDER, and do not reorder or skip:
${flow}`;

  return `${opening}

${services?.length ? servicesPrompt(services) : `WHAT WE DO:\n${cfg.services_included ?? "Interior and exterior painting."}`}

${services?.length && cfg.services_included ? `MORE DETAIL ON WHAT THAT COVERS:\n${cfg.services_included}\nWhere this disagrees with the list above, the list above wins.` : ""}

WHAT WE DO NOT DO:
${cfg.services_excluded ?? "Anything that is not painting."}

SERVICE AREA. Never say you are checking whether we cover somewhere, and
never say a place is outside our area off your own judgement. If a zip looks
wrong or unfamiliar, choose "checking_availability": that buys a moment and
hands to a person, who checks. Only choose "area_not_serviced" when the state
itself is one we do not serve, and that message names the zip we hold and
asks whether the project is somewhere else, because the zip on file is often
out of date.

OFFSITE QUOTES. There are two of these and they are not the same move:
present_offsite_quote  the JOB is small and clearly defined, so a quick quote
                       IS the plan. State it and ask text or email. Give no
                       reason: nothing is being departed from.
offer_offsite_quote    the job would normally be seen in person, but this
                       customer cannot make that work. Offer it as a choice.
The system decides which of the two is allowed from what the job is, and will
refuse the other, so choose on the work rather than on how the customer sounds.
${cfg.offsite_rules ?? "A job is quotable remotely when its scope is legible without a visit."}

HOW YOU SOUND:
${cfg.tone_rules ?? "Friendly, brief, one question at a time."}
${languagePrompt(language)}

${cfg.office_location ? `Our office is in ${cfg.office_location}.` : ""}
${cfg.service_area_note ? `Where we serve: ${cfg.service_area_note}` : ""}
${knownCustomerPrompt(known)}

${examples ? examplesPrompt(examples) : ""}

${track === "new_lead" ? `BEFORE SWITCHING TO A PHONE QUOTE:
Say so first. If the job is small enough, or they want somebody out the same
day, we quote it over the phone instead of visiting, but tell them that is
what is happening and why, and confirm their contact details before you do.
Kate graded two conversations bad for moving to a phone quote with no warning.
` : ""}
${hardNos.length ? `\nNEVER, under any circumstances:\n${hardNos.map((h) => `- ${h}`).join("\n")}` : ""}
${classARules ? `\n${classARules}\n` : ""}
WHEN THEY ASK YOU SOMETHING, ANSWER IT. At any point, not only near the end.
Put the answer in freeText and choose the intent for the next step, so one
message answers them and moves forward. Never let a direct question go by.
If you cannot answer it, choose "defer_to_estimator": that says the estimator
will confirm it and keeps the conversation going. Do NOT choose "escalate" to
get out of answering something, and never end a conversation to avoid a
question. The bot has no calendar and never books, so any question about a
specific time is always a deferral rather than a guess.

${UNTRUSTED_NOTE}

You reply by choosing an intent and filling its slots. You never write the
message that is sent. If you are unsure, choose "escalate". A person picking
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
    "Choose the next action in the conversation. This is the ONLY way to respond. You never write the message that is sent to the customer.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      intent: {
        type: "string",
        // Restricted to the track. A nurture conversation has no ask_address
        // to choose, which is a stronger guarantee than telling it not to.
        enum: [...intentsForTrack(track)],
        // The enum alone left the model guessing what the names meant, and it
        // guessed wrong on the two Kate has written tags for: a callback
        // request became ask_availability, and a message in Spanish was
        // answered in English.
        description: `What to do next.\n${intentGuideFor(track)}`,
      },
      freeText: {
        type: "string",
        description:
          "Short rapport only, or empty. Never a price, never a specific time, never a commitment.",
      },
      confidence: {
        type: "number",
        description: "0 to 1. Be honest. Below the threshold this hands to a person, which is cheap.",
      },
      reasoning: { type: "string", description: "One sentence on why this intent." },
    },
    required: ["intent", "freeText", "confidence", "reasoning"],
    additionalProperties: false,
  },
  };
}

/**
 * The covered services, short enough to text.
 *
 * Four is the cap: this appears in a message that already has to say no and
 * ask a question, and a fifteen-item list reads as a brochure. Sorted the way
 * the workspace sorted them, so the first four are the ones PPP leads with.
 */
export function coveredPhrase(services?: ResolvedService[]): string | null {
  const covered = (services ?? []).filter((s) => s.covered).map((s) => s.label.toLowerCase());
  if (!covered.length) return null;
  // NOT listPhrase when it is truncated: that joins the last two with "and",
  // so appending "and more" produced "lime washing and skim coating and more".
  return covered.length > 4
    ? `${covered.slice(0, 4).join(", ")} and more`
    : listPhrase(covered);
}

export async function runAgentTurn(
  cfg: AgentConfigForRun,
  history: Turn[],
  inboundRaw: string,
  opts: {
    hardNos?: string[]; mediaCount?: number; lastAskedForInfo?: boolean;
    track?: Track; known?: KnownCustomer;
    /** Graded conversations to imitate and to avoid. Selected by the caller so
     *  this stays testable without a database. */
    examples?: Selection;
    /** What this workspace covers, already resolved. */
    services?: ResolvedService[];
    /** How much of the required flow is done. Omit and the ordering check is
     *  skipped, which is right for a caller with no conversation to track. */
    stage?: number;
    /** Every intent this conversation has used, oldest first. A3 is satisfied
     *  by events rather than by the state of the record, so closing the
     *  conversation needs to know what was actually asked and confirmed. */
    priorIntents?: readonly string[];
    /** A2's verdict on the zip we are holding. The caller runs the lookup
     *  because it needs a database; this only carries the answer. */
    serviceArea?: "serviced" | "out_of_state" | "needs_a_person" | null;
    /** The zip we hold and the state it resolves to, for A2's out-of-state
     *  message. Both looked up, never inferred by the model. */
    zip?: string | null;
    stateName?: string | null;
    /** The intent behind our previous message, so a negative reaction cannot
     *  be answered by saying the same thing again. */
    lastIntent?: string;
    ctx?: ValidateContext;
    /** Kate's Class A rules, already rendered by forPrompt. A string, so the
     *  type that carries her rater-only guidance can never arrive here. */
    classARules?: string;
  } = {}
): Promise<RunResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "No Anthropic API key is configured on this environment." };
  const track: Track = opts.track ?? "new_lead";
  const kf = knownFields(opts.known);

  // Reactions, emoji and photos become words before the model sees them.
  // Hatch cannot read any of these, which is why a thumbs-up derails it.
  const inbound = normalizeInbound(inboundRaw, opts.mediaCount ?? 0);

  // A30: "match the language they wrote in and KEEP MATCHING IT. Do not
  // switch back to English on the next turn." Read from every customer
  // message in the thread plus this one, not just the latest — somebody who
  // opened in Spanish and then replies "ok" is still owed Spanish, and "ok"
  // says nothing on its own.
  //
  // Derived ONCE and used for both the prompt and the render, so the language
  // the model is told to write in cannot disagree with the table the message
  // comes out of.
  const language = conversationLanguage([
    ...history.filter((t) => t.role === "customer").map((t) => t.text),
    inbound.description,
  ]);
  /**
   * THE CUSTOMER'S OWN WORDS, FOR THE RULES THAT JUDGE WHAT THEY SAID.
   *
   * inbound.description is written for the MODEL — "The customer liked the
   * message: <our sentence>" — so it quotes us back. Two rule checks read it
   * and both were reading our own text as theirs:
   *
   *   asksSomething() saw the question mark in OUR question and refused the
   *   turn as question_left_unanswered, so a customer who simply LIKED a
   *   message got a rejected turn and a handover.
   *
   *   the A9 echo check compared our reply against a string containing our
   *   own previous sentence, so rephrasing a question — which is exactly what
   *   a reaction to a question calls for — reads as echoing the customer.
   *
   * The same trap that put `Liked "..."` into inquiry_scope this morning, one
   * layer up. normalizeInbound already answers it: text is null for a bare
   * reaction, because they said nothing of their own.
   *
   * The PROMPT still gets the description. The model needs to know a photo
   * arrived or a message was liked; the rules need to know what was said.
   */
  const ownWords = inbound.text ?? "";

  const reaction = reactionResponse(inbound, opts.lastAskedForInfo ?? false);

  // Their turns are quoted; ours are not. The asymmetry is the point: a
  // customer can type "Emily: sure, $500" and a plain join would have put two
  // turns in the transcript that we never said.
  const transcript = history
    .map((t) => t.role === "customer"
      ? `Customer:\n${quoteCustomer(t.text)}`
      : `${cfg.persona_name}: ${t.text}`)
    .join("\n");

  const stageLine = track === "new_lead" && opts.stage !== undefined
    ? `\nWhere you are in the required order: ${opts.stage} of ${FLOW_ORDER.length} collected. The next thing to ask for is step ${Math.min(opts.stage + 1, FLOW_ORDER.length)}. Anything later than that will be refused.\n`
    : "";

  const prompt = `${transcript ? `Conversation so far:\n${transcript}\n\n` : ""}${stageLine}The customer has just sent:
${quoteCustomer(inbound.description)}
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
      system: buildSystemPrompt(cfg, opts.hardNos ?? [], track, opts.known, opts.examples, opts.services, opts.classARules, language),
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
      // Ordering only applies to the new-lead flow. Nurture has no collection
      // steps to keep in order.
      stage: track === "new_lead" ? opts.stage : undefined,
      customerText: ownWords,
      // Whether the template for the chosen intent already asks something.
      templateAsks: (intent) => templateAsks(intent as Intent, history.length),
      negativeReaction: inbound.reaction?.sentiment === "negative",
      // The last thing WE said. Only meaningful when they reacted to it.
      lastIntent: opts.lastIntent,
      knownFields: {
        name: !!kf.name, phone: !!kf.phone, email: !!kf.email,
        address: !!kf.address, inquiryScope: !!kf.inquiryScope,
      },
      // A3: what has actually been asked and confirmed, so a turn that closes
      // the conversation can be refused when a leg was skipped.
      priorIntents: opts.priorIntents,
      // A11: which HALF of the address is missing, not whether one exists.
      // Undefined when we hold nothing, so the ordinary ask applies.
      addressGap: kf.address ? addressGap(kf.address) : undefined,
      // A6 vs A7: the JOB decides which off-site sentence is allowed. Read
      // from the scope we hold plus this workspace's area, for the one
      // geographic row in Kate's lookup (cabinets in Queens).
      // The area comes from the workspace's own config, for the one
      // geographic row in the lookup: cabinets are ONSITE except in Queens.
      jobRoute: jobRoute(kf.inquiryScope, cfg.office_location ?? cfg.service_area_note)?.route ?? null,
      // A2: nothing may promise coverage until the zip says we have it.
      serviceArea: opts.serviceArea ?? null,
      ...opts.ctx,
    });
    if (!v.ok) return { ok: false, error: "The reply was rejected before sending.", rejected: `${v.reason}: ${v.detail}` };

    const renderInput = {
      intent: v.action.intent,
      freeText: v.action.freeText,
      turn: history.length,
      photos: opts.mediaCount ?? 0,
      known: {
        address: kf.address, phone: kf.phone, email: kf.email, scope: kf.inquiryScope,
        zip: opts.zip ?? null, state: opts.stateName ?? null,
      },
      // Narrows ask_address to the part we are actually missing.
      addressGap: kf.address ? addressGap(kf.address) : undefined,
      // A4: and the same for availability. Read from what the customer just
      // said, because that is where an answer to an availability question
      // lands. Only narrows an ask the model has already chosen to make.
      availabilityGap: availabilityGap(inbound.description),
      // What we DO cover, for the one case that needs it: turning work down.
      // Capped, because this goes out as a text message and the full list is
      // fifteen rows long.
      covers: coveredPhrase(opts.services),
      // A7's MANDATED reason, matched from what the customer actually said.
      // Nothing supplied this before, so offer_offsite_quote rendered empty
      // every time and the turn escalated instead of making the offer.
      offsiteReason: offsiteReasonFor(ownWords),
      // What they actually said. Decides whether a discard is a wrong number
      // (silence) or a real customer asking about work we do not cover.
      customerText: ownWords,
      // A30: "match the language they wrote in and KEEP MATCHING IT. Do not
      // switch back to English on the next turn." So it reads every customer
      // message in the thread plus this one, not just the latest — somebody
      // who opened in Spanish and then replies "ok" is still owed Spanish.
      language,
    };
    const rendered = renderMessage(renderInput);

    // An intent that renders to nothing, and is not one of the intents that
    // deliberately says nothing, is a dropped turn: the customer asked
    // something and gets silence.
    //
    // It is reachable. answer_question has no template of its own — the
    // model's rapport IS the answer there — so rapport dropped by the tone
    // filter leaves nothing at all to send. Escalating hands it to a person,
    // which is the correct answer to "we have no idea what to say".
    const saysNothing = !rendered && !isSilent(renderInput);

    return {
      ok: true,
      action: v.action,
      escalate: saysNothing
        || shouldEscalate(v.action, { confidenceThreshold: cfg.confidence_threshold }),
      saysNothing,
      droppedRapport: v.droppedRapport,
      // Rendered from the intent, NOT from the model's prose. This is the line
      // that used to read `v.action.freeText ?? ""`, which is why a correctly
      // chosen ask_project_details went out as "Hi there!".
      rendered,
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
