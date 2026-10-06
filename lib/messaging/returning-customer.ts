/**
 * SOMEBODY WHO HAS WORKED WITH PPP BEFORE.
 *
 * Hatch parity gap 7, verbatim from its prompt:
 *
 *   "If they don't want to provide their information since they have worked
 *    with us before, thank them for considering us for their new project and
 *    let them know we like to doublecheck that everything is still accurate
 *    in case there are any changes. Ask if they'd mind confirming their
 *    address, BUT MOVE ON IF THEY DON'T PROVIDE IT."
 *
 * ── WHY IT NEEDS SAYING AT ALL ──────────────────────────────────────────
 *
 * The required flow is an order, and A3 wants all three legs. A customer who
 * says "you have all this, you painted my kitchen last year" is refusing a
 * leg for a reason that is both true and reasonable — and a bot that keeps
 * asking is exactly the nag A11 and A13 exist to stop, aimed at the customer
 * most likely to buy again.
 *
 * A3's legs are already satisfied by having ASKED rather than by holding a
 * value, so the flow does not strictly jam. What was missing is the
 * permission to MOVE ON after one ask, and the acknowledgement that makes
 * asking once not feel like doubt.
 *
 * ── THE ONE THING IT MUST NOT BECOME ────────────────────────────────────
 *
 * This is not a way to skip collection. It fires only when the customer has
 * said BOTH that they are a returning customer AND that they would rather not
 * repeat themselves. Somebody who merely mentions a previous job is not
 * refusing anything, and the flow carries on as normal.
 *
 * Pure.
 */

/** They are telling us they have used PPP before. */
const WORKED_WITH_US_BEFORE =
  /\b(?:you(?:'ve| have)?\s+(?:already\s+)?(?:painted|done|worked)\b|(?:last|previous|prior)\s+(?:time|year|job|project)\b|\brepeat\s+customer\b|\bused\s+you\s+(?:before|guys)\b|\bworked\s+with\s+(?:you|ppp)\b|\bi(?:'m| am)\s+(?:an?\s+)?(?:existing|returning|repeat)\b|\byou\s+did\s+my\b|\bcustomer\s+(?:of yours|before)\b)/i;

