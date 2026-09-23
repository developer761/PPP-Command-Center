/**
 * Is what is on file actually a description of the work?
 *
 * ── THE RULE ────────────────────────────────────────────────────────────
 *
 * A9, Kate: "Paraphrasing the record does not include paraphrasing a
 * placeholder. 'Customer did not provide additional comments. Please contact
 * the customer to discuss the details of this project.' is not scope — it is
 * the absence of scope sitting in a scope field. Treat it as no scope held:
 * ask for it, never summarise it back. A PLACEHOLDER IS ANY NON-SCOPE VALUE
 * SITTING IN THE SCOPE FIELD, not only that one string: a form or source
 * label — 'painting estimate request' — is the same thing, and quoting it back
 * as the project summary lets the customer RUBBER-STAMP AN EMPTY RECORD. If
 * what is on file does not describe work to be done, it is not scope."
 *
 * ── WHY IT IS WORTH ITS OWN MODULE ──────────────────────────────────────
 *
 * inquiryScope reaches four places, and a placeholder corrupts every one:
 *
 *   1. knownFields.inquiryScope is truthy, so ask_project_details is refused
 *      as a redundant ask (A13) and THE BOT NEVER ASKS WHAT THE JOB IS. This
 *      is the worst of the four and the least visible.
 *   2. confirm_scope renders "you're looking for: Customer did not provide
 *      additional comments…" straight to the customer.
 *   3. known-customer.ts puts it in the prompt as "What they said they need,
 *      IN THEIR OWN WORDS", which is simply untrue and invites the model to
 *      act on it.
 *   4. jobRoute reads it to decide A6 against A7.
 *
 * ── THE SAFE DIRECTION IS INVERTED HERE ─────────────────────────────────
 *
 * Everywhere else in this codebase a text matcher is built timid, because a
 * false positive silently changes behaviour. Not here. Calling real scope a
 * placeholder costs one extra question, which the customer answers in four
 * words. Calling a placeholder real scope means never asking at all and
 * quoting nonsense back. Kate's instruction is the same: treat it as no scope
 * held. So this leans toward flagging.
 *
 * Pure.
 */

/** Phrases that are the ABSENCE of scope, written down. */
const EMPTY_RECORD = [
  /\bcustomer did not provide\b/i,
  /\bno additional (?:comments?|details?|information)\b/i,
  /\bnot provided\b/i,
  /\bno (?:comments?|details?|description) (?:given|provided|entered)\b/i,
  /\bplease contact the customer\b/i,
  /\bcontact the customer to discuss\b/i,
  /\bdetails to (?:be )?(?:follow|confirm)/i,
  /\bsee notes?\b/i,
  /\btbd\b/i,
  /^\s*(?:n\/?a|none|null|nil|unknown|test|\.|-|--)\s*$/i,
];

/**
 * Form and source labels. These name where the lead CAME FROM, not what the
 * customer wants done, and they are the case Kate added by name.
 */
const SOURCE_LABEL = [
  /^\s*(?:free\s+)?(?:painting\s+)?estimate\s+request\s*$/i,
  /^\s*(?:request|requesting)\s+(?:a\s+)?(?:free\s+)?(?:quote|estimate)\s*$/i,
  /^\s*(?:free\s+)?(?:quote|estimate)\s+(?:request|form|inquiry|enquiry)\s*$/i,
  /^\s*(?:web(?:site)?|online|internet|google|facebook|meta|yelp|angi|thumbtack)\s*(?:lead|form|inquiry|enquiry|request)?\s*$/i,
  /^\s*(?:contact|lead|inquiry|enquiry)\s*(?:form|request)?\s*$/i,
  /^\s*(?:interior|exterior|residential|commercial)?\s*painting\s*(?:estimate|quote|request|inquiry|lead|services?|project)?\s*$/i,
  /^\s*(?:paint|painting|quote|estimate|inquiry|enquiry|lead|project|job|work)\s*$/i,
  // A bare category on its own. "Interior" names which half of the business
  // the job belongs to, not the job, so "Painting - Interior" is two labels
  // beside each other and still says nothing about the work.
  /^\s*(?:interior|exterior|residential|commercial|new\s+construction)\s*$/i,
];

/**
 * The shortest thing that can still be scope.
 *
 * "2 rooms" is eight characters and is real scope. "Painting" is eight and is
 * a category. Length alone cannot tell them apart, which is why the source
 * labels above are matched explicitly rather than by a cutoff.
 */
const MIN_SCOPE_CHARS = 3;

/**
 * True when the scope field holds something that is not a description of work.
 *
 * `null`, empty and whitespace all count: the caller wants one question
 * answered — may I treat this as scope — and "there is nothing there" is the
 * same answer as "what is there is not scope".
 */
export function isPlaceholderScope(scope: string | null | undefined): boolean {
  const t = (scope ?? "").trim();
  if (t.length < MIN_SCOPE_CHARS) return true;

  if (EMPTY_RECORD.some((re) => re.test(t))) return true;
  if (SOURCE_LABEL.some((re) => re.test(t))) return true;

  // A field holding ONLY a label plus punctuation, e.g. "Painting - Interior".
  // Splitting on separators and finding every part is itself a label means the
  // whole thing names a category rather than a job.
  const parts = t.split(/[-|/,:;]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts.every((p) => SOURCE_LABEL.some((re) => re.test(p)))) return true;

  return false;
}

/**
 * The scope to actually use, or null when there is none worth using.
 *
 * Callers should prefer this over reading the field directly, so that "has
 * scope" and "has usable scope" cannot drift apart.
 */
export function usableScope(scope: string | null | undefined): string | null {
  return isPlaceholderScope(scope) ? null : (scope ?? "").trim();
}
