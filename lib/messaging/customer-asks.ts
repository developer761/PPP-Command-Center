/**
 * Things the customer asked for, read from their own words.
 *
 * Extracted from render.ts because two files now need the same question and
 * they import each other: render.ts asks "did they ask for a call?" to pick a
 * template, and channel-preference.ts asks it to decide A25's phone branch.
 * A shared home rather than a copy in each — "two copies of a rule that must
 * agree" is the most common root cause in this codebase.
 */

/**
 * A customer asking to be phoned, in their own words.
 *
 * Deliberately narrow: "call" has to be aimed at US calling THEM. "I'll call
 * you tomorrow" and "call it a day" are not requests, and "give us a call"
 * on our own literature is not either.
 *
 * TWO MISSES, 2026-10-16, both on A25's phone branch:
 *
 *   "mejor llámenme"   `llam\w*` cannot cross the accent — \w is ASCII, so
 *                      "llá" stops it dead — and the enclitic "-me" is
 *                      inside the word where \bme\b cannot see it. The
 *                      imperative with its pronoun attached is how Spanish
 *                      asks for a call, so it is matched whole.
 *   "give me a call tomorrow at 3"
 *                      "call" with nothing aimed at me after it, and no
 *                      "can/could/please" before it. "give ME a call" only:
 *                      "give us a call" is still our own literature. "a
 *                      call" and not "a ring": the idioms stay the
 *                      documented limit call-not-text-routing.test.ts pins.
 */
export const ASKED_FOR_A_CALL =
  /\b(?:call|llam\w*|telefone\w*)\b[^.?!]{0,24}\b(?:me|us|him|her|back|conmigo|me\s+llame)\b|\b(?:can|could|please|prefer|rather)\b[^.?!]{0,30}\b(?:call|speak|talk|phone)\b|\bhablar\s+por\s+tel[eé]fono\b|\bque\s+me\s+llamen\b|\b(?:ll[aá]m(?:e|en|a)|m[aá]rqu(?:e|en)|telefon[eé](?:e|en))(?:me|nos)\b|\bgive\s+me\s+a\s+call\b/i;

/**
 * A WRONG NUMBER WENT TO THE AGENT AND GOT "PERFECT, THANKS."
 *
 * Found by the audit against Kate's real corpus, 2026-10-16. "Wrong number"
 * was an ordinary text, the model could choose `acknowledge`, and a stranger
 * was thanked while the follow-up cadence carried on texting them. Kate's
 * END_STATES already says where it belongs: Bailout — "Wrong person, chose
 * another company, something negative, or vulgar language."
 *
 * ── WHAT MUST NOT MATCH ─────────────────────────────────────────────────
 *
 * A customer CORRECTING the number they gave us is the opposite situation —
 * a live lead handing us the right one. "I gave you the wrong number, it's
 * 516…" ending the conversation as a wrong person loses the lead with the
 * fix in the same message. So a message that says WE got it wrong by THEIR
 * doing (I gave / put / typed), or carries a phone number, is not this.
 * "Wrong number of rooms" counts something, and "the number on the door is
 * wrong" names no wrong number at all.
 */
const WRONG_NUMBER =
  /\bwrong\s+(?:(?:number|person|phone)\b|#)(?!\s+of\b)|\bn[úu]mero\s+equivocado\b|\bpersona\s+equivocada\b|\bse\s+equivoc[a-zóé]*\s+de\s+(?:n[úu]mero|persona)\b|\bno\s*(?:one|body)\s+(?:here\s+)?(?:by|with|named)\s+that\s+name\b|\bnadie\s+(?:aqu[íi]\s+)?(?:con|se\s+llama)\b/i;

/** "I gave you the wrong number" — the customer's own mistake, being fixed. */
const OWN_MISTAKE =
  /\b(?:i|we)\s+(?:gave|put|entered|typed|wrote|listed|left|sent|used)\b[^.!?]{0,24}\bwrong\b|\bmy\s+(?:correct|right|real|new|actual|cell|other)\s+(?:number|#|phone)\b|\d{3}\D{0,3}\d{3}\D{0,2}\d{4}/i;

export function saidWrongNumber(text: string | null | undefined): boolean {
  const t = text ?? "";
  return WRONG_NUMBER.test(t) && !OWN_MISTAKE.test(t);
}
