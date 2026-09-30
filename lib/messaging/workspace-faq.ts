/**
 * THE STANDING ANSWERS A WORKSPACE HOLDS.
 *
 * Hatch parity gap 9. It carries roughly 25 curated questions and answers per
 * workspace — All Zips, Services/Surfaces, "Are you insured?", "Do you have a
 * minimum?", EPA, payment terms, references, warranty, "Are you local?" — and
 * we carry none, so anything outside the rules and the services table
 * escalates to a person. Every one of those escalations is a question
 * somebody has already written the answer to.
 *
 * ── THESE ARE BOT-FACING, WHICH IS THE WHOLE POINT AND THE WHOLE RISK ───
 *
 * Unlike Kate's rater guidance, this text is MEANT to reach the model — the
 * bot answering from it is the feature. That makes the knowledge base a
 * second place a sentence can reach a customer from, and it bypasses nothing:
 * whatever comes out still goes through the validator and the gate.
 *
 * But two rules can be broken by the CONTENT rather than by the reply, and
 * both are checked before a row is ever saved:
 *
 *   A1   never a price. An FAQ answering "how much will this cost" with a
 *        number launders a quote through the knowledge base — the validator
 *        sees a model that answered a question, not a model that invented a
 *        price, because the price was handed to it.
 *   A18  never point a customer at another company.
 *
 * ── WHY THE PROMPT AND NOT A LOOKUP ────────────────────────────────────
 *
 * Twenty-five short pairs is a few hundred tokens. Retrieval would add a
 * matching step that can be wrong in a way nobody sees — the model silently
 * answering from the wrong FAQ — in exchange for tokens we are not short of.
 * The model already decides what a question is about; giving it the whole
 * list lets it decide with everything in view.
 *
 * Pure. The caller does the reading and writing.
 */

export type WorkspaceFaq = {
  question: string;
  answer: string;
  /**
   * TRUE when this row is stored once and read by EVERY workspace
   * (`workspace_id IS NULL`). Carried on the row rather than passed to
   * checkFaq as an argument, deliberately: an argument with a default is a
   * check that silently does not run at the call site that forgot it, and
   * this codebase has shipped that bug more than once. The loader knows which
   * tier each row came from, so the row can carry it and every reader —
   * save time and read time — gets the same answer.
   */
  shared?: boolean;
  /** Where it sits in the prompt. Carried so ordering survives validation. */
  sortOrder?: number;
};

/**
 * A price in an answer. Deliberately the same shape the output filter uses —
 * a figure, a range, a per-unit rate, or a written-out number of dollars.
 */
const A_PRICE =
  /\$\s?\d|\b\d+\s*(?:-|to)\s*\$?\d+\s*(?:dollars|usd)\b|\b\d{2,}\s*(?:dollars|usd)\b|\bper\s+(?:square\s+)?(?:foot|ft|sq\s*ft|room|wall|gallon)\b[^.?!]{0,20}\$?\d/i;

/** Naming somebody else who could do the work. A18. */
const ANOTHER_COMPANY =
  /\b(?:try|call|contact|reach out to|check with|recommend|suggest)\b[^.?!]{0,30}\b(?:another|a different|other)\s+(?:company|contractor|painter|painters|business|outfit)\b|\byou (?:could|might|should) (?:try|call|check)\b[^.?!]{0,20}\b(?:someone else|another)\b/i;

