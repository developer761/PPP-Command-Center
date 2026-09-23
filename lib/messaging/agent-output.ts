/**
 * What the model is allowed to say.
 *
 * The single biggest quality lever, and almost certainly why Hatch's bot is
 * described as mediocre: it lets the model write the message.
 *
 * Here the model never emits prose that reaches a customer. It emits a
 * structured ACTION — an intent plus slots — and anything carrying a
 * commitment renders from a template using values the system verified. The
 * model can be wrong about WHAT TO DO, which the confidence gate catches and a
 * human can correct. It cannot invent an appointment that does not exist, or
 * promise work PPP does not do, because there is no field in which to say so.
 *
 * That is the difference between asking a prompt to behave and removing the
 * ability to misbehave.
 *
 * Pure: validation and rendering only. Nothing here calls a model or a network.
 */
import type { AddressGap } from "./address";
import type { JobRoute } from "./offsite";

/** Emily's terminal states, verbatim. */
export const END_INTENTS = [
  "success", "discard", "schedule_follow_up", "lost", "bailout",
  "phone_pricing", "transferred", "bot_suspected", "msg_liked_loved",
  "area_not_serviced",
] as const;

export const CONTINUE_INTENTS = [
  "ask_project_details", "ask_address", "ask_contact", "ask_availability",
  // TWO off-site intents, not one. A6 PRESENTS the quick quote when the JOB
  // routes off-site and forbids a reason; A7 OFFERS it when the job routes
  // onsite but the customer qualifies, and mandates one. "A6 is REQUIRED and
  // states the quick quote as the plan; A7 is OPTIONAL and asks. Different
  // sentences, different situations." One intent could only ever say one of
  // them, so every turn of the other kind was a breach.
  "acknowledge", "answer_question", "present_offsite_quote", "offer_offsite_quote", "escalate",
  // Something landed badly. Without this the only outlets for a customer who
  // reacted negatively were re-asking the same question or escalating, so it
  // re-asked — and the renderer's variant rotation made a repeat look like a
  // rephrase while being the same question.
  "acknowledge_negative",
  // Confirming is a different act from asking, and Kate graded the difference
  // twice. These read a value we already hold back to the customer; they are
  // only offered when that value exists.
  "confirm_scope", "confirm_address", "confirm_contact",
] as const;

/**
 * The required order, as a rule rather than a request.
 *
 * "Project details, then full address, then contact information, then
 * appointment availability. The order is the rule. Even when an off-site quote
 * replaces the appointment, the first three are still collected and never
 * reordered." — PPP's prompt, and previously only PPP's prompt: the model was
 * asked to keep the order and nothing checked that it had. Kate's graded
 * conversations show it skipping and reordering, which is what a preference
 * gets you.
 *
 * Index is the stage the conversation must already have reached. Asking for
 * availability while we still have no address is refused outright.
 */
export const FLOW_ORDER = [
  ["ask_project_details", "confirm_scope"],
  ["ask_address", "confirm_address"],
  ["ask_contact", "confirm_contact"],
  ["ask_availability"],
] as const;

/** Every intent that participates in the ordered flow. */
const FLOW_INTENTS = new Set<string>(FLOW_ORDER.flatMap((g) => [...g]));

/** Which stage an intent belongs to, or -1 if it is not part of the flow. */
export function stageOfIntent(intent: string): number {
  return FLOW_ORDER.findIndex((g) => (g as readonly string[]).includes(intent));
}

/**
 * How far the flow has got, from the intents already used.
 *
 * Asking for something counts as completing that step: in a live conversation
 * the customer's reply is the next inbound, and a step the bot asked twice is
 * a different bug than a step it skipped.
 */
export function stageFromIntents(intents: (string | null | undefined)[]): number {
  let stage = 0;
  for (const i of intents) {
    if (!i) continue;
    const s = stageOfIntent(i);
    if (s >= 0) stage = Math.max(stage, s + 1);
  }
  return Math.min(stage, FLOW_ORDER.length);
}

/** Which known field an intent reads back, and which ask it replaces. */
export const CONFIRM_REQUIRES: Record<string, "inquiryScope" | "address" | "email"> = {
  confirm_scope: "inquiryScope",
  confirm_address: "address",
  confirm_contact: "email",
};

