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
  // A2's SECOND script, and the only one that ends anything. It is reached
  // only when the project really is in a state PPP does not cover.
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
  // A33: DEFER, AND KEEP GOING. "Defer a question you genuinely cannot answer
  // to the estimator — and keep the conversation going. Deflecting is
  // correct; ENDING the conversation in order to deflect is not."
  //
  // There was no way to say this. escalate hands the whole conversation to a
  // person and reads as a close, and every other outlet either answers or
  // asks. The commonest case by far is the calendar: "you suggest a time and
  // date", "what is available", "are you available tomorrow morning". The bot
  // has no calendar and never books, so it cannot answer and must not invent
  // one, and the only two moves available were to end or to ignore.
  "defer_to_estimator",
  // A2's FIRST script. "If the zip does NOT resolve to a Zip_Code__c row, OR
  // its Service Territory is INACTIVE or named 'Out of Area', SAY SOMETHING
  // LIKE: 'Just a moment, I'm checking availability.', then hand off — a
  // human must check with the estimator before any coverage is promised."
  //
  // Not an ending. The conversation stays open and a person picks it up,
  // which is the difference between this and area_not_serviced.
  "checking_availability",
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
  // A29 and A33 bind here too. Somebody holding a quote asks about prep,
  // timing and what is included constantly, and "at ANY point" includes a
  // conversation that started after the estimator had already visited.
  "answer_question", "defer_to_estimator", "escalate",
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

/**
 * WHAT EACH INTENT IS FOR, in the words the model sees.
 *
 * The tool schema handed over the enum and nothing else: twenty-five bare
 * names, described only as "What to do next." So the model had to infer
 * schedule_follow_up and transferred from the strings themselves, and it
 * does not. Played as a customer in the simulator:
 *
 *   "dont text me just call me"  ->  ask_availability, refused out_of_order,
 *                                    customer got nothing. Kate's tag says a
 *                                    callback ends as Schedule Follow-up
 *                                    rather than continuing to text.
 *   "Hola, necesito pintar mi casa. No hablo ingles."
 *                                ->  answered in English and carried on. Her
 *                                    tag says another language means
 *                                    transferring, today.
 *
 * Every line below is the intent's own template said plainly, or Kate's tag
 * where there is one, so this describes what the system already does rather
 * than inventing new behaviour.
 */
export const INTENT_GUIDE: Record<string, string> = {
  // Collecting, in order
  ask_project_details: "ask what they want painted, when nothing on file says",
  ask_address: "ask where the job is",
  ask_contact: "ask for a name and email",
  ask_availability: "ask which days suit them",
  confirm_scope: "read the job back from the RECORD for a yes. Never for something they just typed",
  confirm_address: "read the address on file back for a yes",
  confirm_contact: "read the phone and email on file back for a yes",

  // Keeping it moving
  acknowledge: "say you have it and nothing more",
  acknowledge_negative: "they are annoyed or you repeated yourself; apologise once and move on",
  answer_question: "answer what they asked, in freeText, then keep going",
  defer_to_estimator: "they want something only the estimator decides, including any price",
  checking_availability: "you are looking something up and will come back",

  // The off-site quote
  present_offsite_quote: "this job does not need a visit, so offer the quick quote",
  offer_offsite_quote: "a visit is normal for this job but something stops it, and the reason must be on file",

  // Handing over and ending
  escalate: "you are not sure, or it needs a person for any other reason",
  transferred: "hand straight to the office. Use this for a text-only preference, a request to meet at the office, or a language we cannot write. NOT for Spanish: we answer Spanish ourselves now (A30), so transferring a Spanish speaker is a defect",
  schedule_follow_up: "they asked to be CALLED, or to be contacted later. Stop texting and end here",
  bot_suspected: "they asked whether they are talking to a bot or a person",
  phone_pricing: "they want to talk money on the phone",
  area_not_serviced: "the zip on file is somewhere PPP does not cover",
  bailout: "they have said they are not going ahead",
  success: "everything is collected and the office can take it",
  discard: "not a real lead",
  lost: "they have gone with somebody else",
  msg_liked_loved: "they reacted to a message rather than replying, and nothing needs saying",

  // Nurture only
  accepted: "they have said yes to the quote",
  nurture_check_in: "nothing has happened for a while; check in about the quote",
  ask_for_decision: "ask whether they have decided",
  ask_check_back: "ask when to check back",
  offer_estimator_call: "offer to have the estimator call and walk through it",
};

