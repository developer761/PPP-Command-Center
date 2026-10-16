/**
 * A40 — PARK THE OPEN ITEM, AND KNOW WHICH KIND OF PARK IT IS.
 *
 * Kate's statement: "When the customer has to come back to us with
 * information they do not have right now, gather everything else and PARK the
 * conversation." Critical, binding.
 *
 * ── TWO SITUATIONS, AND KATE SAYS DO NOT MERGE THEM ─────────────────────
 *
 * She gives the test in one line:
 *
 *   "is the missing thing a FIELD they cannot fill right now, or the
 *    CONVERSATION they are postponing? Field -> collect the rest.
 *    Conversation -> stop."
 *
 * and names the opposite failure for each:
 *
 *   FIELD   "I need my kitchen painted, and maybe more but I'm not sure" ·
 *           "I'm available in March but need to talk with my wife".
 *           THE FAILURE IS CLOSING HAVING GATHERED NOTHING. Park the one
 *           field, keep going on everything else.
 *
 *   CONVERSATION  they are moving the booking to another time or channel.
 *           THE FAILURE IS CARRYING ON COLLECTING — "pressing, 'I really
 *           can't move forward without it.'" Acknowledge, park, leave it.
 *
 * Because the two failures are opposites, a detector that cannot tell them
 * apart is worse than none: it will nag the person who deferred and abandon
 * the person who just did not know one answer.
 *
 * ── TWO BOUNDARIES THAT ARE EASY TO GET WRONG ───────────────────────────
 *
 * 🔴 AGAINST A17. Kate: "parking is not stopping. A customer postponing the
 * CONVERSATION still wants the work — acknowledge, park, and leave the door
 * open. A customer who is not going ahead at all has DECLINED, which is A17…
 * Wrong one and you either nag someone who said no, or abandon someone who
 * said later." So a decline must NOT read as a park; DECLINED below returns
 * null and lets A17 own it.
 *
 * 🔴 AGAINST A7 / PHONE PRICING. Kate: "THIS IS A CARVE-OUT ON THE DEFERRAL,
 * NOT ON THE QUOTE-DELIVERY CHANNEL. A customer taking the QUOTE by phone or
 * text is a Phone Pricing and still owes project details, full address and
 * contact (A3). Only moving the BOOKING conversation stops collection."
 * So "just text me the quote" is not a park at all.
 *
 * ── WHAT HATCH DOES, FOR REFERENCE ──────────────────────────────────────
 *
 * Its live prompt has the field case almost word for word: "If the customer
 * explicitly says they do not know their availability or are waiting on
 * someone else … Confirm their project details, full address, and contact
 * info as usual. Skip asking availability. After confirming … → End:
 * Schedule Follow Up." Same shape as (1). See HATCH_LIVE_PROMPT_2026_09_26.md.
 *
 * Pure. No clock, no database.
 */

export type ParkKind =
  /** One answer they do not have yet. Collect everything else. */
  | "field"
  /** The booking conversation itself, moved. Stop collecting. */
  | "conversation";

/**
 * NOT GOING AHEAD. A17's territory, checked first so a decline can never be
 * mistaken for a park.
 *
 * "We actually found someone" and "we went another way" are declines that
 * carry none of the usual words, and Kate flagged exactly that on
 * 2026-09-18: "A DECLINE IS NOT ALWAYS WORDED AS ONE… a keyword sweep for
 * this missed exactly that one."
 */
