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
/*
 * EACH ENTRY CARRIES BOTH LANGUAGES.
 *
 * A22 is counted off these, and they were English-only — so a Spanish message
 * produced ZERO fields whatever it asked for. tooManyAsks could not fire, and
 * neither could render.ts's rapport-dropping rule that depends on it:
 *
 *   "Cuál es su nombre, su correo electrónico y la dirección del proyecto?"
 *
 * is three asks in one message, Kate's most-cited tone breach, and it counted
 * as none. The templates were translated; this was not.
 */
const PRODUCED_FIELD: { field: string; re: RegExp }[] = [
  { field: "name", re: /\bname\b|\bnombre\b/i },
  { field: "email", re: /\be-?mail\b|\bcorreo(?:\s+electr[óo]nico)?\b/i },
  { field: "phone", re: /\b(?:phone|mobile|cell|number to reach)\b|\b(?:tel[ée]fono|celular|n[úu]mero)\b/i },
  { field: "address", re: /\b(?:address|street|zip|post ?code|property located|whereabouts)\b|\b(?:direcci[óo]n|calle|c[óo]digo\s+postal|ubicaci[óo]n)\b/i },
  { field: "availability", re: /\b(?:day|days|time|window|weekday|weekend|availability|available)\b|\b(?:d[íi]as?|horas?|horario|disponibilidad|fin\s+de\s+semana)\b/i },
  { field: "scope", re: /\b(?:project|painted|painting|have done|looking to have)\b|\b(?:proyecto|pintar|pintura|trabajo)\b/i },
];

/** A question expecting a bare yes or no. */
const YES_NO =
  /\b(?:is|are|was|were|do|does|did|would|will|can|could|should|have|has|want|shall)\b[^.?!]*\?|\b(?:es|son|est[áa]|est[áa]n|tiene|tienen|puede|pueden|quiere|quieren|ser[íi]a|podr[íi]a)\b[^.?!]*\?/gi;

/**
 * Verbs that REQUEST without a question mark. "Let me know your name and
 * email" is an ask; so is "I'll need your address".
 */
const REQUESTING =
  /\b(?:need|send|give|tell|let me know|provide|share|confirm|grab|put|reach you|best way)\b/i;

/** The same verbs in Spanish, plus the bare "cuál es / cómo se" question forms. */
const REQUESTING_ES =
  /\b(?:necesit\w+|env[íi]\w+|mand\w+|d[ée]me|deme|d[íi]game|digame|comp[áa]rta\w+|confirm\w+|indique\w*|proporcione\w*|av[íi]se\w*|cu[áa]l\s+es|c[óo]mo\s+se)\b/i;

/**
 * ONLY THE PARTS THAT ACTUALLY ASK.
 *
 * VOLUME counts what the customer must PRODUCE, and a sentence that neither
 * asks nor requests cannot make them produce anything. This scanned the whole
 * message, so a statement about what WE will do counted against the limit:
 *
 *   "I'll check the calendar for that time. What's the address for the
 *    project?"
 *
 * was reported as "3 things at once (address, availability, scope)" — one
 * question, plus "calendar/time" read as an availability ask and "project"
 * read as a scope ask, both out of a sentence describing our own next step.
 * Found on 2026-09-27 when that false positive suppressed an acknowledgement
 * the A15 work had just added, and only on even-numbered turns, because the
 * template variant on odd turns happened to word it differently.
 *
 * A sentence counts when it is a question OR carries a requesting verb.
 */
function asking(text: string): string {
  return text
    .split(/(?<=[.?!])\s+/)
    .filter((sentence) => sentence.includes("?") || REQUESTING.test(sentence) || REQUESTING_ES.test(sentence))
    .join(" ");
}

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
    const fields = PRODUCED_FIELD.filter((f) => f.re.test(asking(requested))).map((f) => f.field);
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
