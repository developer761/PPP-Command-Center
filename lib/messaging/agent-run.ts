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
  isYesNoQuestion, asksSomething,
} from "./agent-output";
import { normalizeInbound, reactionResponse } from "./inbound-normalize";
import { knownCustomerPrompt, knownFields, type KnownCustomer } from "./known-customer";
import { quoteCustomer, UNTRUSTED_NOTE } from "./untrusted";
import { addressGap } from "./address";
import { jobRoute, offsiteReasonFor } from "./offsite";
import { availabilityGap, availabilityGapAcross } from "./availability";
import { statedConstraint } from "./reachability";
import { requestedTime } from "./appointment-time";
import { disclosureMove, applyDisclosure, alreadyDisclosed } from "./disclosure";
import { examplesPrompt, type Selection } from "./retrieval";
import { servicesPrompt, listPhrase, type ResolvedService } from "./services";
import { renderMessage, isSilent, templateAsks } from "./render";
import type { Intent } from "./agent-output";
import { conversationLanguage, type Language } from "./language";
import { addressesInThread, secondPropertyAskDue } from "./multi-property";
import { isAvailabilityStandOff } from "./availability-ask";
import { reportWarn } from "@/lib/observability";
import { stallFollowUpGoal, isFollowUpStep, FOLLOW_UP_COUNT } from "./stall-followup-goals";

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
      /**
       * The first attempt was refused and the SECOND one is what is being
       * sent, with the refusal that produced it. Carried rather than counted
       * internally so the rate is visible: a retry rescuing most turns means
       * the rules are fine and the model needs the feedback, and a retry
       * rescuing almost none means the instruction itself is wrong.
       */
      retriedAfter?: string;
    }
  | {
      ok: false; error: string; rejected?: string;
      /** Both attempts were refused; this is the FIRST refusal. The one in
       *  `rejected` is the second, which is what the model saw last. */
      retriedAfter?: string;
      /**
       * What the model actually tried, when a rule refused it.
       *
       * A reason alone cannot tell two opposite failures apart — "no answer
       * was written" and "an answer was written and a filter deleted it" both
       * arrive as question_left_unanswered — and they need opposite fixes.
       * Also what a grader needs: you cannot say what the bot should have
       * done instead without seeing what it tried.
       */
      attempted?: { intent: string; freeText: string | null };
    };

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
    /**
     * Kate, 2026-09-28, relaying Mac and Jasmine: "the bot should not use the
     * proper ¿ punctuation... they essentially said using that would be a
     * flag that they're not talking to a spanish speaking individual."
     *
     * The templates no longer contain any, but rapport is the model's own
     * sentence, so the rule has to be said here too or half the message
     * follows it and half does not.
     */
    "Write it the way a person texts, not the way it is printed: no opening",
    "¿ or ¡, ever. A question simply ends in ?. Correct inverted",
    "punctuation reads as a translation rather than a person.",
    /**
     * A21 as Kate reissued it on 2026-09-28: "THIS RULE BINDS IN EVERY
     * LANGUAGE, NOT ONLY ENGLISH... Use informal, casual vocabulary and
     * relaxed grammar in that language, the way a person texting would write
     * it. Correct-but-formal prose reads as a template or a translation,
     * which is the same persona failure that formal English is."
     *
     * Said to the model rather than rewritten into the templates, for the
     * register itself. Which words are casual in Spanish is a native
     * speaker's judgement, and the templates were written by one; guessing at
     * replacements would be the "translation" failure this rule names,
     * arriving by a different route.
     */
    "Same for the words themselves: casual and everyday, the way somebody",
    "texts, not the way a letter is written. Keep usted, which is courtesy",
    "rather than stiffness, but drop the formal furniture around it.",
    "for the rest of the conversation even when they send a short reply like",
    "\"ok\" — never switch back partway through.",
    "Do NOT choose `transferred` because of the language. We answer Spanish now.",
  ].join("\n");
}

