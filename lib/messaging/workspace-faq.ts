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
    else usable.push({ question: f.question.trim(), answer: f.answer.trim() });
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
