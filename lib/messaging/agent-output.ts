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

/** Emily's terminal states, verbatim. */
export const END_INTENTS = [
  "success", "discard", "schedule_follow_up", "lost", "bailout",
  "phone_pricing", "transferred", "bot_suspected", "msg_liked_loved",
  "area_not_serviced",
] as const;

export const CONTINUE_INTENTS = [
  "ask_project_details", "ask_address", "ask_contact", "ask_availability",
  "acknowledge", "answer_question", "offer_offsite_quote", "escalate",
  // Confirming is a different act from asking, and Kate graded the difference
  // twice. These read a value we already hold back to the customer; they are
  // only offered when that value exists.
  "confirm_scope", "confirm_address", "confirm_contact",
] as const;

/** Which known field an intent reads back, and which ask it replaces. */
export const CONFIRM_REQUIRES: Record<string, "inquiryScope" | "address" | "email"> = {
  confirm_scope: "inquiryScope",
  confirm_address: "address",
  confirm_contact: "email",
};

/** The ask that is forbidden once we hold the value. */
export const ASK_SUPERSEDED_BY: Record<string, "inquiryScope" | "address" | "phone"> = {
  ask_project_details: "inquiryScope",
  ask_address: "address",
};

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
  "offer_estimator_call", "acknowledge", "answer_question", "escalate",
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
  | { ok: true; action: AgentAction }
  | { ok: false; reason: RejectReason; detail: string };

export type RejectReason =
  | "unknown_intent"
  | "confidence_out_of_range"
  | "commitment_in_free_text"
  | "out_of_scope_work"
  | "quoted_a_price"
  | "invented_availability"
  | "banned_by_hard_no";

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
  knownFields?: Partial<Record<"name" | "phone" | "email" | "address" | "inquiryScope", boolean>>;
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

  // Confirming something we do not have would invent it.
  const needs = CONFIRM_REQUIRES[a.intent];
  if (needs && ctx.knownFields && !ctx.knownFields[needs]) {
    return { ok: false, reason: "unknown_intent", detail: `${a.intent} needs a known ${needs} and there is none on file` };
  }
  // Asking for something we already hold. Kate: "asked customer for phone
  // number + to type out phone number" — the reason that reached her was a
  // prompt instruction, which the model ignored. This is not an instruction.
  const supersededBy = ASK_SUPERSEDED_BY[a.intent];
  if (supersededBy && ctx.knownFields?.[supersededBy]) {
    return {
      ok: false, reason: "unknown_intent",
      detail: `${a.intent} was chosen but ${supersededBy} is already on file — read it back instead of asking`,
    };
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

  return { ok: true, action: { intent: a.intent as Intent, freeText: text || undefined, slots: a.slots, confidence: a.confidence } };
}

/** Should this action send, or go to a human? */
export function shouldEscalate(action: AgentAction, ctx: ValidateContext = {}): boolean {
  if (action.intent === "escalate") return true;
  const threshold = ctx.confidenceThreshold ?? 0.95;
  return action.confidence < threshold;
}

function hasVerifiedSlot(ctx: ValidateContext, key: string): boolean {
  const v = ctx.verifiedSlots?.[key];
  return Array.isArray(v) ? v.length > 0 : v != null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