/**
 * The ask that is forbidden once we hold the value.
 *
 * EVERY field listed must be held before the ask is refused, because an ask
 * that collects two things is still worth making when we only have one of
 * them. ask_contact collects a name and an email, and refusing it because we
 * happen to know the name would strand the conversation with no email.
 *
 * ask_contact was missing from this table entirely. That is A13 — "Do not ask
 * the customer to RETYPE data already held" — 206 breaches and critical: with
 * the email and name on file, nothing stopped the bot asking for them again.
 * The old type even declared "phone" as a legal value with no entry using it,
 * which is the shape of an intention that never landed.
 */
export const ASK_SUPERSEDED_BY: Record<string, readonly KnownField[]> = {
  ask_project_details: ["inquiryScope"],
  ask_address: ["address"],
  ask_contact: ["name", "email"],
};

export type KnownField = "name" | "phone" | "email" | "address" | "inquiryScope";

/**
 * Nurture: the quote already went out and the job is to get a decision.
 *
 * A separate vocabulary rather than more entries on the new-lead list, because
 * the wrong intent is the failure mode here. A nurture conversation must never
 * be able to choose ask_address — the customer has already had an estimator
 * standing in the room, and asking again is the clearest possible proof that
 * nobody is reading. Restricting the enum makes that impossible rather than
 * discouraged.
 */
export const NURTURE_CONTINUE_INTENTS = [
  "nurture_check_in", "ask_for_decision", "ask_check_back",
  "offer_estimator_call", "acknowledge", "acknowledge_negative",
  "answer_question", "escalate",
] as const;

export const NURTURE_END_INTENTS = [
  "accepted", "schedule_follow_up", "lost", "bailout", "phone_pricing",
  "transferred", "bot_suspected", "msg_liked_loved", "discard",
] as const;

export type Track = "new_lead" | "nurture";

/** The only intents this track may choose. */
export function intentsForTrack(track: Track): readonly string[] {
  return track === "nurture"
    ? [...NURTURE_END_INTENTS, ...NURTURE_CONTINUE_INTENTS]
    : [...END_INTENTS, ...CONTINUE_INTENTS];
}

export type EndIntent = (typeof END_INTENTS)[number];
export type ContinueIntent = (typeof CONTINUE_INTENTS)[number];
export type NurtureIntent =
  | (typeof NURTURE_END_INTENTS)[number]
  | (typeof NURTURE_CONTINUE_INTENTS)[number];
export type Intent = EndIntent | ContinueIntent | NurtureIntent;

export type AgentAction = {
  intent: Intent;
  /** Free text is allowed ONLY here, and only for non-committal rapport. It is
   *  post-filtered before it can reach anybody. */
  freeText?: string;
  slots?: Record<string, unknown>;
  confidence: number;
};

export type ValidationResult =
  | { ok: true; action: AgentAction; droppedRapport?: string }
  | { ok: false; reason: RejectReason; detail: string };

export type RejectReason =
  | "repeated_after_negative"
  | "out_of_order"
  | "unknown_intent"
  | "confidence_out_of_range"
  | "commitment_in_free_text"
  | "out_of_scope_work"
  | "quoted_a_price"
  | "invented_availability"
  | "banned_by_hard_no"
  | "wrong_offsite_rule";    // presented what should be offered, or the reverse

/**
 * Phrases that mean the model has committed to something it has no authority
 * to commit to. Deliberately blunt: a false positive costs one regenerated
 * draft, a false negative sends a customer a price PPP never agreed.
 */
const PRICE = /\$\s?\d|(?:\d+\s?(?:dollars|bucks))|\b(?:costs?|price|quote|charge|estimate)\s+(?:is|will be|would be|starts? at|around|about)\b/i;

/** A specific time or date. The model may never offer one — Emily's prompt is
 *  explicit: "Never offer, confirm, or suggest appointment times yourself." */
const TIME_COMMITMENT =
  /\b(?:\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|tomorrow\b|next week\b|this (?:afternoon|morning|evening)\b)/i;

/**
 * Work PPP does not do.
 *
 * Two groups, and the distinction cost a test to find. Kate's documented
 * exclusion list is about SURFACES — bathtubs, appliances, vehicles, murals —
 * and those are matched as bare nouns because the verb can come either side of
 * them. The first version required "bathtub refinishing" in that order and let
 * "refinish the bathtub" straight through.
 *
 * The second group is trades PPP is not, which are not on her list because
 * nobody thought to write down that a painting company does not do plumbing.
 */
