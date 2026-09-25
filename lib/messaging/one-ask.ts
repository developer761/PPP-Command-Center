/**
 * One ask per message, counted the way Kate counts it.
 *
 * ── THE QUESTION MARK PROVES NOTHING ────────────────────────────────────
 *
 * A22: "One ASK per message — COUNT ASKS, NOT QUESTION MARKS." And on her own
 * tooling: "check_rule_fit has NO precondition for this rule — the '?' count
 * was removed 2026-09-10 because it proves nothing either way."
 *
 * It proves nothing in both directions. "What's your name, email and phone
 * number?" is one question mark and three asks. "Is 999-784-6046 and
 * tom@x.com still the best contact?" is one question mark and one ask,
 * because it reads back values we already hold for a single yes.
 *
 * Our template test counted question marks. That is the check she deleted.
 *
 * ── THE TWO WAYS TO BREAK IT ────────────────────────────────────────────
 *
 * VOLUME: "asking the customer to PRODUCE more than TWO fields in one
 * message... Two produced fields is acceptable. AN ADDRESS IS ONE FIELD
 * however many parts you name — 'the house number and street name, plus the
 * zip code' is one ask, not three." Reading back what we hold is one ask
 * however many values it names.
 *
 * AMBIGUITY: "two yes/no questions in one message, even when BOTH are
 * read-backs of data we hold, because a bare 'yes' does not say which one it
 * answers."
 *
 * ── WHAT THIS IS FOR ────────────────────────────────────────────────────
 *
 * Templates, not grading. Kate is explicit that judging a real conversation
 * against this rule is "a judgement call, so expect looser blind-rater
 * agreement than a mechanical rule". Our templates are a finite, fixed set
 * written by us, and holding those to the mechanical half is exactly the part
 * that can be held.
 *
 * The model's own half is already covered elsewhere: rapport may contain no
 * question at all, so it cannot add a second ask to a template that has one.
 *
 * Pure.
 */

/** A slot is a value we already hold, so it is a read-back and not a request. */
const SLOT = /\{[^}]+\}/g;

/**
 * The fields a message can ask somebody to produce.
 *
 * Address is deliberately one entry covering all its parts, per the rule:
 * naming the house number, the street and the zip is still one field.
 */
const PRODUCED_FIELD: { field: string; re: RegExp }[] = [
  { field: "name", re: /\bname\b/i },
  { field: "email", re: /\be-?mail\b/i },
  { field: "phone", re: /\b(?:phone|mobile|cell|number to reach)\b/i },
  { field: "address", re: /\b(?:address|street|zip|post ?code|property located|whereabouts)\b/i },
  { field: "availability", re: /\b(?:day|days|time|window|weekday|weekend|availability|available)\b/i },
  { field: "scope", re: /\b(?:project|painted|painting|have done|looking to have)\b/i },
];

/** A question expecting a bare yes or no. */
const YES_NO =
  /\b(?:is|are|was|were|do|does|did|would|will|can|could|should|have|has|want|shall)\b[^.?!]*\?/gi;

export const MAX_PRODUCED_FIELDS = 2;

/**
 * Why this message asks for more than one thing, or null when it is fine.
 */
export function tooManyAsks(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;

  // Strip the held values first. What is left is what the customer has to
  // type, which is the only thing VOLUME counts.
  const requested = t.replace(SLOT, " ");
  const readsBackAValue = SLOT.test(t);
  SLOT.lastIndex = 0;

  if (!readsBackAValue) {
    const fields = PRODUCED_FIELD.filter((f) => f.re.test(requested)).map((f) => f.field);
    if (fields.length > MAX_PRODUCED_FIELDS) {
      return `asks the customer to produce ${fields.length} things at once (${fields.join(", ")}), and two is the most one message may ask for`;
    }
  }

  const yesNo = (t.match(YES_NO) ?? []).length;
  YES_NO.lastIndex = 0;
  if (yesNo > 1) {
    return `asks ${yesNo} separate yes or no questions, so a bare "yes" would not say which one it answered`;
  }

  return null;
}