/**
 * A QUESTION WHOSE ANSWER DEPENDS ON WHERE THE WORKSPACE IS.
 *
 * The original migration refused to let anything inherit, for this reason and
 * in these words: "'Where are you located?' is 'the greater Los Angeles and
 * Orange County area' on CA LA Leads and something else entirely in Nassau...
 * A single list would make the bot confidently wrong about geography, which
 * is exactly the thing A2 and A6 are careful about."
 *
 * The shared tier exists because most answers are NOT like that — insurance,
 * EPA, warranty and payment terms are company policy and identical
 * everywhere. This function is what keeps the two apart.
 *
 * DELIBERATELY OVER-EAGER, and the asymmetry is the whole design. A question
 * wrongly refused from the shared tier gets written per workspace, which is
 * what happens today, so the cost of a false positive is zero new work. A
 * geographic answer wrongly shared is the bot telling customers in fourteen
 * regions a service area that is not theirs, stated as fact, with nothing
 * downstream able to catch it — the validator sees a question answered well.
 *
 * Bare "serve", "cover", "based", "office", "city", "town" and bare "area"
 * are NOT here, on purpose. Each was refusing a genuinely global question —
 * "Do you use water-based or oil-based?", "Do you offer office painting?",
 * "What is the minimum area you will do?", "How far in advance do I need to
 * book?" — and the claim that a false positive "costs nothing new" is wrong:
 * it costs the whole saving, thirty-two times over, on a sentence that never
 * varies. "area" is matched only where it means a SERVICE area.
 *
 * That loosening is only safe because checkFaq tests the ANSWER too. The two
 * compose: "Do you work in the city?" passes here and is caught on its real
 * answer, "Yes, all five boroughs".
 */
const LOCATION_BOUND = new RegExp([
  String.raw`\bwhere\b`,
  String.raw`\blocat(?:ed|ion|ions)\b`,
  String.raw`\blocal(?:ly)?\b`,
  String.raw`\bzips?\b`,
  String.raw`\bzip\s?codes?\b`,
  String.raw`\bpostal\b`,
  String.raw`\bcount(?:y|ies)\b`,
  String.raw`\bboroughs?\b`,
  String.raw`\bregions?\b`,
  String.raw`\bneighbou?rhoods?\b`,
  String.raw`\bnearby\b`,
  String.raw`\bnear\s+(?:me|you)\b`,
  String.raw`\bradius\b`,
  String.raw`\btravel\b`,
  String.raw`\bcommute\b`,
  // "area" only where it means a SERVICE area. Bare "area" was refusing "the
  // minimum area you'll do" and "the trim as a separate area", which are
  // square footage and cost the whole saving to write per workspace.
  String.raw`\b(?:service|coverage|catchment)\s+areas?\b`,
  String.raw`\bwhat\s+areas?\b`,
  String.raw`\bareas?\s+(?:do|that)\s+you\b`,
  // Distance, not time. "How far in advance do I need to book?" is a
  // scheduling question and identical everywhere.
  String.raw`\bhow\s+far\s+(?:do|will|can|would)\s+you\s+(?:travel|go|drive|come)\b`,
].join("|"), "i");

/**
 * The word that made this look location-bound, or null.
 *
 * Returns the WORD rather than a boolean because the refusal has to name it.
 * A person told that "Do you use water-based or oil-based?" depends on where
 * the workspace is does not think "a regex over-matched" — they think the
 * software is broken and go and ask somebody. Told that the word `based` is
 * what flagged it, they can see the mistake instantly and pick the other
 * radio. That one difference turns a support message into a two-second fix.
 */
export function locationTrigger(text: string): string | null {
  const m = LOCATION_BOUND.exec(text ?? "");
  return m ? m[0].trim() : null;
}

export function isLocationBound(text: string): boolean {
  return locationTrigger(text) !== null;
}

export type FaqProblem = { field: "question" | "answer"; why: string };

/**
 * Is this pair safe to put in front of a customer?
 *
 * Returns every problem rather than the first, because somebody fixing a row
 * should see all of it at once rather than discovering the second fault after
 * correcting the first.
 */