const OUT_OF_SCOPE_SURFACES =
  /\b(?:bathtubs?|appliances?|vehicles?|pool (?:tiles?|liners?)|murals?)\b/i;
const OUT_OF_SCOPE_TRADES =
  /\b(?:roofing|roof repair|plumbing|electrical|hvac|landscap\w*|masonry|paving|window replacement|siding install\w*|reupholster\w*)\b/i;
const OUT_OF_SCOPE = new RegExp(
  `${OUT_OF_SCOPE_SURFACES.source}|${OUT_OF_SCOPE_TRADES.source}`, "i"
);

/**
 * Kate's tone rules, as code.
 *
 * These are graded differently from a price or an invented appointment, and
 * the difference is deliberate. Quoting a price is a promise we cannot keep and
 * the whole action is refused. An em dash is ugly. Refusing the turn over
 * punctuation would escalate a conversation to a human because the model used
 * the wrong hyphen, which is a worse outcome than the hyphen.
 *
 * So a style violation drops the RAPPORT and keeps the action. The template
 * still carries the message, the conversation still moves, and the thing that
 * broke the rule is simply not sent. Nothing is rewritten — text is either
 * clean or dropped, because silently editing what a model wrote and sending it
 * anyway is how you end up unable to explain a message.
 */
const BANNED_STYLE: { re: RegExp; why: string }[] = [
  { re: /[—–]/, why: "em dash" },
  { re: /\.\.\.|…/, why: "ellipsis" },
  { re: /[()]/, why: "parentheses" },
  { re: /\byep\b/i, why: '"Yep"' },
  { re: /thanks for letting me know/i, why: '"Thanks for letting me know"' },
  // A23 names five things. Three were checked here and two were not, and the
  // two that were not account for 100 of the 400 A23 breaches sampled out of
  // Kate's grading. A rule enforced at three fifths reads, from her side of
  // it, as a bot that ignores the rule.
  //
  // Letters are required BOTH sides of the hyphen so this cannot fire on a
  // phone number, a date range, a minus sign or a trailing dash.
  { re: /[a-z]{2,}-[a-z]{2,}/i, why: "a hyphenated compound" },
  { re: /;/, why: "a semicolon" },
];

/** Longest run of words appearing verbatim in both strings. */
function longestSharedRun(a: string, b: string): number {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const x = norm(a), y = norm(b);
  if (!x.length || !y.length) return 0;
  let best = 0;
  const row = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let prev = 0;
    for (let j = 1; j <= y.length; j++) {
      const tmp = row[j];
      row[j] = x[i - 1] === y[j - 1] ? prev + 1 : 0;
      if (row[j] > best) best = row[j];
      prev = tmp;
    }
  }
  return best;
}

/** Words repeated verbatim before it counts as echoing them back. Four is
 *  short enough to catch "the exterior of my house" and long enough not to
 *  fire on "for the estimate". */
export const ECHO_WORDS = 5;

/**
 * A justification bolted onto an ask. A32.
 *
 * Every pattern comes from a line the bot actually sent in Kate's corpus, not
 * from imagining what a reason looks like:
 *
 *   "so we can get your free quote moving"     "since it's already Thursday"
 *   "so we can get you on the calendar"        "since it's a small shed"
 *   "so we can get your estimate set up"       "to save you a visit"
 *   "for faster turnaround"                    "since it's one room"
 *
 * "so" needs a following verb phrase, so "so glad to hear it" and "so that
 * works" stay allowed — those are rapport, which is what this field is for.
 *
 * ── FIRST PERSON ONLY, AND THE CORPUS IS WHY ────────────────────────────
 *
 * "so WE can" and "so I can" are padding: they explain OUR process, which is
 * the thing Kate says makes the message longer without making it clearer.
 * "so YOU can" is the customer's benefit and reads as a courtesy rather than
 * a justification. Run over the 2,861 non-question bot sentences in her
 * corpus, this pattern flagged 18, and the only two that were arguable were
 * both second person:
 *
 *   "we'll give you a heads up before anyone arrives so you can get the
 *    dog settled"
 *   "we can keep everything clear by going over it in person so you can
 *    ask questions"
 *
 * The second is Kate's own redirect carve-out — the bot proposing a visit
 * when the customer asked for something else IS a departure and owes an
 * explanation. Excluding the second person keeps both and loses nothing that
 * she marked.
 */
