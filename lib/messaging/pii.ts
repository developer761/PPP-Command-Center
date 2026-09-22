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
//
// Up to three separators between the groups, not one: a customer typed their
// number as "305  469 6767" with a double space and it went through the
// scrubber untouched (found importing Kate's CSV, 2026-09-15).
const PHONE = /(?:\+?1[\s.-]{0,3})?(?:\(\d{3}\)|\d{3})[\s.-]{0,3}\d{3}[\s.-]{0,3}\d{4}\b/g;

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

  // NICKNAMES AND MISSPELLINGS, which exact matching cannot reach.
  //
  // The name on the record is not the name in the conversation. Checked
  // against Kate's 1,234 real transcripts, exact matching left Victoria as
  // "Vicky", Ashutosh as "Ashu", Paolo as "Paola" and Alison as "Allison" —
  // the customer's own name, sitting in text headed for a prompt.
  //
  // So: any capitalised word that either starts with the same three letters
  // as a name we were given, or is one typo away from it, is treated as that
  // name. Over-redacting costs a slightly vaguer example. Under-redacting
  // puts a real customer's name in front of a model.
  const roots = names.filter((n) => n.length >= 4);
  if (roots.length) {
    out = out.replace(/\b[A-Z][a-z]{2,}\b/g, (word) => {
      if (word === "NAME") return word;
      const w = word.toLowerCase();
      const hit = roots.some((n) => {
        const r = n.toLowerCase();
        if (r === w) return true;
        if (r.slice(0, 3) === w.slice(0, 3)) return true;
        return withinOneEdit(r, w);
      });
      if (!hit) return word;
      found.name++;
      return "[NAME]";
    });
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

/**
 * Is `b` reachable from `a` by one insertion, deletion or substitution?
 *
 * Catches the doubled letter (Alison / Allison) and the dropped one, which is
 * how a name written down once and typed again differs. Not a general edit
 * distance — bailing at the first mismatch is enough for one edit and keeps
 * this linear over a transcript's worth of words.
 */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (short.length === long.length) i++;
    j++;
  }
  return edits + (long.length - j) + (short.length - i) <= 1;
}

/**
 * Words that follow a greeting and look like somebody's name.
 *
 * The last line of defence, for the names no scrubber can reach. "Amalfi
 * Blanco" is greeted as "Hi Amy" — a real nickname with no letters in common,
 * so prefix and typo matching both miss it, and the only honest thing left is
 * to notice that SOMETHING name-shaped is being greeted and refuse to import
 * the row. A conversation skipped costs one training example. A name that gets
 * through is a customer's name in a model prompt.
 *
 * Returns the suspect words so the skip can say what it saw.
 */
const GREETING = /\b(?:hi|hey|hello|thanks|thank you|dear)[,!]?\s+([A-Z][a-z]{2,})\b/g;

/** Words that follow a greeting constantly and are nobody's name. */
const NOT_A_NAME = new Set([
  "There", "Team", "All", "Again", "You", "Guys", "Folks", "Everyone",
  "Good", "Morning", "Afternoon", "Evening", "Yes", "Yeah", "Sure", "Okay",
  "The", "This", "That", "For", "And", "But", "Just", "Sorry", "Happy",
  "Thank", "Thanks", "Sent", "Mrs", "Mr", "Ms", "Rev", "Dr",
  // "Thanks Can you send a quote" is a sentence carrying on, not a greeting.
  // Every one of these was a real false positive on Kate's 1,234 transcripts.
  "Can", "Could", "Would", "Will", "Our", "We", "They", "She", "Her", "His",
  "Please", "Let", "Any", "How", "What", "When", "Where", "Who", "Not",
  "Have", "Had", "Are", "Was", "Its", "Been", "Also", "Then", "Here",
]);

export function suspectedNames(text: string, allow: string[] = []): string[] {
  const ok = new Set(allow.map((a) => a.toLowerCase()));
  const out = new Set<string>();
  for (const m of text.matchAll(GREETING)) {
    const w = m[1];
    if (NOT_A_NAME.has(w) || ok.has(w.toLowerCase())) continue;
    out.add(w);
  }
  return [...out];
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