export function buildSystemPromptParts(
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
  workspaceFaqs?: string,
  /** A30 — which language this conversation is being held in. */
  language: Language = "en",
  /**
   * A2 — WHAT OUR OWN LOOKUP SAYS, which the model was never told.
   *
   * The paragraph below instructs it to choose `area_not_serviced` "when the
   * state itself is one we do not serve", and then never says which states
   * those are: SERVICED lives in service-zip.ts and stopped at the validator.
   * So the one fact needed to make that choice was computed every turn and
   * shown to nobody.
   *
   * The model did the right thing without it — the same paragraph says never
   * to call a place unserved off its own judgement, so a Texas address got
   * `checking_availability` and a handover. Safe, and the wrong script: A2's
   * out-of-state message names the zip and asks whether the project is
   * somewhere else, and it could essentially never fire. The same shape as
   * A7's offsiteReason, which was computed and never passed, so a live
   * critical rule never once ran.
   *
   * This is our records talking, not the model guessing, which is exactly the
   * distinction the paragraph is trying to enforce.
   */
  areaVerdict?: {
    outcome: "serviced" | "out_of_state" | "needs_a_person";
    zip?: string | null;
    state?: string | null;
  } | null,
): { stable: string; variable: string } {
  const flow = cfg.required_flow.map((f, i) => `${i + 1}. ${f.replace(/_/g, " ")}`).join("\n");

  /**
   * The lookup's answer in words, or nothing at all when there is no zip to
   * look up. Silence is the right default: the paragraph's standing
   * instruction is already "do not decide this yourself".
   */
  const areaLine = (() => {
    if (!areaVerdict) return "";
    const zip = areaVerdict.zip ? ` (${areaVerdict.zip})` : "";
    if (areaVerdict.outcome === "serviced") {
      return `OUR RECORDS SAY the zip we hold${zip} is inside our service area. ` +
        `Coverage is settled — do not raise it as a question.`;
    }
    if (areaVerdict.outcome === "out_of_state") {
      const state = areaVerdict.state ? ` in ${areaVerdict.state},` : "";
      return `OUR RECORDS SAY the zip we hold${zip} is${state} which is a state PPP ` +
        `does not serve. This is our own lookup, not your judgement, so the ` +
        `condition in the paragraph above is met: choose "area_not_serviced".`;
    }
    return `OUR RECORDS SAY the zip we hold${zip} could not be matched to a ` +
      `territory. That is not the same as being outside our area — choose ` +
      `"checking_availability" so a person checks.`;
  })();

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

  const stable = `${opening}

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

WHAT YOU DO NOT KNOW.
You know what is written in this prompt and nothing else. Anything about PPP
that is not here — whether we are licensed or insured, whether there is a
minimum job size, warranties, payment terms, how long a job takes, who the
estimator is, whether we can start next week — you do NOT know, however
confidently you could guess it. Say you will find out rather than answering.
A wrong answer about PPP's business is worse than a short wait, because the
customer will hold us to it.

WAITING ON SOMETHING WITH A DATE OF ITS OWN. If what is blocking them is an
EVENT rather than a decision — moving in, a closing, an insurance payout, no
power at the property yet, travelling — do NOT park it straight away. Offer
the visit for WHEN THEY WILL have access first. Only if they will not wait
does the quick quote come up, and only if they turn both down is it parked.
Somebody who says "we move in on the 14th" is telling you when they are
ready, not asking you to go away.

A DAY IS NOT AN APPOINTMENT. "Wednesday works" is half an answer: an estimator
cannot be sent to a day. When they name a day but no time of day, ask which
part of that day suits them — morning or afternoon is enough — and only then
is availability collected. The same the other way round: a time with no day is
also half. Do NOT treat either half as done and do NOT close on it; the system
refuses that close and the conversation goes to a person instead of forward.

MORE THAN ONE PROPERTY. If they mention a second place, take them ONE AT A
TIME: finish the whole flow for the first property, then start again for the
next. Do not ask for both addresses in one message. Contact details are shared
— never ask for a name or an email twice because there are two properties. The
system will not let the conversation close as a success while a property they
told you about still has no address, so keep going rather than handing over.

HOW YOU SOUND:
${cfg.tone_rules ?? "Friendly, brief, one question at a time."}

${cfg.office_location ? `Our office is in ${cfg.office_location}.` : ""}
${cfg.service_area_note ? `Where we serve: ${cfg.service_area_note}` : ""}




${track === "new_lead" ? `BEFORE SWITCHING TO A PHONE QUOTE:
Say so first. If the job is small enough, or they want somebody out the same
day, we quote it over the phone instead of visiting, but tell them that is
what is happening and why, and confirm their contact details before you do.
Kate graded two conversations bad for moving to a phone quote with no warning.

A QUESTION BACK IS NOT AN ANSWER. If you asked for something and their reply
does not contain it — they asked you something instead, or changed the subject
— ANSWER THEM AND ASK AGAIN IN THE SAME MESSAGE. Do not move on to the next
step as though they had given it. Only an actual refusal lets you move past a
step; a question is not a refusal, and somebody who asks "what times do you
have?" still has not told you where the property is. Moving on anyway walks
the whole conversation to the end with nothing to book against, and the close
is then refused and the lead goes to a person.

WHEN THEY WILL NOT GIVE AN ADDRESS, THE ANSWER IS A PHONE QUOTE.
Ask once more for the ZIP CODE on its own — not the street again — and say why:
an accurate estimate needs to know the area. If they still will not, stop
asking, because an estimator cannot be sent to an address we do not have.

A phone quote is NOT a way out of the rest of the conversation. It still owes
their contact details, so ASK FOR THOSE FIRST and choose "phone_pricing" only
once you have. Choosing it before contact has been asked for is refused before
it can be sent, and the lead goes to a person instead of to a price.
` : ""}
${hardNos.length ? `\nNEVER, under any circumstances:\n${hardNos.map((h) => `- ${h}`).join("\n")}` : ""}
${classARules ? `\n${classARules}\n` : ""}${workspaceFaqs ? `\n${workspaceFaqs}\n` : ""}
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

  /**
   * EVERYTHING THAT CHANGES, AFTER EVERYTHING THAT DOES NOT.
   *
   * These four used to sit in the middle of the prompt, which is a reasonable
   * place to read them and the worst possible place to cache them: a cache
   * breakpoint covers a PREFIX, so one varying line early on makes everything
   * after it uncacheable too. About 6,000 of the ~7,200 input tokens on every
   * turn are identical — the 37 rule cards, the persona, the intent guide,
   * the workspace's FAQs — and they were being paid for in full, every turn,
   * on two models.
   *
   * Moved rather than duplicated. The text is unchanged and so is the order
   * within each piece; only the position of these four relative to the stable
   * body has changed.
   */
  const variable = [
    languagePrompt(language),
    areaLine,
    knownCustomerPrompt(known),
    examples ? examplesPrompt(examples) : "",
  ].map((x) => x.trim()).filter(Boolean).join("\n\n");

  return { stable, variable };
}

/**
 * The whole prompt as one string.
 *
 * Kept because the simulator, the tests and verify-iteration-1 all read it,
 * and because a caller that does not care about caching should not have to
 * know the prompt has two halves.
 */
export function buildSystemPrompt(
  ...args: Parameters<typeof buildSystemPromptParts>
): string {
  const { stable, variable } = buildSystemPromptParts(...args);
  return variable ? `${stable}\n\n${variable}` : stable;
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
          /**
           * "NEVER A COMMITMENT" WAS WIDER THAN THE RULE IT DESCRIBED, AND IT
           * SILENCED THE ANSWER.
           *
           * The validator's commitment_in_free_text is a specific DAY, TIME or
           * PRICE — TIME_COMMITMENT is a list of clock times and weekdays. It
           * has never banned confirming something PPP always does.
           *
           * The description did. "Can someone come out and look at my living
           * room?" has one honest answer — yes, somebody can come out — and
           * that reads exactly like a commitment, so the model wrote nothing
           * and A29 then refused the turn for carrying no answer. Every time,
           * on one of the commonest openings a painting lead has.
           *
           * Established by making the sandbox print the attempted action:
           * "It chose ask_project_details and wrote nothing alongside it."
           * Two earlier guesses at this had both been wrong.
           */
          "Short rapport only, or empty. Never a price. Never a specific day or time — "
          + "there is no calendar here, so naming one is always wrong. But saying YES to "
          + "something we always do is an ANSWER, not a commitment: if they ask whether "
          + "somebody can come out, whether you can take a look, or anything else that a "
          + "plain yes answers, say yes here in a few words. Leaving it out is the one "
          + "thing you may not do. "
          // THE SYSTEM WRITES THE REST OF THE MESSAGE. Nine of the thirty
          // templates share a stock phrase with the rapport a model naturally
          // writes, and one seen live said the same thing twice in
          // consecutive sentences: "I'll have the estimator confirm exactly
          // what's included. The estimator will confirm that with you
          // directly." The verbatim case is dropped by rapportIsRedundant; a
          // paraphrase like that one can only be stopped here, because the
          // remedy after the fact is deleting the half that carried the
          // answer.
          + "A sentence is added after yours that asks the next question and names "
          + "who follows up, so do not ask a question, do not say an estimator or "
          + "the office will be in touch, and do not repeat what you are about to "
          + "be followed by. Add only what that sentence will not say: the answer "
          + "to what they asked, or nothing at all.",
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
    /** 1, 2 or 3 when this turn is an A44 follow-up. Absent otherwise. */
    followUpStep?: number;
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
    /**
     * Did the customer describe the job in THIS conversation?
     *
     * A3's project-details leg is satisfied by an intent, and for this
     * customer no intent may legally fire — asking repeats what they just
     * said, and confirm_scope would echo their own words back at them.
     * Supplied by the caller from knownFromThread's `scopeFrom`, because
     * resolving it needs the thread. See A3_LEGS in agent-output.ts.
     */
    scopeFromCustomer?: boolean;
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
    /** Parity gap 9: this workspace's standing answers, already rendered. */
    workspaceFaqs?: string;
    /**
     * A25's phone branch: when we may call them, if we already know.
     *
     * Kate, 2026-09-18: "Ending without capturing when to call is the
     * defect." Supplied by the caller from the conversation row, because
     * reading it needs a database and this stays testable without one.
     */
    callback?: { unreachableStartHour?: number | null; availability?: string | null };
    /** The recipient's IANA zone, for the week-aware availability ask. */
    customerZone?: string;
    /**
     * A46: is it outside THIS CUSTOMER's callable window right now?
     *
     * Resolved by the caller through sendingWindow(), because it needs a
     * clock and this stays testable without one. Absent means "do not
     * disclose", which is the quiet direction to fail in.
     */
    outOfHours?: boolean;
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
   *   BOTH availability checks, 2026-10-01 — the validator's and the
   *   renderer's. "What days work best for you this week?" liked back reads
   *   as a DAY supplied, so the close guard and the follow-up ask both
   *   believed the customer had given half an answer they never gave.
   *
   * The same trap that put `Liked "..."` into inquiry_scope this morning, one
   * layer up. Five instances now, every one of them silent and every one in
   * the permissive direction, so if you are adding a rule that judges what
   * the customer said: it reads ownWords. normalizeInbound already answers
   * it: text is null for a bare reaction, because they said nothing of their
   * own.
   *
   * The PROMPT still gets the description. The model needs to know a photo
   * arrived or a message was liked; the rules need to know what was said.
   */
  const ownWords = inbound.text ?? "";

  /**
   * The third branch needs to know whether our last message was a yes/no
   * question. Taken from the message itself rather than the intent: an intent
   * name cannot tell "Would you like us to send that over?" from "What days
   * suit you?", and the reaction is answering the sentence, not the label.
   */
  const lastOutbound = [...history].reverse().find((m) => m.role === "assistant")?.text ?? "";
  const reaction = reactionResponse(
    inbound, opts.lastAskedForInfo ?? false, isYesNoQuestion(lastOutbound)
  );

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

  /**
   * A44 — A FOLLOW-UP HAS TO SOUND LIKE IT REMEMBERS THEM.
   *
   * Kate's spec: "Each of the three follow-ups follows up on their request
   * for their project, naming the scope where we hold it, so the customer
   * never restates what they have already told us."
   *
   * Nothing told the model it was writing one. A follow-up ran as an ordinary
   * turn, so the natural output is a generic "just checking in" — and that is
   * the Hatch behaviour this whole capability exists to replace: 192 defects
   * for making somebody repeat what we already hold.
   *
   * Turn context, not system prompt: it is true of THIS message and false of
   * the next one, and buildSystemPrompt is cached per workspace.
   */
  /**
   * EACH OF THE THREE HAS ITS OWN GOAL, and they are Kate's, 2026-10-05.
   *
   * This used to send one generic instruction for all three — "follow up on
   * THEIR project, then ask for the one thing still outstanding" — which made
   * the three nudges interchangeable. They are not: a nudge, then a concrete
   * ask for today, then a last check on whether they want the quote at all.
   * See stall-followup-goals.ts for her wording and why these are goals
   * rather than templates.
   */
  const followUpLine = isFollowUpStep(opts.followUpStep)
    ? `\nTHIS IS FOLLOW-UP ${opts.followUpStep} OF ${FOLLOW_UP_COUNT}. They have gone quiet; nothing new `
      + `has arrived. Do not open as though this is a fresh conversation and do not re-introduce `
      + `yourself. ${stallFollowUpGoal(opts.followUpStep, opts.known?.inquiryScope)} `
      + `No sign-off, and nothing that reads as an ending.\n`
    : "";

  const prompt = `${transcript ? `Conversation so far:\n${transcript}\n\n` : ""}${stageLine}${followUpLine}The customer has just sent:
${quoteCustomer(inbound.description)}
${reaction.guidance ? `\nHow to treat that: ${reaction.guidance}` : ""}

Choose the next action.`;

  /**
   * ── ONE RETRY, AND ONLY FOR A REFUSAL THAT NAMES ITS OWN FIX ────────────
   *
   * A rejection used to end the turn, on the reasoning in
   * agentFailureIsTransient: "the same input will be refused again next
   * minute, so retrying is pointless". That is true of a banned phrase or a
   * price — the model would write the same thing — and it was NOT true of the
   * refusals seen live on 2026-10-05, because every one of them says what to
   * do instead:
   *
   *   address_question_walked_past: ...so the address is still owed. Answer
   *   them AND ask for it again in the same message
   *
   * The model never saw that sentence. It got one roll and the lead went to a
   * person. Three times in one afternoon: it chose ask_contact where the
   * refusal said ask_address, wrote "Wednesday" into rapport where the prompt
   * says never name a day, and reached for phone_pricing before contact.
   * Replaying identical input gave different intents, so these are variance
   * rather than determinism — exactly what a second attempt fixes.
   *
   * EXACTLY ONE. The retry costs an API call and the system prompt is already
   * cached, so the marginal cost is small; an unbounded loop is not, and a
   * model that declines the same instruction twice is telling us the
   * instruction is wrong rather than unlucky.
   *
   * THE TERMINAL SEMANTICS ARE UNCHANGED. After the retry is spent the result
   * is the same `rejected` shape it always was, so agentFailureIsTransient
   * still reads it as terminal and the scheduler still cancels rather than
   * counting a failure. That contract is what stops a rate-limited minute
   * silently dropping replies, which this codebase has already done once.
   */
  const MAX_ATTEMPTS = 2;

  try {
    const client = new Anthropic({ apiKey });
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
    /** The first refusal, once there has been one. */
    let firstRefusal: string | undefined;

    /**
     * BUILT ONCE, SENT ON BOTH ATTEMPTS — which is also what makes the retry
     * cheap. The cached prefix is the same bytes, so a retry reads the cache
     * rather than paying for 6,000 tokens of rules a second time.
     */
    const systemBlocks = (() => {
      const { stable, variable } = buildSystemPromptParts(
        cfg, opts.hardNos ?? [], track, opts.known, opts.examples, opts.services,
        opts.classARules, opts.workspaceFaqs, language,
        // A2: the verdict the caller already looked up. It reached the
        // validator and stopped there, so the model was asked to apply a
        // rule whose one input it could not see.
        opts.serviceArea
          ? { outcome: opts.serviceArea, zip: opts.zip, state: opts.stateName }
          : null,
      );
      const blocks: Anthropic.TextBlockParam[] = [
        { type: "text", text: stable, cache_control: { type: "ephemeral" } },
      ];
      if (variable) blocks.push({ type: "text", text: variable });
      return blocks;
    })();

    let res = await client.messages.create({
      model: MODEL,
      // Choosing one of eighteen intents and a line of rapport is a
      // classification, not a reasoning problem. Adaptive thinking plus a
      // 2000-token ceiling made every simulator turn a multi-second wait for a
      // reply that is two sentences long, and the extra thinking changed the
      // chosen intent in none of the cases that were checked.
      max_tokens: 700,
      /**
       * TWO BLOCKS, AND THE FIRST ONE IS CACHED.
       *
       * About 6,000 of the ~7,200 input tokens on every turn never change:
       * the 37 rule cards, the persona, the intent guide, the workspace's
       * standing answers. Measured, not guessed — the rules block alone is
       * 9,566 characters.
       *
       * They were being paid for in full on every turn, on two models, and
       * the account ran out of credit mid-session. A cache breakpoint covers
       * a PREFIX, which is why the four varying pieces had to move to the end
       * first; see buildSystemPromptParts.
       *
       * The cached prefix is stable PER WORKSPACE — persona, services, tone,
       * rules, FAQs — so there is one entry per workspace rather than one per
       * conversation, and sixteen live workspaces means sixteen.
       *
       * Correctness is unaffected either way: a cache miss sends exactly the
       * same bytes and costs exactly what it used to.
       */
      system: systemBlocks,
      messages,
      tools: [actionTool(track)],
      // One tool, and it must be used. There is no path where the model
      // replies with prose instead of choosing an action.
      tool_choice: { type: "tool", name: "choose_action" },
    });

    /**
     * IS THE CACHE ACTUALLY BEING HIT?
     *
     * A broken prompt cache costs money and changes nothing a test can see:
     * the same bytes go out, the same reply comes back, and the bill quietly
     * stays where it was. Exactly the invisible failure this codebase keeps
     * producing, so it gets a signal rather than a hope.
     *
     * ZERO ON BOTH COUNTERS IS THE FAULT. A read of 0 with a non-zero
     * creation is a cold cache, which is normal and expected once per
     * workspace every few minutes; a read of 0 with a creation of 0 means the
     * breakpoint is not being honoured at all — usually because something
     * that varies per turn has drifted back into the stable half.
     *
     * Deduped by the observability layer, so a sustained fault says so once
     * rather than once per turn.
     */
    const usage = res.usage as { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
    if (usage && !usage.cache_read_input_tokens && !usage.cache_creation_input_tokens) {
      reportWarn({
        key: "sms_prompt_cache_not_used",
        message: "The agent prompt cache was neither read nor written — the stable prefix is not being cached",
        platform: "ppp_cc",
        context: { model: MODEL, inputTokens: res.usage?.input_tokens ?? null },
      });
    }

    const call = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "choose_action"
    );
    if (!call) {
      return { ok: false, error: "The model replied without choosing an action." };
    }
    // tool_use.input is already parsed. Never string-match it — escaping
    // differs between models.
    const parsed: unknown = call.input;

    /**
     * WHAT THE CUSTOMER HAS SAID, AND EVERY ADDRESS IT CONTAINS.
     *
     * Computed once because the validator and the renderer must agree: one
     * refuses `success` while a second property has no address, the other asks
     * the question that fixes it. Two copies of this expression would let them
     * drift, and the failure would be the bot asking for an address it is
     * about to accept — or worse, refusing to close for a reason nothing asks
     * about.
     */
    const customerSaid = [
      ...history.filter((t) => t.role === "customer").map((t) => t.text),
      ownWords,
    ];
    const addressesHeld = addressesInThread({ customerMessages: customerSaid, onFile: kf.address });
    /**
     * WHICH ONE AM I ASKING ABOUT — not "is anything outstanding".
     *
     * validateAction answers the second question itself from addressesHeld, to
     * block the close. This one only LABELS the ask, and it is due once the
     * first address is in. Running them together asked a customer for "the
     * address for the second property" before we had the first.
     */
    const wantsSecondAddress = secondPropertyAskDue({
      customerMessages: customerSaid,
      addressesHeld,
    });

    // The post-filter. Even with a constrained schema, freeText is free text.
    //
    // Named rather than inlined so BOTH attempts are judged by exactly the
    // same context. Building it twice is how a retry quietly gets an easier
    // test than the attempt it is replacing.
    const validateCtx = {
      confidenceThreshold: cfg.confidence_threshold,
      hardNoPhrases: opts.hardNos,
      track,
      // Ordering only applies to the new-lead flow. Nurture has no collection
      // steps to keep in order.
      stage: track === "new_lead" ? opts.stage : undefined,
      customerText: ownWords,
      // A40: every earlier customer message, so a deferral made last turn
      // still stops the bot pressing this turn. The whole thread, because a
      // park does not have to be repeated to still be true.
      customerMessages: history.filter((t) => t.role === "customer").map((t) => t.text),
      /**
       * Parity gap 6: every address the conversation holds, so `success`
       * cannot close over a second property the customer told us about.
       *
       * READ FROM THE THREAD, not from the one address column. This line used
       * to be `kf.address ? [kf.address] : []`, which can never hold more than
       * ONE — so `addressesCollected(...) < 2` was permanently true from the
       * moment somebody said "two rentals", and `success` was refused for the
       * whole life of the conversation however many addresses they typed. A
       * class of lead that could not convert, and nothing looked wrong: the
       * other intents stayed open, so the bot kept talking and the lead ended
       * as a follow-up instead of a booked estimate.
       *
       * The record still wins for the first — it is the office's version — and
       * the rest come out of what the customer actually wrote, INCLUDING this
       * turn, because the second address usually arrives in the message that
       * is being validated right now.
       */
      addressesHeld,
      /**
       * A4, ACROSS THE CONVERSATION rather than this one message.
       *
       * This was availabilityGap(inbound.description), which asks "is there
       * bookable availability in what they JUST said". After the availability
       * turn the answer is always no — the next message is an address, a
       * name, a "yes that's right" — so the close guard blocked conversations
       * that had collected all four legs and then said one more thing, and
       * handed them to a person. Found running two properties end to end in
       * the sandbox; see availabilityGapAcross for the transcript.
       *
       * The renderer's copy below stays per-message on purpose: it is wording
       * the follow-up ask about what the customer just wrote.
       *
       * AND IT IS customerSaid, NOT inbound.description. The description is a
       * narration written for the model — on a bare reaction it reads `The
       * customer Liked the message: "What days work best for you this week?"`,
       * quoting OUR OWN sentence back. Fed to an availability parser that
       * returns "window", meaning a day was supplied, read out of our own
       * question. ownWords is empty for a reaction precisely because they said
       * nothing, which is what this rule needs to know. The first draft of
       * this fix used the description and had exactly that bug.
       */
      /**
       * AND THE FLAG THAT MAKES "YES PLEASE" AN ANSWER WAS NEVER PASSED.
       *
       * availabilityGap has taken `justAskedForAvailability` since it was
       * written, and the only places that ever set it were its own tests. In
       * production it was always false, so the ASSENT list — including the
       * Spanish words added specifically to stop a "sí, perfecto" lead being
       * unclosable — could not fire once.
       *
       * The result was a conversation that can never end: Kate's rule is that
       * a bare yes to the availability question IS availability, the close
       * guard disagreed, and the customer was asked for days they had already
       * agreed to, every turn. The lead who answered everything was the one
       * that could not convert.
       *
       * Gated on OUR last intent, so the carve-out only applies to a message
       * that is actually answering our availability question.
       */
      availabilityGap: availabilityGapAcross(customerSaid, {
        justAskedForAvailability: opts.lastIntent === "ask_availability",
      }),
      // Whether the template for the chosen intent already asks something.
      templateAsks: (intent: string) => templateAsks(intent as Intent, history.length),
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
      // ...and the one leg no intent can satisfy, for the customer who
      // described the job themselves. See A3_LEGS.
      scopeFromCustomer: opts.scopeFromCustomer,
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
    };

    let attempted: unknown = parsed;
    let v = validateAction(attempted, validateCtx);

    /**
     * THE RETRY. See MAX_ATTEMPTS above for why this exists and why it is one.
     *
     * The refusal goes back as a tool_result against the model's own tool_use,
     * which is the shape the API requires and also the honest one: it is the
     * RESULT of the action it chose, not a new instruction appended to the
     * system prompt. The detail already says what to do instead, so nothing
     * here rewrites or softens it.
     */
    let currentCall = call;
    for (let attempt = 2; !v.ok && attempt <= MAX_ATTEMPTS; attempt++) {
      firstRefusal ??= `${v.reason}: ${v.detail}`;
      messages.push({ role: "assistant", content: res.content });
      messages.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: currentCall.id,
          is_error: true,
          content: `That reply was REFUSED before sending and the customer did not see it.\n\n`
            + `${firstRefusal}\n\n`
            + `Choose again, fixing exactly that. Do not repeat the same choice.`,
        }],
      });
      res = await client.messages.create({
        model: MODEL,
        max_tokens: 700,
        system: systemBlocks,
        messages,
        tools: [actionTool(track)],
        tool_choice: { type: "tool", name: "choose_action" },
      });
      const again = res.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "choose_action"
      );
      // No action on the retry is the same dead end as none on the first try,
      // so keep the refusal we already have rather than inventing a new one.
      if (!again) break;
      currentCall = again;
      attempted = again.input;
      v = validateAction(attempted, validateCtx);
    }
    /**
     * A REJECTION HAS TO SAY WHAT WAS REJECTED.
     *
     * This returned the reason and threw the turn away, so the sandbox showed
     * "question_left_unanswered: the customer asked something and this turn
     * only asks the next question back" and nothing else — and that sentence
     * is true of two completely different failures:
     *
     *   the model wrote no answer at all, or
     *   the model wrote one and a style filter deleted it first
     *
     * Those need opposite fixes, and on 2026-09-28 I shipped two changes
     * guessing between them because the screen could not tell me which. The
     * model's own words are the evidence, and the grader needs them too: a
     * person marking this turn "Wrong" cannot say what the bot should have
     * done instead without seeing what it tried.
     */
    if (!v.ok) {
      return {
        ok: false,
        error: "The reply was rejected before sending.",
        // The LAST refusal, which is what the model saw most recently and what
        // a grader needs to read first.
        rejected: `${v.reason}: ${v.detail}`,
        // And the first, when a retry was spent — two different refusals mean
        // the model moved and still missed, one repeated means it did not.
        ...(firstRefusal && firstRefusal !== `${v.reason}: ${v.detail}`
          ? { retriedAfter: firstRefusal }
          : {}),
        attempted: {
          intent: (attempted as { intent?: string })?.intent ?? "(none)",
          freeText: (attempted as { freeText?: string })?.freeText ?? null,
        },
      };
    }

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
      /**
       * Parity gap 6: name WHICH property the ask is about.
       *
       * The same condition the validator uses to refuse `success`, so the
       * question that unblocks the close is the one the customer gets asked.
       * Without this the validator blocked and nothing ever asked — the bot
       * repeated "What's the address for the project?" to somebody who had
       * already given one.
       */
      secondProperty: wantsSecondAddress,
      /**
       * A REPEAT ask, which is Kate's zip floor rather than the same question
       * twice. "We hold nothing AND we have asked" stands in for a refusal
       * without having to detect one — the same ask-based test the A3 legs use.
       *
       * EXCEPT WHEN THEY ASKED US SOMETHING, which is the case it got wrong.
       * The zip floor is the concession we make AFTER a refusal — "we at least
       * need the zip code" gives up the street on purpose, and says "No
       * problem" to having been turned down. A customer who answered the
       * address question with a question of their own has refused nothing, and
       * played live that read as conceding to a refusal that never happened
       * while handing back the street for free. They get the ordinary ask
       * again; the floor is still there for when they actually decline.
       */
      addressAskedBefore: !kf.address
        && (opts.priorIntents ?? []).includes("ask_address")
        && !asksSomething(ownWords),
      /**
       * A4: and the same for availability. Read from what the customer just
       * said, because that is where an answer to an availability question
       * lands. Only narrows an ask the model has already chosen to make.
       *
       * ownWords, not inbound.description — the third rule check to need that
       * distinction, after the two named at the top of this function. On a
       * bare reaction the description quotes our own sentence back, so a
       * thumbs-up on "What days work best for you this week?" read as a DAY
       * supplied and narrowed the next ask to "and roughly what time of day
       * suits you then?" — asking a customer who had said nothing at all to
       * fill in the half we had invented for them.
       */
      availabilityGap: availabilityGap(ownWords),
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
      // Parity 7: having worked with PPP before is said ONCE, several turns
      // before the refusal it explains. A check reading only customerText
      // never sees both halves, which is why the acknowledgement never fired.
      customerMessages: history.filter((t) => t.role === "customer").map((t) => t.text),
      // And Parity 7 caps that acknowledgement at ONE. The only record of
      // having sent it is what we sent.
      botMessages: history.filter((t) => t.role === "assistant").map((t) => t.text),
      // Hatch's stand-off: they have asked us for times twice, so no template
      // may ask them a third time, whichever intent the model picked.
      availabilityStandOff: isAvailabilityStandOff(customerSaid),
      // So a template cannot ask step four's question at step one.
      flowStage: track === "new_lead" ? opts.stage : undefined,
      // A30: "match the language they wrote in and KEEP MATCHING IT. Do not
      // switch back to English on the next turn." So it reads every customer
      // message in the thread plus this one, not just the latest — somebody
      // who opened in Spanish and then replies "ok" is still owed Spanish.
      language,
      track,
      // A25: lets the phone branch tell "hand over now" from "ask when
      // first". Falls back to whatever the customer just said, so a caller
      // with no conversation row still gets the constraint they stated in
      // this very message rather than being asked all over again.
      // The day-dependent availability ask needs to know which side of the
      // CUSTOMER's Thursday we are on. Without both of these it falls back to
      // the generic wording rather than guessing a week.
      now: new Date(),
      customerZone: opts.customerZone,
      callback: {
        ...(opts.callback ?? {
          unreachableStartHour: statedConstraint(ownWords)?.startHour ?? null,
        }),
        /**
         * A25, Kate 2026-09-28: the hour they asked to be called at, so a
         * time outside the office window is answered with the hours rather
         * than handed to a person as though it were bookable.
         *
         * Always read from THIS message, even when the caller supplied a
         * callback object: the record remembers a time captured turns ago,
         * and the correction is about the one they just named.
         */
        requestedHour: requestedTime(ownWords)?.hour ?? null,
      },
    };
    let rendered = renderMessage(renderInput);

    /**
     * A46 — the out-of-hours disclosure, on the FIRST reply only.
     *
     * Prefixed to the message already being sent rather than sent on its own,
     * so it contributes no ask of its own (A22). `bot_suspected` is handled
     * by its own template and needs nothing here — the approved in-hours
     * string IS that template.
     *
     * Whether we are out of hours is the CUSTOMER's question, not the
     * workspace's: opts.outOfHours is resolved by the caller against their
     * own callable window. Absent, nothing is prefixed, which is the quiet
     * direction to fail in.
     */
    if (v.action.intent !== "bot_suspected") {
      const move = disclosureMove({
        askedIfBot: false,
        outOfHours: opts.outOfHours ?? false,
        alreadyDisclosed: alreadyDisclosed(
          history.filter((t) => t.role === "assistant").map((t) => t.text)
        ),
      });
      rendered = applyDisclosure(move, rendered, language === "es");
    }

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
      // A retry rescued this turn: without it, the conversation would have
      // gone to a person here. Carried so the rate is countable rather than
      // assumed — see MAX_ATTEMPTS.
      ...(firstRefusal ? { retriedAfter: firstRefusal } : {}),
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
