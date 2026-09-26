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
 */
export const ASKED_FOR_A_CALL =
  /\b(?:call|llam\w*|telefone\w*)\b[^.?!]{0,24}\b(?:me|us|him|her|back|conmigo|me\s+llame)\b|\b(?:can|could|please|prefer|rather)\b[^.?!]{0,30}\b(?:call|speak|talk|phone)\b|\bhablar\s+por\s+tel[eé]fono\b|\bque\s+me\s+llamen\b/i;
