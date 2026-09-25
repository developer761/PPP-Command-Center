/**
 * What the customer actually asked for, pulled out of Inquiry Notes.
 *
 * ── WHERE THIS COMES FROM ───────────────────────────────────────────────
 *
 * Kate, 2026-09-24, naming the field at last: "Inquiry_Notes__c — however,
 * for the historical pull, I pulled from the Description field when a payload
 * existed, because the CC adds notes in the Inquiry Notes field as they talk
 * to the customer, which was confusing the rater. You'd use Inquiry Notes on
 * incoming/new/fresh leads."
 *
 * So Inquiry Notes is the source for live leads, and the thing that made it
 * unusable for rating is still sitting in it for sending: somebody in the
 * call centre types into the same box the customer's words are in.
 *
 * ── WHAT IS ACTUALLY IN THERE ───────────────────────────────────────────
 *
 * Measured over 921 real leads with Inquiry Notes, 120 days:
 *
 *   91  (10%)  a raw web-form dump — snake_case question keys and answers run
 *              together, e.g. "tell_us_a_little_bit_about_your_painting_
 *              project!: Existing cabinets how_soon_are_you_looking_to_
 *              complete_your_project?: 1_-_2_weeks"
 *   128 (14%)  operator shorthand mixed into the customer's own words: "PP",
 *              "Cx", "Phone estimate.", "No time frame provided."
 *   74  (8%)   a placeholder, which scope.ts already refuses
 *
 * None of the 91 form dumps were caught by anything, so every one of them
 * would have been read back to a customer verbatim by confirm_scope. They are
 * NOT placeholders and must not be treated as such: two of the five sampled
 * carried real scope inside them — "Existing cabinets", "exterior painting 1
 * and a half story house". Throwing them away loses the job description; the
 * answer has to be pulled out instead.
 *
 * ── WHY THE OPERATOR NOTES MATTER MORE THAN THEY LOOK ───────────────────
 *
 * One real lead reads "Home is Stucco Cx has the paint PP refused in person
 * Zestimate: $623,300". That is an internal decision and a dollar figure in
 * the field the bot is about to summarise back to the customer. A1 is the
 * most critical rule in the set and this walks a price straight past it,
 * because the price never came from the model — it came from the record.
 *
 * Pure. No Salesforce, no database.
 */
import { isPlaceholderScope } from "./scope";

/**
 * A snake_case form key, e.g. "how_soon_are_you_looking_to_complete_your_project?:".
 * Three underscored words is the floor — "1_-_2_weeks" is an ANSWER and must
 * not be mistaken for a key, which is why the key has to end in a colon.
 */
