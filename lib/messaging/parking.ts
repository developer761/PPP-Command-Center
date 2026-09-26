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
const DECLINED =
  /\b(?:not\s+interested|no\s+thanks?|we(?:'re|\s+are)?\s+all\s+set|already\s+(?:hired|booked|found|got)|went\s+(?:with|another)|found\s+(?:someone|somebody|another)|hired\s+(?:someone|somebody)|going\s+(?:with|in)\s+another|changed\s+(?:my|our)\s+mind|decided\s+(?:not|against))\b/i;

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
  /\b(?:i(?:'ll| will| am going to| gonna)|we(?:'ll| will| are going to))\b[^.?!]{0,30}\b(?:get\s+back|reach\s+out|call\s+you|contact\s+you|let\s+you\s+know|circle\s+back|be\s+in\s+touch|touch\s+base|book|schedule)\b|\b(?:can|could|let\s+me)\b[^.?!]{0,20}\b(?:come\s+back|get\s+back|reach\s+out)\b[^.?!]{0,15}\b(?:to\s+you|later|you)\b|\bcall\s+me\s+(?:back\s+)?(?:tomorrow|later|next\s+\w+|on\s+\w+|in\s+the\s+\w+)\b|\b(?:book|schedule)\s+(?:it|this)\s+(?:by|over)\s+(?:phone|the\s+phone|email)\b|\b(?:catch|check)\s+(?:up|back)\s+with\s+you\b/i;

/**
 * A FIELD THEY CANNOT FILL RIGHT NOW.
 *
 * Two shapes: they do not know yet, or they are waiting on another person.
 * "waiting on my spouse/tenant" is Hatch's own example and is residential —
 * see QUESTIONS_FOR_KATE item 2 on why "tenant" is not a commercial signal.
 */
const FIELD_UNKNOWN =
  /\b(?:not\s+(?:sure|certain)|don['’]?t\s+know|unsure|no\s+idea|haven['’]?t\s+decided|need\s+to\s+(?:check|look|confirm|figure)|have\s+to\s+check|let\s+me\s+check|i['’]?ll\s+have\s+to\s+check|still\s+(?:deciding|figuring|working)|maybe\s+more)\b/i;

const WAITING_ON_SOMEBODY =
  /\b(?:waiting\s+on|talk\s+(?:to|with)|check\s+with|speak\s+(?:to|with)|ask|run\s+it\s+by|confirm\s+with)\b[^.?!]{0,20}\b(?:my|our|the)\s+(?:wife|husband|spouse|partner|landlord|tenants?|board|hoa|manager|boss|family|son|daughter|mother|father|mom|dad|roommate|co-?owner)\b/i;

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

  if (DEFERS_THE_CONVERSATION.test(t)) return "conversation";
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
