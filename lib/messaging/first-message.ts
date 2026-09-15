/**
 * What the first text to a new lead has to say.
 *
 * Karan, 2026-09-15: give us a way to write the first message, with the part
 * we HAVE to say ("stop to unsubscribe") built in.
 *
 * Carrier rules (CTIA) for a first message: say who is texting, and how to
 * stop. PPP's own opener already does both ("Hello, this is Precision
 * Painting Plus ... Reply END to stop texts."). This makes it a rule rather
 * than a habit: the editor shows the checklist, and saving or publishing a
 * first message that fails it is refused with the reason.
 *
 * The gate still appends "Reply STOP to opt out." to the first message
 * anybody receives if it somehow lacks one. That is the backstop; this is the
 * rule. Both use the same test for "already says how to stop", from here, so
 * the editor and the gate cannot disagree.
 *
 * Pure, and safe to import in the browser (the gate is not: it pulls in the
 * carrier transport).
 */

export const OPT_OUT_DISCLOSURE = "Reply STOP to opt out.";

/** The company, as a customer would recognise it. */
export const BUSINESS_NAME = "Precision Painting Plus";

/** Already tells them how to stop? Any of the keywords the system honours. */
const HAS_DISCLOSURE =
  /\b(?:reply|text|send)\s+(?:"|')?(?:stop|end|quit|cancel|unsubscribe)\b|\bopt[- ]?out\b|\bto\s+unsubscribe\b/i;

export function needsDisclosure(body: string): boolean {
  return !HAS_DISCLOSURE.test(body);
}

export function withDisclosure(body: string): string {
  const t = body.trim();
  if (!t || !needsDisclosure(t)) return t;
  // A full stop first, so it does not run into the sentence before it.
  return /[.!?]$/.test(t) ? `${t} ${OPT_OUT_DISCLOSURE}` : `${t}. ${OPT_OUT_DISCLOSURE}`;
}

const NAMES_BUSINESS = /precision\s+painting\s+plus/i;

export type Check = { key: "business_name" | "opt_out"; ok: boolean; label: string; fix: string };

export function firstMessageChecks(body: string): Check[] {
  return [
    {
      key: "business_name",
      ok: NAMES_BUSINESS.test(body),
      label: `Says who it is from (${BUSINESS_NAME})`,
      fix: `Add "This is ${BUSINESS_NAME}."`,
    },
    {
      key: "opt_out",
      ok: !needsDisclosure(body),
      label: `Tells them how to stop ("${OPT_OUT_DISCLOSURE}")`,
      fix: `Add "${OPT_OUT_DISCLOSURE}"`,
    },
  ];
}

/** The reason a first message cannot be saved, or null when it can. */
export function firstMessageProblem(body: string): string | null {
  const missing = firstMessageChecks(body).filter((c) => !c.ok);
  if (!missing.length) return null;
  return `The first message has to ${missing.map((c) => c.key === "business_name"
    ? `say it is from ${BUSINESS_NAME}`
    : `tell them how to stop, for example "${OPT_OUT_DISCLOSURE}"`).join(" and ")}.`;
}

/** Apply one fix: the name goes at the front, the opt-out line at the end. */
export function applyFirstMessageFix(body: string, key: Check["key"]): string {
  const t = body.trim();
  if (key === "opt_out") return withDisclosure(t);
  if (NAMES_BUSINESS.test(t)) return t;
  return t ? `This is ${BUSINESS_NAME}. ${t}` : `This is ${BUSINESS_NAME}.`;
}

/** Which step is the first text: the lowest-ordinal SMS step. Emails do not count. */
export function openerStepId(steps: { id: string; ordinal: number; channel: string }[]): string | null {
  const sms = steps.filter((s) => s.channel === "sms").sort((a, b) => a.ordinal - b.ordinal);
  return sms[0]?.id ?? null;
}

/** Segments a text will be billed as. GSM-7 only; an emoji makes it 70 per. */
export function smsSegments(body: string): number {
  const unicode = /[^\x00-\x7F£¥èéùìòÇØøÅåÆæßÉÄÖÑÜ§¿äöñüà]/.test(body);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  // Unicode texts are counted in UTF-16 units, which is what a carrier bills:
  // an emoji is two. Plain text is one per character.
  const n = unicode ? body.length : [...body].length;
  if (n <= single) return 1;
  return Math.ceil(n / multi);
}