const FORM_KEY = /(?:^|\s)([a-z0-9]+(?:_[a-z0-9'?!()/-]+){2,})\s*:?/gi;

/** The form question that asks for the job itself. */
const ASKS_FOR_THE_JOB = /(?:tell_us|describe|about_your|details?_of|what_.*_(?:need|want)|project_details?)/i;

/**
 * Whole sentences the call centre writes, which are about handling the lead
 * rather than about the work. Matched as complete sentences so that a
 * customer saying "I prefer text" in the middle of a real description is left
 * alone.
 */
const OPERATOR_SENTENCE = [
  /^phone estimate\.?$/i,
  /^prefers? (?:text|phone|email)(?: communications?)?\.?$/i,
  /^no time ?frame provided\.?$/i,
  /^(?:left )?(?:a )?(?:voicemail|vm)\.?$/i,
  /^no answer\.?$/i,
  /^called(?: \w+)?\.?$/i,
  /^zestimate\s*:.*$/i,
];

/**
 * PP and Cx do NOT mean the same thing, and treating them the same threw away
 * real scope.
 *
 * "PP" prefixes Precision Painting's own decisions — "PP refused in person",
 * "PP No access" — and whatever follows it on the line is internal, so the
 * line is cut there.
 *
 * "Cx" is the call centre writing down what the CUSTOMER said, and the scope
 * is on the far side of it: "Cx wants to paint wooden cabinets to black".
 * Cutting to the end of the line there deleted the only description of the
 * job on the record, which is exactly backwards. Only the token goes.
 */
const OPERATOR_TAIL = /(?:^|[\s*-])PP\b[^\n]*/gim;
const CUSTOMER_MARKER = /(?:^|[\s*-])CX\b[:\s-]*/gim;

/**
 * A line the call centre wrapped in asterisks, which is how they mark their
 * own asides: "**Cx said you may call him from the outside during the appt**".
 */
const OPERATOR_STARRED = /^\s*\*+[^\n]*\*+\s*$/gm;

/**
 * MONEY NEVER TRAVELS IN SCOPE.
 *
 * A real lead reads "Home is Stucco Cx has the paint PP refused in person
 * Zestimate: $623,300". The first draft of this file stripped the operator
 * tail and left "$623,300" behind, which then lands in the prompt as "what
 * they said they need, IN THEIR OWN WORDS" — a dollar figure the model is
 * invited to repeat, arriving from the record rather than from the model, so
 * the price rail in agent-output.ts never sees it.
 *
 * Scope is a description of work. An amount in it is either the call centre's
 * note or a budget, and neither is something to read back.
 */
const MONEY = /\s*(?:zestimate\s*[®:]*\s*)?[$£€]\s?\d[\d,.]*\s*/gi;
/** The bare brand, left behind once its amount is gone. */
const ZESTIMATE = /\s*zestimate\s*[®:]*\s*/gi;

/** Collapse runs of whitespace without joining separate thoughts. */
const tidy = (s: string) => s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

/**
 * Pull the answer to the project question out of a web-form dump.
 *
 * Returns null when the dump has no project question or the answer to it is
 * itself a canned choice ("as_soon_as_possible_(urgent)"), which says when
 * they want it and nothing about what it is.
 */
export function answerFromFormDump(raw: string): string | null {
  const keys = [...raw.matchAll(FORM_KEY)];
  if (keys.length < 2) return null;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i][1];
    if (!ASKS_FOR_THE_JOB.test(key)) continue;
    const from = keys[i].index! + keys[i][0].length;
    const to = i + 1 < keys.length ? keys[i + 1].index! : raw.length;
    const answer = tidy(raw.slice(from, to));
    // An answer that is itself snake_case is a picked option, not prose.
    if (!answer || /^[a-z0-9]+(?:_[a-z0-9'?!()/-]+){1,}$/i.test(answer)) continue;
    return answer;
  }
  return null;
}

/**
 * True when the text looks like a raw form dump rather than prose.
 *
 * One key is enough. The first version wanted two and let through
 * "when_would_you_like_to_complete_your_painting_project?: as_soon_as_
 * possible_(urgent)" because the second question had no colon after it, so
 * forty-five of these went out still wearing the form's own field names.
 */
export function isFormDump(raw: string): boolean {
  return [...raw.matchAll(FORM_KEY)].length >= 1;
}

/** Strip the call centre's own notes, leaving the customer's words. */
export function stripOperatorNotes(raw: string): string {
  const withoutTails = raw
    .replace(OPERATOR_STARRED, "")
    .replace(OPERATOR_TAIL, "")
    .replace(CUSTOMER_MARKER, " ")
    .replace(MONEY, " ")
    .replace(ZESTIMATE, " ");
  const kept = withoutTails
    .split(/\n+/)
    .map((line) =>
      line
        // Sentence by sentence, so an operator note sharing a line with the
        // customer's words does not take the whole line with it.
        .split(/(?<=[.!?])\s+/)
        .filter((s) => !OPERATOR_SENTENCE.some((re) => re.test(s.trim())))
        .join(" ")
    )
    .map((l) => l.trim())
    .filter(Boolean);
  return tidy(kept.join("\n"));
}

/**
 * The `Description` value inside the JSON payload some sources write into the
 * standard Description field.
 *
 * Kate used this for the historical pull. It is not the live path, but a
 * payload is present on 42% of recent leads and it is the customer's words
 * untouched by the call centre, so it is the better fallback when Inquiry
 * Notes has nothing usable left.
 */
export function askFromPayload(description: string | null | undefined): string | null {
  const t = (description ?? "").trim();
  if (!t.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(t) as Record<string, unknown>;
    const d = parsed.Description;
    return typeof d === "string" && d.trim() ? d.trim() : null;
  } catch {
    // A payload that does not parse is not worth guessing at with a regex.
    return null;
  }
}

/**
 * What the customer said they want done, or null when the record does not
 * actually say.
 *
 * Order is Kate's: Inquiry Notes for a live lead, the payload only as a
 * fallback. Null rather than a placeholder, so knownFields.inquiryScope stays
 * honest and the bot asks instead of summarising an empty record back.
 */
export function customerAsk(input: {
  inquiryNotes?: string | null;
  description?: string | null;
}): string | null {
  const notes = (input.inquiryNotes ?? "").trim();

  let fromNotes: string | null = null;
  if (notes) {
    const cleaned = stripOperatorNotes(notes);
    // A dump whose project question has no prose answer is the form talking
    // to itself. Returning the raw dump would read it back to the customer.
    fromNotes = isFormDump(cleaned) ? answerFromFormDump(cleaned) : cleaned || null;
    if (fromNotes && isPlaceholderScope(fromNotes)) fromNotes = null;
  }
  if (fromNotes) return fromNotes;

  const fromPayload = askFromPayload(input.description);
  if (fromPayload && !isPlaceholderScope(fromPayload)) return fromPayload;

  return null;
}