export function checkFaq(faq: WorkspaceFaq): FaqProblem[] {
  const problems: FaqProblem[] = [];
  const q = faq.question.trim();
  const a = faq.answer.trim();

  if (!q) problems.push({ field: "question", why: "the question is empty" });
  if (!a) problems.push({ field: "answer", why: "the answer is empty" });

  /**
   * THE SHARED TIER'S ONE HAZARD — CHECKED ON BOTH HALVES OF THE ROW.
   *
   * This read the question only, which is the same mistake this codebase
   * keeps making in a new place: the guard inspected the LABEL and not the
   * sentence the customer actually reads. These both saved as shared:
   *
   *   Q: "Do you offer free estimates?"  A: "Yes, anywhere in Nassau County."
   *   Q: "Do you do exterior work?"      A: "Yes — we cover the greater LA area."
   *
   * Neither question is location-bound. Both answers are, and the answer is
   * the part that gets texted to somebody in another state as fact. It is
   * also the likelier mistake in practice: geography leaks into an answer
   * without the writer thinking about how they worded the question.
   *
   * Checking the answer is what lets the question check be LOOSER than it
   * was. The two compose — "Do you work in the city?" no longer trips on the
   * question, but its real answer says "all five boroughs" and trips there.
   * That is why `office`, `city`, `town`, `based` and bare `area` could come
   * out of the pattern without opening the hole back up.
   */
  if (faq.shared) {
    const inQuestion = q ? locationTrigger(q) : null;
    const inAnswer = a ? locationTrigger(a) : null;
    const where = inQuestion ? "question" : "answer";
    const word = inQuestion ?? inAnswer;
    if (word) {
      problems.push({
        field: where,
        why: `it looks like this depends on where the workspace is — the word "${word}" in `
          + `the ${where} is what flagged it. A service area written once would be wrong in `
          + `every other region, and nothing downstream catches that. Choose "This workspace `
          + `only" above and it will save. If it really is the same everywhere, say so and `
          + `the check can be loosened`,
      });
    }
  }

  if (A_PRICE.test(a)) {
    problems.push({
      field: "answer",
      why: "it contains a price. A1 says the estimator gives numbers, and an answer that "
        + "carries one hands the bot a price to repeat — the validator cannot tell that "
        + "apart from a question answered well",
    });
  }
  if (ANOTHER_COMPANY.test(a)) {
    problems.push({
      field: "answer",
      why: "it points the customer at another company, which A18 forbids: say what we do "
        + "not cover and stop there",
    });
  }
  // A single answer is one message. Something this long is a document.
  if (a.length > 600) {
    problems.push({ field: "answer", why: `it is ${a.length} characters; an answer the bot may send should read as a text message` });
  }
  return problems;
}

/** Only the pairs that are safe, so a bad row cannot reach a prompt. */
export function usableFaqs(faqs: readonly WorkspaceFaq[]): {
  usable: WorkspaceFaq[]; rejected: { faq: WorkspaceFaq; problems: FaqProblem[] }[];
} {
  const usable: WorkspaceFaq[] = [];
  const rejected: { faq: WorkspaceFaq; problems: FaqProblem[] }[] = [];
  for (const f of faqs) {
    const problems = checkFaq(f);
    if (problems.length) rejected.push({ faq: f, problems });
    // `shared` is carried through rather than dropped: checkFaq reads it, so a
    // usable row that loses it would pass a re-check it should have failed.
    else usable.push({
      question: f.question.trim(), answer: f.answer.trim(),
      shared: f.shared, sortOrder: f.sortOrder,
    });
  }
  return { usable, rejected };
}

/**
 * The section that goes into the system prompt.
 *
 * Empty string when there are none, so a workspace with no knowledge base
 * behaves exactly as it does today rather than getting a heading over
 * nothing.
 *
 * The framing matters as much as the content. Without the last two lines a
 * model treats a knowledge base as a script and starts volunteering answers
 * to questions nobody asked — which is a second ask in disguise (A22) and
 * pulls the conversation off the required flow.
 */
export function faqsForPrompt(faqs: readonly WorkspaceFaq[]): string {
  const { usable } = usableFaqs(faqs);
  if (!usable.length) return "";

  return [
    "WHAT THIS WORKSPACE CAN ANSWER.",
    "These are PPP's own answers. Where one covers what the customer asked,",
    "use it rather than improvising, and keep it to a sentence.",
    "",
    usable.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n"),
    "",
    "ONLY WHEN ASKED. Do not volunteer one of these, and never answer more",
    "than what they asked — an unasked answer is a second ask in disguise and",
    "it pulls the conversation off the flow.",
    "If nothing here covers it, say you will find out rather than guessing.",
  ].join("\n");
}
