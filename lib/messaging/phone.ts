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

  // Already international and not +1: accept if it is plausibly E.164. We do
  // not validate foreign numbering plans — we just refuse to mangle them.
  if (hadPlus && !s.startsWith("1")) {
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