const REASON_CLAUSE =
  /\b(?:since|because|in order to|that way)\b[^.!?]*|\bso (?:we|i)\s+(?:can|could|will)\b[^.!?]*|\bso that we\b[^.!?]*|\bto save you\b[^.!?]*|\bfor faster\b[^.!?]*/i;

export type RapportCheck = { ok: true } | { ok: false; why: string };

/**
 * TONE ONLY: the rules that bind every word we send, template or not.
 *
 * Split out from checkRapport because A32 is the one rule that binds rapport
 * and NOT templates. Kate's exception is explicit: "THE ONE EXCEPTION is A7's
 * off-site offer, where the bot is explaining a DEPARTURE from the normal
 * route... A reason is MANDATED there." That reason lives in a template, by
 * design, because the system decides when a departure is happening and the
 * model does not. Running the reason check over templates would forbid the
 * exact sentence the rule requires.
 */
export function checkTone(text: string, customerText?: string): RapportCheck {
  // One question at a time. The template asks the question; rapport that also
  // asks one makes two, which is the rule Kate states first.
  if (text.includes("?")) return { ok: false, why: "it asks a second question" };

  for (const b of BANNED_STYLE) {
    if (b.re.test(text)) return { ok: false, why: `it uses ${b.why}` };
  }

  if (customerText && longestSharedRun(text, customerText) >= ECHO_WORDS) {
    return { ok: false, why: "it repeats the customer's own words back" };
  }
  return { ok: true };
}

export function checkRapport(text: string, customerText?: string): RapportCheck {
  const tone = checkTone(text, customerText);
  if (!tone.ok) return tone;

  // A32: CUT THE REASON. The ask stands alone.
  //
  // "No 'since you're moving', no 'before we schedule anything', no 'so we can
  // get you taken care of'. A reason padded onto a routine ask makes the
  // message longer without making it clearer." 199 breaches in Kate's
  // grading, all of this shape:
  //
  //   "Just checking back SO WE CAN GET YOUR FREE QUOTE MOVING. What day…"
  //   "SINCE IT'S ALREADY THURSDAY, we have a few openings next week…"
  //
  // Checked HERE and not on the templates, because the templates are clean
  // and this is the only channel through which the model can add prose to a
  // message. The rule's exceptions all live in templates and so cannot reach
  // this check: A7's off-site offer explains a genuine departure from the
  // normal route and its reason is MANDATED, but it is template text, chosen
  // by intent rather than improvised here.
  //
  // Rapport exists for "Got it" and "Happy to help". A justification is not
  // rapport, and the template it would be bolted onto already says the thing.
  const reason = REASON_CLAUSE.exec(text);
  if (reason) return { ok: false, why: `it pads the ask with a reason ("${reason[0].trim()}")` };

  return { ok: true };
}

export type ValidateContext = {
  /** Slots the system verified. An intent may only reference these. */
  verifiedSlots?: Record<string, unknown>;
  /** Kate's hard nos, as phrase lists. */
  hardNoPhrases?: string[];
  /** Below this the action escalates instead of sending. */
  confidenceThreshold?: number;
  /** Which vocabulary applies. Defaults to new_lead, which is what every
   *  caller meant before nurture existed. */
  track?: Track;
  /** Which known fields we hold. Drives both directions: confirm_* needs the
   *  value to exist, and ask_* is refused once it does. */
  knownFields?: Partial<Record<KnownField, boolean>>;
  /**
   * What is still missing from a PARTIAL address, when one is held.
   *
   * A boolean cannot express A11. "482 Marchmont Ave" with no zip is neither
   * held nor missing: refusing the ask strands the conversation without a zip,
   * and allowing the ordinary ask makes the customer retype the street they
   * already sent. Undefined means the caller does not track addresses in
   * parts, and the plain held/not-held rule applies.
   */
  addressGap?: AddressGap;
  /**
   * Where the JOB routes, from the lookup in offsite.ts. Decides whether the
   * quick quote is PRESENTED (A6, no reason) or OFFERED (A7, reason
   * mandatory). Undefined when the scope is not known well enough to say,
   * which refuses neither — both rules are gated on knowing what the job is.
   */
  jobRoute?: JobRoute | null;
  /** What the customer just said, so rapport can be checked for echoing it. */
  customerText?: string;
  /** The customer reacted negatively to the previous message. */
  negativeReaction?: boolean;
  /** What we said last, so the same thing is not said straight back. */
  lastIntent?: string;
  /** How much of the required flow is already done: 0 means nothing collected,
   *  4 means all of it. Undefined disables the ordering check, which is what
   *  every caller that does not track a conversation wants. */
  stage?: number;
};

