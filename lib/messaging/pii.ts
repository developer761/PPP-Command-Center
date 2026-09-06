/**
 * Strip personal data out of a transcript before it reaches a model.
 *
 * PPP's rule, and a sensible one: names, addresses, phone numbers and emails
 * come out first. What the model needs from a past conversation is its SHAPE —
 * how the question was asked, what order things were collected in, how a
 * refusal was handled. None of that requires knowing who the person was.
 *
 * Replacements are placeholders rather than deletions, because
 * "Is [ADDRESS] correct?" still teaches the pattern while "Is  correct?"
 * teaches a malformed sentence.
 *
 * Deliberately conservative in the safe direction: over-redacting costs a
 * slightly less specific training example, under-redacting puts a customer's
 * address into a model prompt.
 */

export type ScrubResult = {
  text: string;
  found: { kind: PiiKind; count: number }[];
};

export type PiiKind = "email" | "phone" | "address" | "name" | "zip";

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Deliberately loose — it should catch "516-344-8418", "(516) 344 8418",
// "5163448418" and "+1 516 344 8418". A false positive redacts a number that
// was not a phone; a false negative leaks one that was.
const PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

// Street addresses: a number followed by words ending in a street-type word.
// This is the shape PPP's customers actually send — "42 Hillcrest Ave",
// "118 Bayview Rd, Sayville 11782".
const ADDRESS =
  /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,4}(?:st(?:reet)?|ave(?:nue)?|rd|road|dr(?:ive)?|ln|lane|blvd|boulevard|ct|court|cir(?:cle)?|pl(?:ace)?|way|ter(?:race)?|pkwy|parkway|hwy|highway)\b\.?/gi;

// US ZIP. Bounded so it does not eat a 5-digit price or a year.
const ZIP = /\b\d{5}(?:-\d{4})?\b/g;

/**
 * Scrub a transcript. `knownNames` are values taken from the row's own name
 * columns — scrubbing a name we were TOLD is far more reliable than trying to
 * detect names in free text, which either misses them or redacts ordinary
 * words like "Bill" and "Rose".
 */
export function scrub(text: string, knownNames: string[] = []): ScrubResult {
  const found: Record<PiiKind, number> = { email: 0, phone: 0, address: 0, name: 0, zip: 0 };
  let out = text;

  const replace = (re: RegExp, kind: PiiKind, token: string) => {
    out = out.replace(re, () => { found[kind]++; return token; });
  };

  // Email before phone: an address like a1234567890@x.com would otherwise
  // have its digits eaten by the phone pattern first.
  replace(EMAIL, "email", "[EMAIL]");
  replace(PHONE, "phone", "[PHONE]");
  replace(ADDRESS, "address", "[ADDRESS]");
  replace(ZIP, "zip", "[ZIP]");

  // Names last, and only ones we were given. Longest first so "Mary Ellen
  // Smith" is replaced whole rather than leaving "Ellen Smith" behind after
  // "Mary" matches.
  const names = [...new Set(knownNames.flatMap(splitName))]
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const n of names) {
    const re = new RegExp(`\\b${escapeRe(n)}\\b`, "gi");
    out = out.replace(re, () => { found.name++; return "[NAME]"; });
  }

  return {
    text: out,
    found: (Object.keys(found) as PiiKind[])
      .filter((k) => found[k] > 0)
      .map((k) => ({ kind: k, count: found[k] })),
  };
}

/** "Marisol Vega" → ["Marisol Vega", "Marisol", "Vega"]. Full name first so it
 *  is replaced as a unit before the parts are tried. */
function splitName(full: string): string[] {
  const clean = full.trim();
  if (!clean) return [];
  const parts = clean.split(/\s+/).filter((p) => p.length >= 3);
  return [clean, ...parts];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Anything left that looks personal. Used to warn BEFORE import rather than
 *  discover afterwards. */
export function residualPii(text: string): PiiKind[] {
  const out: PiiKind[] = [];
  if (EMAIL.test(text)) out.push("email");
  EMAIL.lastIndex = 0;
  if (PHONE.test(text)) out.push("phone");
  PHONE.lastIndex = 0;
  if (ADDRESS.test(text)) out.push("address");
  ADDRESS.lastIndex = 0;
  return out;
}