const DECLINED_WORDS =
  /\b(?:not\s+interested|no\s+thanks?|already\s+(?:hired|booked|found|got)|went\s+(?:with|another)|found\s+(?:someone|somebody|another)|hired\s+(?:someone|somebody)|going\s+(?:with|in)\s+another|changed\s+(?:my|our)\s+mind|decided\s+(?:not|against)|not\s+moving\s+forward|hold(?:ing)?\s+off|pass\s+(?:for\s+now|on\s+(?:this|it))|do\s?n'?t\s+need\s+it\s+(?:any\s*more|now)|no\s+longer\s+(?:need|interested))\b/i;

/**
 * …BUT NOT WHEN THEY GO ON TO SAY WHAT THEY DO STILL WANT.
 *
 * Narrowing the job uses the same words as declining it:
 *
 *   "we decided not to paint the exterior, just inside"   narrowing
 *   "no thanks to the cabinets, just the rooms"           narrowing
 *   "we decided not to move forward, we hired someone"    a real decline
 *
 * The first two name work they still want; a real decline names none. Both
 * halves matter and they fail in opposite directions — reading a narrowing
 * as a decline abandons a live job, and reading a decline as a narrowing
 * keeps chasing somebody who already said no.
 *
 * Measured 2026-10-14 against the previous pattern, which MISSED "we're not
 * moving forward" — A17's own wording — along with "holding off", "pass for
 * now" and "don't need it any more, and read both narrowings above as
 * declines.
 */
const STILL_WANTS =
  /\b(?:just|only|still)\b[^.!?]{0,30}\b(?:the\s+)?(?:inside|outside|interior|exterior|walls?|ceilings?|rooms?|kitchen|bath\w*|bedrooms?|hall\w*|trim|cabinets?|doors?|floors?)\b/i;

/**
 * KATE'S OWN THREE EXAMPLES, AND SPANISH. 2026-10-16.
 *
 * A17's card names exactly three declines — "no, I'll do the project
 * myself" · "I'm all set, thank you" · "probably not" — and the pattern above
 * caught none of them, so ask_contact stayed legal after every one. Spanish
 * had no decline at all: "no gracias" and "no me interesa" were read as
 * nothing, and the bot kept collecting from somebody who had said no.
 *
 * "probably not" is anchored to the WHOLE answer (optionally with thanks),
 * because "probably not until March" is a deferral, A40's, and "probably not
 * the ceilings" is a narrowing. Doing it ourselves needs the WHOLE job as
 * the object — "do it / the project myself", Spanish "lo voy a hacer yo
 * mismo" — because "I'll paint the trim myself, you do the walls" is a
 * narrowing with no "just" in it for STILL_WANTS to see.
 */
const DECLINED_WORDS_MORE = new RegExp(
  [
    String.raw`\b(?:i['’]?ll|i\s+will|we['’]?ll|we\s+will|i['’]?m\s+going\s+to|we['’]?re\s+going\s+to|gonna)\s+(?:just\s+)?(?:do|paint|handle|tackle|take\s+care\s+of)\s+(?:it|this|that|everything|the\s+(?:whole\s+)?(?:project|job|work|painting|thing))\s+(?:all\s+)?(?:myself|ourselves|by\s+(?:myself|ourselves))\b`,
    String.raw`^\s*(?:no[,.]?\s+)?probably\s+not\s*(?:[.!]+\s*)?(?:,?\s*(?:thanks?|thank\s+you)\b[.!]*)?\s*$`,
    // Spanish.
    String.raw`\bno,?\s+gracias\b`,
    String.raw`\b(?:ya\s+)?no\s+(?:me|nos)\s+interesa\b`,
    String.raw`\bya\s+no\b(?:\s*(?:[,.!]|$)|\s+(?:gracias|(?:lo|la|los|las)\s+necesit\w*|(?:me|nos)\s+hace\s+falta|(?:vamos|voy)\s+a\b|quiero|queremos|es\s+necesario))`,
    String.raw`\b(?:lo|la)\s+(?:voy|vamos)\s+a\s+hacer\s+(?:yo|nosotros|nosotras)\s+mism[oa]s?\b`,
    String.raw`\b(?:yo|nosotros|nosotras)\s+mism[oa]s?\s+(?:lo|la)\s+(?:hago|hacemos|voy\s+a\s+hacer|vamos\s+a\s+hacer)\b`,
    String.raw`\bya\s+(?:lo|la)\s+resolv`,
    String.raw`\bya\s+(?:contrat|encontr|consegu)\w*\s+(?:a\s+)?(?:alguien|otr[oa])`,
    String.raw`\bcambi\w+\s+de\s+opini[oó]n`,
    String.raw`\bdecidi\w*\s+no\b`,
  ].join("|"),
  "i",
);

/**
 * "I'M ALL SET" IS A DECLINE ONLY BEFORE ANYTHING WAS BOOKED.
 *
 * Kate lists "I'm all set, thank you" as a decline. Said straight after the
 * bot confirmed the appointment it is the opposite — thanks, and the deal
 * done — and reading it as a decline there refuses `accepted` as
 * "recorded_a_decline_as_acceptance". The words alone cannot tell the two
 * apart, so the caller says which side of a booking we are on.
 *
 * "we're all set" was in DECLINED_WORDS with no such guard and had the same
 * failure; it moved here with its twin.
 */
const ALL_SET = /\b(?:(?:i|we)['’]?(?:m|re)|i\s+am|we\s+are)\s+all\s+set\b/i;

/** Spanish narrowing, the twin of STILL_WANTS: "no gracias a los gabinetes, solo los cuartos". */
const STILL_WANTS_ES =
  /\b(?:solo|s[oó]lo|nada\s+m[aá]s|todav[ií]a)\b[^.!?]{0,30}\b(?:el\s+|la\s+|los\s+|las\s+)?(?:interior|exterior|paredes?|techos?|cuartos?|rec[aá]maras?|habitaci\w*|cocina|ba[ñn]os?|sala|puertas?|gabinetes?|molduras?)\b/i;

export type DeclineContext = {
  /** The bot has just confirmed a booking or an acceptance. */
  afterBookingConfirmed?: boolean;
};

const DECLINED = {
  test: (t: string, c: DeclineContext = {}) =>
    (DECLINED_WORDS.test(t) || DECLINED_WORDS_MORE.test(t) || (!c.afterBookingConfirmed && ALL_SET.test(t)))
    && !STILL_WANTS.test(t) && !STILL_WANTS_ES.test(t),
};

/**
 * NOT GOING AHEAD, for callers outside this file.
 *
 * A17 — "Not moving forward means stop pursuing" — needs the same judgement
 * the park logic makes, and there is no second definition of a decline.
 */
export function declinesTheWork(text: string | null | undefined, context: DeclineContext = {}): boolean {
  const t = (text ?? "").trim();
  return !!t && DECLINED.test(t, context);
}

/**
 * Asking for the QUOTE itself by some channel. A7 / phone pricing, and
 * explicitly NOT a deferral — they still owe all three under A3.
 */
const QUOTE_DELIVERY =
  /\b(?:quote|estimate|price|pricing|bid|proposal)\b[^.?!]{0,40}\b(?:text|email|phone|call)\b|\b(?:text|email|send)\b[^.?!]{0,30}\b(?:quote|estimate|price|pricing|bid|proposal)\b/i;

/**
 * MOVING THE BOOKING CONVERSATION — time or channel.
 *
 * Kate, 2026-09-11: "When the customer moves the BOOKING CONVERSATION to
 * another time or another channel — 'I'll book it by phone', 'call me
 * tomorrow' — stop gathering additional details: CONTACT AND AVAILABILITY
 * ALIKE."
 *
 * Every pattern needs the customer to put THEMSELVES in the future with US:
 * coming back, reaching out, being called, doing it later. A bare "later"
 * is not enough — "I want it painted later this year" is a project timeline,
 * not a deferred conversation.
 */
const DEFERS_THE_CONVERSATION =
  /\b(?:i(?:'ll| will| am going to| gonna)|we(?:'ll| will| are going to))\b[^.?!]{0,30}\b(?:get\s+back|reach\s+out|call\s+you|contact\s+you|let\s+you\s+know|circle\s+back|be\s+in\s+touch|touch\s+base|book|schedule)\b|\b(?:can|could|let\s+me)\b[^.?!]{0,20}\b(?:come\s+back|get\s+back|reach\s+out)\b[^.?!]{0,15}\b(?:to\s+you|later|you)\b|\bcall\s+me\s+(?:back\s+)?(?:tomorrow|later|next\s+\w+|on\s+\w+|in\s+the\s+\w+)\b|\b(?:book|schedule)\s+(?:it|this)\s+(?:by|over)\s+(?:phone|the\s+phone|email)\b|\b(?:catch|check)\s+(?:up|back)\s+with\s+you\b|\blet\s+me\s+(?:get|come)\s+back\b|(?:^|[.!?,;]\s*|\b(?:i['’]?m|we['’]?re|i\s+am|we\s+are)\s+)not\s+ready\s+(?:yet\b|to\s+(?:book|schedule|commit|decide|go\s+ahead|move\s+forward))/i;

/**
 * KATE'S BARE DEFERRALS, AND THE SPANISH ONES. 2026-10-16.
 *
 * A40 lists them: "I'll get back to you", "once I've spoken to my wife",
 * "not ready yet". Only the first parked. "let me get back once I've spoken
 * to my wife" needed a "to you" within fifteen characters of "get back" and
 * had none, and "not ready yet" had no pattern — so both left ask_contact
 * legal, which is A40's failure (2), "carrying on collecting after they have
 * said they will come back to us". Both now ride on the English pattern
 * above.
 *
 * "not ready" must belong to the CUSTOMER ("I'm", "we're", or the whole
 * message), not to the room: "the room is not ready yet for paint" is a
 * project fact.
 *
 * Spanish had no deferral at all: "yo le aviso despues" ("I'll let you know
 * later") is the commonest way to say it.
 */
const DEFERS_THE_CONVERSATION_ES = new RegExp(
  [
    // "le aviso" is "I'll let you know" — but "le aviso que mañana no estoy"
    // is telling us something NOW, so not before "que".
    String.raw`\b(?:le|les)\s+aviso\b(?!\s+que\b)`,
    // The other verbs are present tense too, and "le escribo para pedir una
    // cotización" is how a Spanish first message OPENS. They defer only with
    // a "later" beside them, on either side.
    String.raw`\b(?:luego|despu[eé]s|m[aá]s\s+tarde|m[aá]s\s+adelante)\s+(?:yo\s+)?(?:le|les)\s+(?:escribo|llamo|confirmo|marco|contacto|mando\s+(?:un\s+)?mensaje)\b`,
    String.raw`\b(?:le|les)\s+(?:escribo|llamo|confirmo|marco|contacto|mando\s+(?:un\s+)?mensaje)\s+(?:luego|despu[eé]s|m[aá]s\s+tarde|m[aá]s\s+adelante|otro\s+d[ií]a|la\s+(?:pr[oó]xima|otra)\s+semana)\b`,
    // "me comunico para una cotización" opens a conversation too, so the
    // same "later" is required.
    String.raw`\b(?:luego|despu[eé]s|m[aá]s\s+tarde|m[aá]s\s+adelante)\s+(?:yo\s+)?(?:me|nos)\s+(?:comunico|comunicamos|pongo\s+en\s+contacto|ponemos\s+en\s+contacto|reporto)\b`,
    String.raw`\b(?:me|nos)\s+(?:comunico|comunicamos|pongo\s+en\s+contacto|ponemos\s+en\s+contacto|reporto)\b[^.?!]{0,15}\b(?:luego|despu[eé]s|m[aá]s\s+tarde|m[aá]s\s+adelante|otro\s+d[ií]a)\b`,
    String.raw`\b(?:todav[ií]a|a[uú]n)\s+no\s+(?:estoy|estamos)\s+list[oa]s?\b`,
    String.raw`\b(?:lo|la)\s+(?:agendo|agendamos|programo|programamos)\s+(?:por\s+tel[eé]fono|despu[eé]s|luego|m[aá]s\s+adelante)\b`,
  ].join("|"),
  "i",
);

/**
 * A FIELD THEY CANNOT FILL RIGHT NOW.
 *
 * Two shapes: they do not know yet, or they are waiting on another person.
 * "waiting on my spouse/tenant" is Hatch's own example and is residential —
 * see QUESTIONS_FOR_KATE item 2 on why "tenant" is not a commercial signal.
 */
const FIELD_UNKNOWN =
  /\b(?:not\s+(?:sure|certain)|don['’]?t\s+know|unsure|no\s+idea|haven['’]?t\s+decided|need\s+to\s+(?:check|look|confirm|figure)|have\s+to\s+check|let\s+me\s+check|i['’]?ll\s+have\s+to\s+check|still\s+(?:deciding|figuring|working)|maybe\s+more)\b|\bno\s+s[eé](?=\s*(?:[.,!?]|$|todav|a[uú]n|cu[aá]ndo|qu[eé]|si\b))|\bno\s+(?:estoy\s+segur[oa]|tengo\s+idea)\b|\btengo\s+que\s+(?:ver|revisar|confirmar|checar|consultar)\b|\btodav[ií]a\s+no\s+(?:s[eé]|decid\w*)/i;

// "spoken"/"talked" added 2026-10-16 — "once I've spoken to my wife" is
// Kate's wording and only "speak to" was here. Spanish beside it.
const WAITING_ON_SOMEBODY =
  /\b(?:waiting\s+on|talk(?:ed)?\s+(?:to|with)|check\s+with|speak\s+(?:to|with)|spoken?\s+(?:to|with)|ask|run\s+it\s+by|confirm\s+with)\b[^.?!]{0,20}\b(?:my|our|the)\s+(?:wife|husband|spouse|partner|landlord|tenants?|board|hoa|manager|boss|family|son|daughter|mother|father|mom|dad|roommate|co-?owner)\b|\b(?:hablar|consultar|preguntar|platicar|ver)(?:lo|la)?\s+con\s+(?:mi|mis|el|la|nuestr[oa])\s+(?:esposa|esposo|marido|mujer|pareja|familia|casero|due[ñn]o|arrendador|hij[oa]|mam[aá]|pap[aá]|jefe|socio)\b/i;

/**
 * "DON'T CHASE ME" — A PARK THAT GETS NO CADENCE AT ALL.
 *
 * A40, Kate 2026-09-28: "A CUSTOMER WHO ASKS NOT TO BE CHASED GETS NO
 * CADENCE. Hand the conversation to the call centre and leave it. Following
 * up is the breach."
 *
 * So this is not a gentler park. It is the one case where the follow-ups
 * themselves are the defect, and it has to be told apart from the ordinary
 * deferral that DOES get chased — "I'll get back to you" is on her list of
 * bare deferrals and gets three nudges.
 *
 * The line is an explicit instruction not to follow up. Somebody saying they
 * will come back to us has said what THEY will do; somebody saying "no need
 * to chase me" has said what WE must not. Only the second is here, which is
 * why this wants a negation or a "no need" rather than the verb alone.
 *
 * NOT an opt-out, and it does not try to be. "Stop texting me" is A24 and is
 * decided before the model is asked at all — see compliance.ts. This is
 * somebody who still wants the work and does not want to be nudged about it.
 */
const ASKS_NOT_TO_BE_CHASED = new RegExp(
  [
    String.raw`\b(?:do\s*n[o']?t|dont|don['’]t|no\s+need\s+to|there['’]?s\s+no\s+need\s+to)\b[^.?!]{0,25}\b(?:chase|chasing|follow\s*up|following\s*up|check\s*in|checking\s*in|remind|reach\s+out|contact\s+me|message\s+me)\b`,
    String.raw`\bno\s+(?:more\s+)?(?:follow[\s-]*ups?|reminders?|chasing)\b`,
    String.raw`\bstop\s+(?:chasing|following\s*up|checking\s*in)\b`,
    String.raw`\bleave\s+it\s+with\s+me\b`,
    // Spanish, 2026-10-16. "por favor no me den seguimiento" was read as
    // nothing, so the park cadence nudged a customer who had asked it not to.
    // Same discipline as above: a negation or "no hace falta", never the
    // verb alone — "yo le aviso" is a bare deferral and IS chased.
    String.raw`\bno\s+(?:me|nos)\s+(?:den|d[eé]|hagan|haga)\s+seguimiento\b`,
    String.raw`\bno\s+(?:hace\s+falta|es\s+necesario|hay\s+necesidad\s+de)\b[^.?!]{0,25}\b(?:seguimiento|recordar|escribir(?:me|nos)?|insistir)\b`,
    String.raw`\bno\s+(?:me|nos)\s+(?:recuerden|insistan|est[eé]n\s+(?:recordando|insistiendo))\b`,
  ].join("|"),
  "i"
);

/**
 * Did they ask us not to follow up?
 *
 * Separate from parkKind because it changes nothing about what the TURN
 * says — it changes what happens afterwards, which is nothing at all. The
 * sweep reads this before queueing a cadence.
 */
export function asksNotToBeChased(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return ASKS_NOT_TO_BE_CHASED.test(t);
}

/**
 * BLOCKED ON A NAMED EVENT, which waits two weeks rather than two days.
 *
 * A40, Kate 2026-09-28: "BLOCKED ON A NAMED EVENT - moving, a closing, an
 * insurance payout, no power at the property, travelling. TWO WEEKS."
 *
 * The distinction from a bare deferral is whether the thing in the way has a
 * name and a clock of its own. "I'm not ready yet" is a state of mind and is
 * chased in days; "we close on the house in a fortnight" is an event, and
 * nudging that customer on Thursday achieves nothing.
 */
const BLOCKED_ON_AN_EVENT = new RegExp(
  [
    String.raw`\bmov(?:e|es|ing|ed)\b[^.?!]{0,20}\b(?:in|out|house|home|place|apartment|there)\b`,
    String.raw`\bclos(?:e|ing)\b[^.?!]{0,20}\b(?:on\s+the\s+)?(?:house|home|property|place)\b`,
    String.raw`\b(?:insurance|adjuster|claim)\b[^.?!]{0,30}\b(?:pay|payout|pays|settle|settles|approve|approves|come\s+through|process)\w*\b`,
    String.raw`\bwaiting\s+on\s+(?:the\s+)?(?:insurance|adjuster|closing|settlement|claim)\b`,
    String.raw`\bno\s+(?:power|electric|electricity|water)\b`,
    String.raw`\b(?:travelling|traveling|out\s+of\s+town|on\s+holiday|on\s+vacation|abroad)\b`,
  ].join("|"),
  "i"
);

/**
 * THE SAME QUESTION, ASKED OF THE WHOLE CONVERSATION.
 *
 * The event is named ONCE, early, and referred to loosely afterwards:
 *
 *   "we are closing on the house on the 14th"        <- matches
 *   "we cant do anything until after the closing"    <- does not
 *
 * So a guard reading only the current message decides there is no event on
 * exactly the turn that matters, which is the turn they defer on. Found in
 * the sandbox running the closing scenario end to end.
 *
 * Third instance of this shape in one session, after availabilityGapAcross
 * and the A4 close guard: a fact that is true of the CONVERSATION asked of
 * one message. If you are adding a rule about something the customer has
 * told us, it reads the thread.
 */
export function threadIsBlockedOnEvent(
  messages: readonly (string | null | undefined)[]
): boolean {
  return messages.some((m) => parkIsBlockedOnEvent(m));
}

/** Is this park waiting on a named event rather than on the customer? */
export function parkIsBlockedOnEvent(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return BLOCKED_ON_AN_EVENT.test(t);
}

/**
 * Which kind of park this message is, or null when it is neither.
 *
 * Order is the rule. A decline wins over everything (A17 owns it); a
 * quote-delivery request is never a park; then the CONVERSATION reading is
 * taken before the FIELD one, because "I'll get back to you once I check with
 * my wife" is a deferral that happens to mention a field, and treating it as
 * a field would keep collecting against a conversation they already moved —
 * Kate's failure (2).
 */
export function parkKind(text: string | null | undefined): ParkKind | null {
  const t = (text ?? "").trim();
  if (!t) return null;

  if (DECLINED.test(t)) return null;          // A17, not A40
  if (QUOTE_DELIVERY.test(t)) return null;    // A7 / phone pricing, not A40

  if (DEFERS_THE_CONVERSATION.test(t) || DEFERS_THE_CONVERSATION_ES.test(t)) return "conversation";
  if (FIELD_UNKNOWN.test(t) || WAITING_ON_SOMEBODY.test(t)) return "field";

  return null;
}

/** Every intent whose job is to ask the customer for something. */
const ASKING_INTENTS = new Set([
  "ask_project_details", "ask_address", "ask_contact", "ask_availability",
  "confirm_scope", "confirm_address", "confirm_contact",
]);

export function isAsk(intent: string): boolean {
  return ASKING_INTENTS.has(intent);
}

/**
 * Has the customer already moved the booking conversation?
 *
 * Reads the whole thread, not just the latest message: a deferral does not
 * have to be repeated to still be true, and the turn after "I'll get back to
 * you" is exactly where the pressing happens.
 */
export function conversationWasDeferred(customerMessages: readonly string[]): boolean {
  return customerMessages.some((m) => parkKind(m) === "conversation");
}