/** They would rather not type it all again. */
const RATHER_NOT_REPEAT =
  /\b(?:you\s+(?:already\s+)?have\b|\bon\s+file\b|\bsame\s+as\s+(?:before|last)\b|\bwhy\s+(?:do\s+)?(?:you|i)\s+need\b|\bagain\??$|\bdon'?t\s+(?:you|i)\s+(?:already\s+)?have\b|\bshouldn'?t\s+you\s+have\b|\bno\s+need\s+to\b|\bisn'?t\s+it\s+on\s+file\b)/i;

/**
 * BOTH HALVES AGAIN, IN SPANISH.
 *
 * returningCustomerReplyEs() was written, approved and unreachable: the two
 * matchers above are English-only, so the Spanish branch in render.ts could
 * never be entered. alreadyAskedToConfirm even looks for that reply's Spanish
 * marker, "siga correcto", which nothing was able to write.
 *
 * The cost falls on the one customer who should never be re-interrogated —
 * somebody PPP has already painted for, saying in Spanish that we have their
 * details, and getting the plain ask again.
 */
const WORKED_WITH_US_BEFORE_ES = new RegExp(
  [
    String.raw`\b(?:ya\s+)?(?:me\s+)?(?:pintaron|pintaste|trabajaron|hicieron)\b`,
    String.raw`\bya\s+(?:soy|somos)\s+clientes?\b`,
    String.raw`\bcliente\s+(?:de\s+ustedes|frecuente|anterior)\b`,
    String.raw`\b(?:el\s+)?a[ñn]o\s+pasado\b[^.?!]{0,30}\b(?:pintaron|trabajaron|hicieron)\b`,
    String.raw`\bla\s+vez\s+(?:pasada|anterior)\b`,
  ].join("|"),
  "i"
);

/** They would rather not type it all again — in Spanish. */
const RATHER_NOT_REPEAT_ES = new RegExp(
  [
    String.raw`\bya\s+(?:la|lo|les|le)?\s*(?:tienen|tiene|tienes)\b`,
    String.raw`\bya\s+(?:se\s+)?(?:la|lo|les)?\s*(?:di|dije|mand[ée]|envi[ée])\b`,
    String.raw`\bno\s+quiero\s+(?:repetir|volver)\b`,
    String.raw`\bpara\s+qu[ée]\s+(?:la|lo|me)\b`,
    String.raw`\bno\s+(?:hace\s+falta|es\s+necesario)\b`,
    String.raw`\botra\s+vez\b`,
  ].join("|"),
  "i"
);

/**
 * Is this a returning customer declining to repeat themselves?
 *
 * Both halves required. "You painted my kitchen last year and now I need the
 * deck" is a returning customer giving us work, not refusing a field.
 *
 * The halves are not mixed across languages: somebody writes in one or the
 * other, and a cross-match would only add false positives.
 */
export function returningCustomerDeclining(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return (WORKED_WITH_US_BEFORE.test(t) && RATHER_NOT_REPEAT.test(t))
    || (WORKED_WITH_US_BEFORE_ES.test(t) && RATHER_NOT_REPEAT_ES.test(t));
}

/**
 * THE SAME RULE, OVER THE THREAD — WHICH IS THE ONLY PLACE IT IS TRUE.
 *
 * Requiring both halves in ONE message is why this never fired. A real
 * conversation splits them across turns, because the two facts belong to
 * different moments:
 *
 *   turn 1  "we used you guys a couple years back for the upstairs"
 *   turn 2  → we ask what the project is
 *   turn 3  → we ask for the address
 *   turn 4  "you already have it"
 *
 * Neither message contains both halves, so the single-message check is false
 * on every turn and the acknowledgement Hatch requires was never sent. The bot
 * just asked again — at the customer most likely to buy again, which is the
 * exact nag this rule exists to prevent. mentionsSecondProperty already reads
 * the whole thread for this reason; this did not.
 *
 * THE TWO HALVES ARE SCOPED DIFFERENTLY, ON PURPOSE:
 *
 *   HAVING WORKED WITH US is a durable fact about the customer. Said once, it
 *   stays true, so it is read from the whole thread.
 *
 *   NOT WANTING TO REPEAT THEMSELVES is a reaction to the question we just
 *   asked. It is read from the LATEST message only, so an old "again?" cannot
 *   make every later turn read as a refusal — which is the loose direction the
 *   header warns about, and it would suppress collection on a returning
 *   customer who is happily answering.
 */
export function returningCustomerDecliningInThread(input: {
  /** Earlier customer messages, oldest first. */
  earlier: readonly string[];
  /** What they just said. The refusal has to be here. */
  latest: string | null | undefined;
}): boolean {
  const latest = (input.latest ?? "").trim();
  if (!RATHER_NOT_REPEAT.test(latest)) return false;
  return WORKED_WITH_US_BEFORE.test(latest)
    || input.earlier.some((m) => WORKED_WITH_US_BEFORE.test((m ?? "").trim()));
}

/**
 * Hatch's response, in our voice.
 *
 * Three beats, in its order: thank them for the NEW project, say why we ask
 * (things change), then one ask. Never a second.
 */
export function returningCustomerReply(): string {
  return "Thanks for thinking of us again for this one! We just like to double check everything is still accurate in case anything has changed. Would you mind confirming the address?";
}

export function returningCustomerReplyEs(): string {
  return "Gracias por contar con nosotros de nuevo! Solo nos gusta confirmar que todo siga correcto por si algo ha cambiado. Le importaría confirmarme la dirección?";
}

/**
 * MOVE ON IF THEY DO NOT PROVIDE IT.
 *
 * True once we have already asked a returning customer to confirm something.
 * The caller uses it to stop asking, not to stop collecting the rest — the
 * other legs are unaffected.
 */
export function alreadyAskedToConfirm(
  customerMessages: readonly string[],
  botMessages: readonly string[]
): boolean {
  /**
   * THREAD-SCOPED, for the same reason as returningCustomerDecliningInThread —
   * and this function had the bug too, which is why capping the acknowledgement
   * at one did not work the first time I wired it. `.some(returningCustomer-
   * Declining)` needs BOTH halves in a single message, and the whole point of
   * the surrounding rule is that they arrive turns apart. So `declined` was
   * false on every real thread and the cap never engaged.
   */
  const declined = customerMessages.some((m, i) => returningCustomerDecliningInThread({
    earlier: customerMessages.slice(0, i),
    latest: m,
  }));
  if (!declined) return false;
  // The only record that we sent it is the sentence itself.
  return botMessages.some((m) => m.includes("still accurate") || m.includes("siga correcto"));
}