export function validateAction(raw: unknown, ctx: ValidateContext = {}): ValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "unknown_intent", detail: "action was not an object" };
  }
  const a = raw as Partial<AgentAction>;

  const all: readonly string[] = intentsForTrack(ctx.track ?? "new_lead");
  if (typeof a.intent !== "string" || !all.includes(a.intent)) {
    return { ok: false, reason: "unknown_intent", detail: `intent "${String(a.intent)}" is not one of the allowed set` };
  }

  // Asking the same thing again after somebody reacted badly to it.
  //
  // Karan sent a thumbs-down and got the same question reworded. Rewording is
  // not a different action: if the customer disliked being asked, asking again
  // is the failure, however it is phrased. The model has acknowledge_negative
  // and escalate available and has to use one of them.
  if (ctx.negativeReaction && ctx.lastIntent && a.intent === ctx.lastIntent) {
    return {
      ok: false, reason: "repeated_after_negative",
      detail: `the customer reacted negatively to ${ctx.lastIntent} and this repeats it`,
    };
  }

  // The required order. Out of order is refused, not discouraged.
  if (ctx.stage !== undefined && FLOW_INTENTS.has(a.intent)) {
    const want = stageOfIntent(a.intent);
    if (want > ctx.stage) {
      return {
        ok: false, reason: "out_of_order",
        detail: `${a.intent} belongs to step ${want + 1} but only ${ctx.stage} of the required information has been collected`,
      };
    }
  }

  // Confirming something we do not have would invent it.
  const needs = CONFIRM_REQUIRES[a.intent];
  if (needs && ctx.knownFields && !ctx.knownFields[needs]) {
    return { ok: false, reason: "unknown_intent", detail: `${a.intent} needs a known ${needs} and there is none on file` };
  }
  // Asking for something we already hold. Kate: "asked customer for phone
  // number + to type out phone number" — the reason that reached her was a
  // prompt instruction, which the model ignored. This is not an instruction.
  // A6 vs A7: THE JOB DECIDES WHICH SENTENCE, NOT THE MODEL.
  //
  // "THE TEST IS THE JOB, NOT THE CUSTOMER. Read the JOB ROUTING LOOKUP: does
  // the job allow phone pricing? It is a LOOKUP, not a judgement."
  //
  // So the model may pick either off-site intent and this refuses the one the
  // route contradicts. Presenting a quick quote as the plan for a job that
  // needs a visit promises something PPP will not do; offering one as an
  // option for a job that routes off-site runs the in-person booking flow A6
  // exists to replace, and carries A7's mandatory reason into a turn where
  // A32 forbids it — which is how one template breached two rules at once.
  //
  // UNKNOWN ROUTE REFUSES NEITHER. Both rules are gated on knowing what the
  // job is, and a caller that does not track scope should behave as it always
  // has.
  if (ctx.jobRoute && (a.intent === "present_offsite_quote" || a.intent === "offer_offsite_quote")) {
    const wanted = ctx.jobRoute === "offsite" ? "present_offsite_quote" : "offer_offsite_quote";
    if (a.intent !== wanted) {
      return {
        ok: false, reason: "wrong_offsite_rule",
        detail: ctx.jobRoute === "offsite"
          ? "the job routes off-site, so the quick quote is PRESENTED as the plan with no reason attached (A6), not offered as an option"
          : "the job routes on-site, so the quick quote is OFFERED as an option with the reason the customer qualifies (A7), not presented as the plan",
      };
    }
  }

  const supersededBy = ASK_SUPERSEDED_BY[a.intent];
  if (supersededBy && ctx.knownFields && supersededBy.every((f) => ctx.knownFields?.[f])) {
    // A PARTIAL ADDRESS IS NOT AN ADDRESS ON FILE.
    //
    // A11 asks for the missing part only. Refusing the ask outright when we
    // hold a street but no zip is how a conversation stalls holding half an
    // address, so the ask survives here and the renderer narrows it to the
    // gap. Only a complete address supersedes the ask.
    const partial = a.intent === "ask_address" && ctx.addressGap != null && ctx.addressGap !== undefined;
    if (!partial) {
      const names = supersededBy.join(" and ");
      return {
        ok: false, reason: "unknown_intent",
        detail: `${a.intent} was chosen but ${names} is already on file. Read it back instead of asking`,
      };
    }
  }

  if (typeof a.confidence !== "number" || Number.isNaN(a.confidence) || a.confidence < 0 || a.confidence > 1) {
    return { ok: false, reason: "confidence_out_of_range", detail: `confidence ${String(a.confidence)} is not between 0 and 1` };
  }

  const text = (a.freeText ?? "").trim();
  if (text) {
    // The post-filter. Free text exists for "Okay!" and "Got it" — the moment
    // it carries a commitment it stops being rapport.
    if (PRICE.test(text)) {
      return { ok: false, reason: "quoted_a_price", detail: "free text quotes or implies a price; that is the estimator's job" };
    }
    if (OUT_OF_SCOPE.test(text)) {
      const m = OUT_OF_SCOPE.exec(text);
      return { ok: false, reason: "out_of_scope_work", detail: `free text mentions "${m?.[0]}", which PPP does not do` };
    }
    // A time is only allowed if the system supplied it. The model offering one
    // is how a customer ends up waiting for an estimator who was never booked.
    if (TIME_COMMITMENT.test(text) && !hasVerifiedSlot(ctx, "times")) {
      const m = TIME_COMMITMENT.exec(text);
      return { ok: false, reason: "invented_availability", detail: `free text names "${m?.[0]}" with no verified availability behind it` };
    }
    for (const phrase of ctx.hardNoPhrases ?? []) {
      if (!phrase.trim()) continue;
      if (new RegExp(`\\b${escapeRe(phrase.trim())}\\b`, "i").test(text)) {
        return { ok: false, reason: "banned_by_hard_no", detail: `free text contains "${phrase}"` };
      }
    }
  }

  // An intent that proposes times must have times to propose.
  if (a.intent === "ask_availability" && a.slots?.times && !hasVerifiedSlot(ctx, "times")) {
    return { ok: false, reason: "invented_availability", detail: "action proposes times that were not supplied by the system" };
  }

  // Style is the last check, and the only one that drops rapport rather than
  // refusing the action.
  let rapport = text || undefined;
  let droppedRapport: string | undefined;
  if (rapport) {
    const style = checkRapport(rapport, ctx.customerText);
    if (!style.ok) { droppedRapport = style.why; rapport = undefined; }
  }

  return {
    ok: true,
    action: { intent: a.intent as Intent, freeText: rapport, slots: a.slots, confidence: a.confidence },
    droppedRapport,
  };
}

