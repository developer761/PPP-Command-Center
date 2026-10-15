/**
 * Phone numbers, normalised to E.164.
 *
 * This exists because the suppression list is keyed by number. If
 * "(516) 344-8418", "516-344-8418" and "5163448418" can become three different
 * strings, then one of them is a row we never check, and we text somebody who
 * told us to stop. Every number entering the system — from Salesforce, from an
 * inbound webhook, from the Hatch opt-out import, from a human typing into the
 * office UI — goes through here first.
 *
 * Deliberately narrow: PPP operates in the US, so this assumes NANP (+1) when
 * no country code is given. It does NOT try to be a general international
 * parser. A number it cannot confidently normalise returns null rather than a
 * guess, because a wrong number is worse than a missing one: a guess sends a
 * stranger somebody else's appointment details.
 */

/** A number that has been through `toE164` and is safe to store or compare. */
export type E164 = string & { readonly __e164: unique symbol };

const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Is this already a well-formed E.164 string? */
export function isE164(v: string): v is E164 {
  return E164_RE.test(v);
}

/**
 * Normalise a human-entered or upstream-supplied number to E.164, or null.
 *
 * Handles the shapes that actually arrive: parentheses, dashes, dots, spaces,
 * non-breaking spaces, a leading 1, a leading +1, and the "tel:" prefix that
 * comes off an href. Rejects anything that is not a plausible NANP number,
 * including the classic 555 test range and numbers whose area code or exchange
 * starts with 0 or 1 — those cannot exist, so a value that looks like one is
 * bad data rather than a customer.
 */
export function toE164(raw: string | null | undefined): E164 | null {
  if (!raw) return null;

  let s = String(raw)
    .normalize("NFKC")
    .replace(/^tel:/i, "")
    // Strip an extension before stripping punctuation, or "x123" becomes digits.
    .replace(/\s*(?:ext|x|extension)\.?\s*\d+\s*$/i, "")
    .trim();

  const hadPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (!s) return null;

  /**
   * A "+" IN FRONT OF A TEN-DIGIT US NUMBER IS A TYPO, NOT A COUNTRY CODE.
   *
   * Found 2026-10-15 by listing every non-US number in the real lead data.
   * Eight of 2,042 are not +1, and six of those eight are plainly local:
   *
   *   +5165286105  +5163611799  +5164769219  +5164455205   516, Nassau
   *   +6465650369                                          646, Manhattan
   *   +6099531140                                          609, New Jersey
   *
   * All six arrived from Meta, where somebody typed a "+" before a ten-digit
   * number. Read as international, +5165286105 is +51 65286105 — Peru, and
   * not a valid Peruvian number either, so the message silently fails and a
   * real Nassau lead is never contacted.
   *
   * The two genuine international numbers in the same data are LONGER:
   * +905544202801 (Turkey, 12 digits) and +233244707688 (Ghana, 12). That
   * length difference is the discriminator, and it is why this is narrow:
   * exactly ten digits, AND the first three and the next three both start
   * 2-9, which is the NANP rule the code below already applies.
   *
   * A genuine ten-digit international number shaped like a NANP number would
   * be mangled by this. It is the right trade for a regional painter whose
   * leads come from US ad targeting: today those six are lost silently,
   * which is the worse failure and the harder one to notice.
   */
  const looksNanp = s.length === 10 && /^[2-9]/.test(s.slice(0, 3)) && /^[2-9]/.test(s.slice(3, 6));
  if (hadPlus && !s.startsWith("1") && !looksNanp) {
    const intl = `+${s}`;
    return isE164(intl) ? (intl as E164) : null;
  }

  // NANP: 10 digits, or 11 with a leading country code 1.
  if (s.length === 11 && s.startsWith("1")) s = s.slice(1);
  if (s.length !== 10) return null;

  const area = s.slice(0, 3);
  const exchange = s.slice(3, 6);
  // NANP rules: area code and exchange both start 2-9.
  if (!/^[2-9]/.test(area) || !/^[2-9]/.test(exchange)) return null;
  // 555-01XX is the reserved fictional range. Real data never contains it, so
  // its presence means a test fixture leaked into production input.
  if (exchange === "555" && /^01/.test(s.slice(6))) return null;

  const out = `+1${s}`;
  return isE164(out) ? (out as E164) : null;
}

/** Format for display in the office UI. Never for storage or comparison. */
export function formatUs(e164: E164): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