/** The guide for one track, as the lines the schema shows. */
export function intentGuideFor(track: Track): string {
  return intentsForTrack(track)
    .map((i) => `- ${i}: ${INTENT_GUIDE[i] ?? "(no guidance written for this intent)"}`)
    .join("\n");
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
  | "wrong_offsite_rule"      // presented what should be offered, or the reverse
  | "coverage_not_established"
  | "question_left_unanswered"
  | "details_never_collected";    // presented what should be offered, or the reverse

/**
 * Phrases that mean the model has committed to something it has no authority
 * to commit to. Deliberately blunt: a false positive costs one regenerated
 * draft, a false negative sends a customer a price PPP never agreed.
 */
const PRICE = new RegExp(
  [
    String.raw`\$\s?\d`,                                   // $2500, $ 2500
    String.raw`\b\d[\d,]*\s?(?:dollars?|bucks|usd|k\b|grand)`, // 2500 dollars, 4k, 3 grand
    String.raw`\busd\s?\d`,
    // A money word followed by ANY amount, however it is introduced. The old
    // version listed the introducers — is, will be, starts at, around, about —
    // so "costs run about 1800" and "price: 2500" both went straight through.
    String.raw`\b(?:costs?|pric\w*|quotes?|charges?|estimates?|rates?|fee)\b[^.!?]{0,24}\d`,
    // …and an amount followed by a money word, which is the other order.
    String.raw`\d[^.!?]{0,16}\b(?:per hour|an hour|per room|a room|per square|per sq)\b`,
    // Written amounts. "roughly fifteen hundred" carries no digit at all.
    String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(?:hundred|thousand|grand|k)\b`,
    // A WRITTEN NUMBER MEETING A CURRENCY WORD, which the line above misses
    // because it only looks for a MAGNITUDE after the number. "fifty dollars"
    // is as much a quote as "$50", and it went straight through: probed with
    // twenty-one plausible prices this was the one that got out, and
    // "fifty dollars", "twenty bucks" and "a hundred bucks" with it.
    String.raw`\b(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|couple|few)\s+(?:hundred\s+|thousand\s+)?(?:dollars?|bucks|usd|quid)\b`,
    // "a grand", "a few grand", "a couple hundred" — no digit, no currency
    // word, still a number the estimator never agreed to.
    //
    // Only at the end of the clause. Without that it ate "a hundred percent"
    // and "we cover a few hundred zip codes", which is the failure mode this
    // whole filter is supposed to be careful about: over-blocking costs a
    // regenerated draft, but it costs it on ordinary sentences, every time.
    // Anything followed by a currency word is already caught above.
    String.raw`\b(?:a|an|another)\s+(?:couple|few)?\s*(?:hundred|thousand|grand)(?=\s*(?:[.,!?;]|$))`,
    // Per-unit rates written out. Cabinet work is quoted per door, so this is
    // the shape a cabinet price actually takes.
    String.raw`\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(?:a|per|each)\b`,
  ].join("|"),
  "i"
);

/**
 * A NUMBER IN RAPPORT IS A COMMITMENT UNTIL PROVEN OTHERWISE.
 *
 * The two filters above list the shapes a price or a time takes, and a list
 * of shapes is a list of the ones somebody thought of. Probed against eleven
 * plausible prices and twelve plausible times, the originals let EVERY ONE
 * through: "it will be around 2500", "ballpark 2200", "we charge 95 per
 * hour", "Mon at 2", "we can come at noon", "the 15th".
 *
 * So this is the backstop, and it runs the other way round. Rapport exists
 * for "Got it" and "Happy to help with that" — sentences that do not contain
 * numbers. Every value a customer should see comes from a template slot the
 * system filled, never from here.
 *
 * Dropping rapport costs a slightly warmer message and nothing else, because
 * the template still carries the turn. Letting "around 2500" through is a
 * promise PPP has to keep or explain.
 */
const NUMBER_IN_RAPPORT = /\d/;

/** A specific time or date. The model may never offer one — Emily's prompt is
 *  explicit: "Never offer, confirm, or suggest appointment times yourself." */
const TIME_COMMITMENT = new RegExp(
  [
    String.raw`\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b`,
    String.raw`\b\d{1,2}\s?o'?clock\b`,
    // ABBREVIATIONS TOO. The old pattern demanded the full word, so "Tues at
    // 3" and "first thing Mon" were not times as far as it was concerned.
    String.raw`\b(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)\b\.?`,
    String.raw`\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b`,
    String.raw`\b(?:today|tomorrow|tmrw|tonight)\b`,
    String.raw`\b(?:this|next|following)\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening)\b`,
    String.raw`\bin the (?:morning|afternoon|evening)\b`,
    String.raw`\b(?:noon|midday|first thing|end of the (?:day|week))\b`,
    String.raw`\bthe \d{1,2}(?:st|nd|rd|th)\b`,
    String.raw`\b\d{1,2}\s*/\s*\d{1,2}\b`,
    String.raw`\ba week from\b`,
  ].join("|"),
  "i"
);

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

/**
 * THE REST OF WHAT THE CONFIGURATION SAYS PPP DOES NOT SERVICE.
 *
 * The "What we do not cover" box on the Chatbot screen names seven things.
 * The list above covered four of them, so "we can paint your furniture", "we
 * can refinish the bookcase", "we can coat your industrial equipment" and
 * "we can do artistic painting" all went out unrefused — the mirror of the
 * flooring bug, and the same root: a configured list and a hardcoded one that
 * never met.
 *
 * BUILT-IN IS NOT STANDALONE. The configuration is precise about it —
 * "furniture, including bookcases and shelving that are STANDALONE rather
 * than built in" — and PPP paints built-in shelving all day. A bare noun here
 * would refuse the work it actually sells, which is exactly the mistake the
 * trades list made with windows and roofs.
 */
const OUT_OF_SCOPE_ITEMS =
  /\b(?<!built[-\s]?in\s)(?:furniture|bookcases?|shelving|shelves)\b|\bindustrial\s+(?:equipment|machinery)\b|\b(?:artistic|graphic)\s+painting\b/i;
const OUT_OF_SCOPE_TRADES =
  /\b(?:roofing|roof repair|plumbing|electrical|electrician\w*|hvac|landscap\w*|masonry|paving|re-?roof\w*|concrete|driveways?|foundations?|window replacement|siding install\w*|reupholster\w*)\b/i;
/**
 * THE SAME BUG THE SURFACES LIST ALREADY FIXED, LEFT IN THE TRADES LIST.
 *
 * The note above says the first version required "bathtub refinishing" in that
 * order and let "refinish the bathtub" straight through, so surfaces became
 * bare nouns. Trades never got the same treatment: "window replacement" is
 * still order-bound, so "we can replace the windows" went out unrefused, and
 * so did "we install flooring" and "we can fix the roof leak".
 *
 * These cannot be bare nouns. PPP paints window trim, door frames and the
 * boards under a roof line, so "window", "floor" and "roof" on their own would
 * refuse the work it actually sells. The verb is what makes it somebody else's
 * trade: painting a window is the job, replacing one is not.
 *
 * Probed with fourteen plausible out-of-scope promises, the list above caught
 * six. With this it catches fourteen, and seven legitimate painting sentences
 * still pass.
 */
const OUT_OF_SCOPE_VERBS =
  /\b(?:replac\w*|install\w*|re-?wir\w*|repair\w*|fix(?:ing)?|pour\w*|lay(?:ing)?)\s+(?:\w+\s+){0,2}(?:windows?|roofs?|carpet\w*|tiles?|gutters?|sidings?|foundations?|driveways?|wiring|plumbing|electrics?)\b/i;
//
// FLOOR IS NOT IN THAT LIST, and it was until this line. sms_services has a
// row `flooring`, covered_by_default true, and every workspace ticks it. So
// the prompt tells the model flooring is covered, the model says so, and a
// hardcoded regex three files away refused the turn — a correct answer turned
// into a handover.
//
// The rule this breaks is bigger than the word: THE HARDCODED LIST MUST NEVER
// CONTRADICT THE CONFIGURED ONE. Services are per workspace and editable on
// the Chatbot screen; this filter is global and editable only here. Where they
// disagree the configuration wins, because somebody chose it. Checked against
// the live table in verify-workspace-config-e2e.
const OUT_OF_SCOPE = new RegExp(
  [OUT_OF_SCOPE_SURFACES.source, OUT_OF_SCOPE_ITEMS.source, OUT_OF_SCOPE_TRADES.source, OUT_OF_SCOPE_VERBS.source].join("|"),
  "i"
);

/**
 * THE RULE IS AGAINST PROMISING IT, NOT AGAINST NAMING IT.
 *
 * Every list above matched a bare mention, so the bot could not say "we do
 * not do roofing" — the sentence names roofing, and naming it was the whole
 * test. It could not decline ANY out-of-scope job in words, which is the one
 * thing the configuration explicitly tells it to do: "say we cannot help with
 * this project but will circle back if that is wrong."
 *
 * Caught in the simulator playing a customer asking about furniture. The
 * model tried to turn the work down and its reply was refused as
 * out_of_scope_work for containing the word "furniture". Pre-existing —
 * bathtubs, murals and roofing all behaved the same way — and adding
 * furniture to the list is what made it visible, because declining furniture
 * is a thing customers actually ask for.
 *
 * CLAUSE BY CLAUSE, not sentence by sentence. "We do not do murals, but we
 * can paint your appliances" carries a decline AND a promise; taking the
 * negation from anywhere in the sentence would wave the promise through, so
 * "but" and "however" break a clause exactly as a full stop does.
 */
// ANY n't CONTRACTION, AND THE CURLY APOSTROPHE TOO. The list used to name
// don't and can't and missed isn't, which is the word the model actually
// reached for — "Furniture painting isn't something we do" — and a phone
// keyboard types ’ rather than '. The apostrophe is REQUIRED in that branch
// so "front" does not read as a negation.
const DECLINING =
  /\b(?:not|never|cannot|unable|outside|beyond|unfortunately|sorry|afraid)\b|\b\w+n['’]t\b/i;
const CLAUSE_BREAK = /[.!?;]|\bbut\b|\bhowever\b|\bthough\b/gi;

/**
 * The promise, if there is one: the banned word AND the clause it sits in.
 *
 * The clause is returned because the rejection used to read `free text
 * mentions "furniture"` and nothing else — so the person reading it could see
 * that a draft was blocked but never what the draft SAID, which on a training
 * screen is the only part worth knowing. It also cost me two rounds of
 * guessing at which sentence shape was failing.
 */
export function outOfScopePromise(text: string): { word: string; clause: string } | null {
  // Where each clause starts, so a mention can be read with its own words only.
  const breaks: number[] = [0];
  for (let m; (m = CLAUSE_BREAK.exec(text)); ) breaks.push(m.index + m[0].length);
  CLAUSE_BREAK.lastIndex = 0;

  const finder = new RegExp(OUT_OF_SCOPE.source, "gi");
  for (let m; (m = finder.exec(text)); ) {
    const start = breaks.filter((b) => b <= m.index).pop() ?? 0;
    const end = breaks.find((b) => b > m.index) ?? text.length;
    // THE WHOLE CLAUSE, NOT JUST WHAT CAME BEFORE.
    //
    // Reading backwards only caught "we do not paint furniture" and missed
    // "Furniture painting isn't something we do" — where the noun opens the
    // sentence and the negation follows it. Seen in the simulator, which
    // reported the block on "Furniture" with a capital F: the model had led
    // with the word, and there was nothing behind it to read.
    const clause = text.slice(start, end)
      // "not a problem" is an agreement, not a refusal, and it is the
      // commonest way to say yes to a job. Removed before asking.
      .replace(/\bnot a problem\b|\bno problem\b|\bno worries\b/gi, " ");
    if (!DECLINING.test(clause)) return { word: m[0], clause: text.slice(start, end).trim() };
  }
  return null;
}

/**
 * Does the CUSTOMER's message name work PPP does not cover?
 *
 * A bare mention, deliberately — the opposite of the promise test above. When
 * WE say "furniture" the question is whether we are promising it; when THEY
 * say it, naming it is the whole signal. This is what separates Kate's two
 * discards: "not an estimate request" (a wrong number, and silence is right)
 * from "work we do not cover" (a real customer owed an answer).
 */
export function mentionsWorkWeDoNotDo(text: string | null | undefined): boolean {
  return !!text && OUT_OF_SCOPE.test(text);
}

/** True when the text PROMISES work PPP does not do. A refusal is not a promise. */
export function promisesOutOfScopeWork(text: string): boolean {
  return outOfScopePromise(text) !== null;
}

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

  /**
   * A REFUSAL HAS TO NAME THE THING IT IS REFUSING.
   *
   * A9 stops the bot reading the customer's scope back at them as a
   * confirmation. It is not about the word appearing at all — and a decline
   * cannot avoid it: the customer asks about furniture, and the only honest
   * answer contains the word furniture.
   *
   * This was the THIRD guard in a row to block the same refusal. The
   * out-of-scope list blocked it for naming furniture, then this dropped it
   * for echoing, and with the answer dropped the turn was refused again as
   * question_left_unanswered. Each guard was written for a bot trying to
   * SELL; none of them expected it to say no, which is the one thing the
   * configuration requires for uncovered work.
   */
  const refusingWorkWeDoNotDo = DECLINING.test(text) && OUT_OF_SCOPE.test(text);

  if (!refusingWorkWeDoNotDo && customerText && longestSharedRun(text, customerText) >= ECHO_WORDS) {
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

/**
 * Intents that ANSWER something by their nature, so they need no rapport to
 * satisfy A29.
 *
 * answer_question is the answer. The two off-site turns respond to what the
 * customer asked about getting quoted. defer_to_estimator is A33's reply to a
 * question we cannot answer, which is still an answer. The confirm_* turns
 * read a value back, which answers "do you have my details". escalate hands
 * the question to a person, which is the honest answer when there is none.
 */
const ANSWERS_A_QUESTION = new Set<string>([
  "answer_question", "defer_to_estimator", "escalate",
  "present_offsite_quote", "offer_offsite_quote",
  "confirm_scope", "confirm_address", "confirm_contact",
  "phone_pricing", "offer_estimator_call", "acknowledge_negative",
  "area_not_serviced", "transferred", "accepted", "success",
]);

/**
 * Did the customer actually ask something?
 *
 * A question mark is the reliable signal and nearly everyone uses one. The
 * bare-word forms are here for the ones who do not: "what time" and "how much"
 * are questions with or without the punctuation. Deliberately NOT matching a
 * lone "can you" or "do you", which open plenty of statements.
 */
const QUESTION_WORD =
  /\b(?:what|when|where|which|who|why|how)\b[^.!?]{0,40}\?|\?/;
const BARE_QUESTION =
  /\b(?:how much|how many|how long|what time|what days?|when can|when will|when would|are you able|can you tell|do you (?:do|offer|handle|cover))\b/i;

/**
 * Rapport that acknowledges and says nothing else.
 *
 * "Got it", "Perfect, thanks", "Sorry about that". A29 asks whether a direct
 * question was answered, and the first version of that check accepted ANY
 * rapport — so "Do you do cabinets as well?" answered with "Got it. Where's
 * the property located?" passed, which is the defect the rule describes,
 * wearing a politeness.
 *
 * Found by walking conversations through the pipeline and reading them, not
 * by a test. Every test asserted the right words were present, and they were.
 */
export const BARE_ACKNOWLEDGEMENT =
  /^(?:(?:got it|perfect|great|thanks|thank you|understood|no problem|sounds good|okay|ok|sure|absolutely|of course|will do|noted|happy to help|sorry(?: about that)?|apologies|my apologies)[\s,.!]*)+$/i;

export function asksSomething(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return QUESTION_WORD.test(t) || BARE_QUESTION.test(t);
}

/**
 * A3: the three things that must be collected or confirmed before the bot can
 * call a conversation finished.
 *
 * "collect/confirm the project details, full address, and contact information
 * (email and phone)... this rule is strictly about ensuring that this
 * information is collected."
 *
 * Each leg is satisfied by an EVENT, not by the state of the record, and that
 * is Kate's own emphasis: "HOLDING IS NOT CONFIRMING. Where the record already
 * holds the address and contact IN FULL, the obligation is NOT satisfied by
 * holding them — confirm them once with the customer before the conversation
 * ends. The confirmation is an EVENT IN THE CONVERSATION, not a state of the
 * record." So asking counts and reading it back counts; quietly having it
 * does not.
 *
 * Asking also covers the refusal carve-out without needing to detect one.
 * Where a customer refuses to give a street and that refusal is honoured
 * (A41), ask_address still happened, so this stays satisfied and the refusal
 * is governed by its own rule rather than by this one.
 */
const A3_LEGS: { label: string; satisfiedBy: readonly string[] }[] = [
  { label: "project details", satisfiedBy: ["ask_project_details", "confirm_scope"] },
  { label: "the full address", satisfiedBy: ["ask_address", "confirm_address"] },
  { label: "contact details", satisfiedBy: ["ask_contact", "confirm_contact"] },
];

/**
 * Endings that CLAIM the flow finished, and so owe all three.
 *
 * Deliberately short. "WHERE THIS DOES NOT FIRE: a customer who DECLINES
 * (A17) or DEFERS (A40) ends the collection obligation at that turn. A bot
 * that stops collecting after 'no thanks', 'I'm not interested', 'I hired
 * someone' or 'I'll reach out later' is CORRECT and carries no A3 defect."
 *
 * Every one of those outcomes has its own intent — bailout, lost, discard,
 * schedule_follow_up — so the carve-out is structural here rather than
 * something this has to detect. Kate measured what happens without it: 8 of
 * 49 rows are exactly that shape, and the rule would have fired a critical on
 * every one, flipping 6 rows from good to bad.
 *
 * phone_pricing IS included, on her instruction: "A Phone Pricing is NOT that
 * [a deferral]: the quote going out by text or phone still requires all three
 * here." transferred is not, because a person has taken the conversation and
 * finishes the collection themselves.
 */
const CLAIMS_THE_FLOW_FINISHED = new Set<string>(["success", "phone_pricing"]);

/**
 * Intents that promise PPP will do the work.
 *
 * Booking, quoting and closing all say we cover this address. Asking for
 * details does not, and is deliberately absent: A2's own out-of-state script
 * asks whether the project is somewhere else, which cannot happen if the
 * conversation is not allowed to continue.
 */
const PROMISES_COVERAGE = new Set<string>([
  "ask_availability", "present_offsite_quote", "offer_offsite_quote",
  "success", "phone_pricing", "accepted", "offer_estimator_call",
]);

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
  /**
   * What the service-area lookup says about the zip we are holding RIGHT NOW.
   *
   * A2: "Validate the zip against the service area BEFORE promising
   * coverage." Intake already refuses to start a conversation for an
   * unserviceable lead, so this is for the zip that CHANGES — the customer
   * who gives a New Jersey address while FL 33308 sits on the record.
   *
   * Undefined when the map cannot be read, which is deliberately the same as
   * "we do not know" rather than "not serviced": telling a customer we do not
   * cover them because our own lookup failed is the harm the rule exists to
   * prevent.
   */
  serviceArea?: "serviced" | "out_of_state" | "needs_a_person" | null;
  /** What the customer just said, so rapport can be checked for echoing it. */
  customerText?: string;
  /** The customer reacted negatively to the previous message. */
  negativeReaction?: boolean;
  /** What we said last, so the same thing is not said straight back. */
  lastIntent?: string;
  /**
   * Every intent this conversation has already used, oldest first.
   *
   * A3 is satisfied by events rather than by the state of the record, so the
   * only way to answer it is to know what has actually been asked and
   * confirmed. Undefined disables the check, which is what a caller that does
   * not track a conversation wants.
   */
  priorIntents?: readonly string[];
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
  // A3: THE HANDOFF TURN CARRIES THE COLLECTION FAILURE.
  //
  // "Where details were never collected or confirmed, the defect sits on the
  // turn where the bot handed off or closed — the sign-off, whichever came
  // last. That is the last moment it could have happened."
  //
  // So this is checked exactly there, on the turn that claims the flow
  // finished. Escalating rather than refusing outright, because the model may
  // be right that the conversation is over and a person can see in seconds
  // which leg was skipped; refusing would send it round to choose again with
  // the same information.
  //
  // THE OFF-SITE PATH DOES NOT RELEASE THIS. "Even when an off-site quote is
  // suggested or required, you must still collect Project Details, Full
  // Address and Contact Information."
  if (ctx.priorIntents && CLAIMS_THE_FLOW_FINISHED.has(a.intent)) {
    const seen = new Set([...ctx.priorIntents, a.intent]);
    const missing = A3_LEGS.filter((leg) => !leg.satisfiedBy.some((i) => seen.has(i)));
    if (missing.length) {
      return {
        ok: false, reason: "details_never_collected",
        detail: `this closes the conversation but ${missing.map((m) => m.label).join(" and ")} ` +
          `${missing.length === 1 ? "was" : "were"} never asked for or confirmed`,
      };
    }
  }

  // A2: NOTHING PROMISES COVERAGE UNTIL THE ZIP SAYS WE HAVE IT.
  //
  // "Validate the zip against the service area BEFORE promising coverage."
  // Booking a visit, presenting a quote or calling the conversation a success
  // all promise it. Asking for details does not, and must stay allowed — the
  // whole point of A2's second script is to ASK whether the project is
  // somewhere else, which needs the conversation to continue.
  //
  // needs_a_person covers the zip being unknown AND the map being unreadable,
  // and both land on checking_availability, which hands to a human. Telling a
  // customer we do not cover them because our own lookup failed is the harm
  // the rule exists to prevent.
  if (ctx.serviceArea && ctx.serviceArea !== "serviced" && PROMISES_COVERAGE.has(a.intent)) {
    return {
      ok: false, reason: "coverage_not_established",
      detail: ctx.serviceArea === "out_of_state"
        ? "the zip on file is outside the states PPP covers, so nothing may promise a visit or a quote until they confirm the project is elsewhere"
        : "the service area could not be confirmed for this zip, so a person checks with the estimator before any coverage is promised",
    };
  }

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
    const promise = outOfScopePromise(text);
    if (promise) {
      return {
        ok: false,
        reason: "out_of_scope_work",
        // The sentence, not just the word. Blocked drafts are what this
        // screen exists to show.
        detail: `it promises "${promise.word}", which PPP does not do, in: "${promise.clause}"`,
      };
    }
    // A time is only allowed if the system supplied it. The model offering one
    // is how a customer ends up waiting for an estimator who was never booked.
    if (TIME_COMMITMENT.test(text) && !hasVerifiedSlot(ctx, "times")) {
      const m = TIME_COMMITMENT.exec(text);
      return { ok: false, reason: "invented_availability", detail: `free text names "${m?.[0]}" with no verified availability behind it` };
    }
    // THE BACKSTOP. Anything numeric the two lists above did not recognise.
    // Rapport is "Got it" and "Happy to help"; every value the customer
    // should see is filled into a template by the system.
    //
    // A VERIFIED TIME EXCUSES ITSELF AND NOTHING ELSE. Where the system has
    // handed the model a real appointment time, "Does 2pm work?" is the model
    // using what it was given. So the time-shaped tokens are removed and the
    // rest of the sentence is still checked — "around 2500 at 2pm" keeps its
    // 2500 and is still refused. Exempting the whole sentence would have made
    // a verified time a licence to say any number at all.
    const unexplained = hasVerifiedSlot(ctx, "times")
      ? text.replace(/\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi, " ")
      : text;
    if (NUMBER_IN_RAPPORT.test(unexplained)) {
      return {
        ok: false, reason: "commitment_in_free_text",
        detail: "free text contains a number, and every number a customer sees comes from a template rather than from the model",
      };
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

  // A29: A DIRECT QUESTION IS NEVER LEFT UNANSWERED.
  //
  // "Answer a direct question the customer asks — at ANY point, not only
  // before closing." 31 breaches, critical, and the correction on 28 of them
  // is the same sentence: "answered the direct question, at whatever point in
  // the conversation it was asked."
  //
  // The architecture already has the right shape. Kate's model answer is
  // "Absolutely. What time works best for you?" — an answer, then the next
  // step. Here the answer is the RAPPORT and the next step is the TEMPLATE.
  // So a turn that asks the next question while carrying no answer at all,
  // with a question outstanding, is that defect exactly.
  //
  // Escalating rather than refusing: the model has judged what to do next and
  // may well be right about it, and refusing would loop it into choosing
  // again from the same information. A person reading the thread can see the
  // question and answer it in seconds. This also catches the case where an
  // answer WAS written and the style filter dropped it, which leaves the
  // question just as unanswered as never writing one.
  // A BARE ACKNOWLEDGEMENT IS NOT AN ANSWER. "Got it." in front of the next
  // question is the shape A29 exists to catch, and accepting any rapport at
  // all let it straight through.
  const saysSomething = !!rapport && !BARE_ACKNOWLEDGEMENT.test(rapport.trim());
  const answersIt = ANSWERS_A_QUESTION.has(a.intent) || saysSomething;
  if (ctx.customerText && asksSomething(ctx.customerText) && !answersIt) {
    return {
      ok: false, reason: "question_left_unanswered",
      detail: droppedRapport
        ? `the customer asked something and the answer was dropped because ${droppedRapport}`
        : "the customer asked something and this turn only asks the next question back",
    };
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
  // A2: "a human must check with the estimator before any coverage is
  // promised." The message buys a moment; the hand-off is the point of it,
  // so this escalates whatever the model's confidence was.
  if (action.intent === "checking_availability") return true;
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