/** Should this action send, or go to a human? */
/**
 * Intents where being wrong costs almost nothing.
 *
 * Asking a lead what they want painted is not a decision — if the model is
 * unsure it is still the right next question, and there is no commitment in it
 * to get wrong. Everything else stays on the strict threshold.
 */
const LOW_STAKES = new Set<string>([
  "ask_project_details", "ask_address", "ask_contact", "ask_availability",
  "confirm_scope", "confirm_address", "confirm_contact",
  "acknowledge", "nurture_check_in", "ask_for_decision", "ask_check_back",
]);

/** Below this even a routine question is not worth sending. */
export const LOW_STAKES_FLOOR = 0.5;

/**
 * Whether a person has to take this over.
 *
 * A flat 0.95 escalated everything. The model reports about 0.90 on a textbook
 * opening question, so the very first turn of every conversation handed to a
 * human — which is not a cautious bot, it is a broken one, and it would have
 * buried the office on day one while teaching Kate that the system does not
 * work.
 *
 * The threshold is about CONSEQUENCE, not correctness. Quoting, ending a
 * conversation, answering a question about scope and offering an off-site
 * quote all commit PPP to something, so they keep the strict setting Kate
 * chose. Asking what someone wants painted commits to nothing.
 */
export function shouldEscalate(action: AgentAction, ctx: ValidateContext = {}): boolean {
  if (action.intent === "escalate") return true;
  const strict = ctx.confidenceThreshold ?? 0.95;
  const threshold = LOW_STAKES.has(action.intent) ? Math.min(strict, LOW_STAKES_FLOOR) : strict;
  return action.confidence < threshold;
}

function hasVerifiedSlot(ctx: ValidateContext, key: string): boolean {
  const v = ctx.verifiedSlots?.[key];
  return Array.isArray(v) ? v.length > 0 : v != null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
