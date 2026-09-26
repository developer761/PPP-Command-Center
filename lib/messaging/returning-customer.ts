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
 * Is this a returning customer declining to repeat themselves?
 *
 * Both halves required. "You painted my kitchen last year and now I need the
 * deck" is a returning customer giving us work, not refusing a field.
 */
export function returningCustomerDeclining(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return WORKED_WITH_US_BEFORE.test(t) && RATHER_NOT_REPEAT.test(t);
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
  return "¡Gracias por contar con nosotros de nuevo! Solo nos gusta confirmar que todo siga correcto por si algo ha cambiado. ¿Le importaría confirmarme la dirección?";
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
  const declined = customerMessages.some((m) => returningCustomerDeclining(m));
  if (!declined) return false;
  return botMessages.some((m) => m.includes("still accurate") || m.includes("siga correcto"));
}
