/**
 * The client's last name, for the PO number.
 *
 * Jason, testing the paint tool with Adler and Ido (2026-09-24): "please add
 * clients last name as part of the po number". A vendor's desk deals in names,
 * not eight-digit work orders — "00318847 Smith" is something a counter person
 * can find a job by, and PPP's own team can too.
 *
 * Salesforce gives us an ACCOUNT NAME, which on a residential job is a person
 * and on a commercial one is a company. This takes the last word of a person's
 * name and the first word of a company's, because that is what each is known
 * by, and returns "" when there is nothing usable — a PO is better bare than
 * carrying the word "Unknown".
 */

/** Generational and professional suffixes — never the name PPP would say. */
const SUFFIXES = new Set([
  "jr", "jr.", "sr", "sr.", "ii", "iii", "iv", "v",
  "md", "m.d.", "phd", "ph.d.", "dds", "esq", "esq.", "cpa", "ret", "ret.",
]);

/** Words that mean the account is an organization, not a person. */
const COMPANY_WORDS =
  /\b(llc|l\.l\.c|inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.|company|ltd|ltd\.|limited|lp|llp|pllc|group|holdings|properties|property|management|realty|associates|partners|enterprises|condo|condominium|coop|co-op|hoa|apartments|apts|residences|association|trust|church|school|hospital|hotel|restaurant|bank)\b/i;

export function clientLastName(accountName: string | null | undefined): string {
  const raw = String(accountName ?? "")
    // Notes people park in the name field — "(do not mail)", "[DNC]". Left in,
    // the last word of the name becomes "mail".
    .replace(/[（(\[][^）)\]]*[）)\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";

  // A company FIRST: "Tomco Painting, Inc." has a comma and is not a person,
  // and the reversal rule below would answer "Painting".
  if (COMPANY_WORDS.test(raw)) return clean(raw.split(" ")[0] ?? "");

  // "Smith, John" — the surname is what precedes the comma. PPP's Salesforce
  // carries both orders, and guessing the wrong end of this one is the easiest
  // way to put a customer's FIRST name on a purchase order.
  const comma = raw.indexOf(",");
  if (comma > 0) {
    const before = raw.slice(0, comma).trim();
    // …unless what follows is a suffix ("Smith, Jr."), in which case the comma
    // is punctuation inside one name rather than a reversal.
    const after = raw.slice(comma + 1).trim().toLowerCase();
    // …or a bare number. "Testing Paint Hub, 2" is a DUPLICATE-ACCOUNT marker,
    // not a name reversal, and reading it as one put "Hub" on a live purchase
    // order and in its email subject (Katie, 2026-10-01: "Remove Hub from PO +
    // subject line"). Nobody's surname is "2", and an account somebody had to
    // number is not the person the PO is for — so this returns no name at all
    // rather than guessing a better word out of the same string.
    if (/^\d+$/.test(after)) return "";
    if (before && !SUFFIXES.has(after)) return clean(before.split(" ").pop() ?? "");
  }

  // A person: the last word that is not a suffix. "John Smith Jr." → Smith.
  const words = raw.split(" ").filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = clean(words[i]);
    if (!w) continue;
    if (SUFFIXES.has(words[i].toLowerCase().replace(/[^a-z.]/g, ""))) continue;
    return w;
  }
  return "";
}

/** Strip anything that is not part of a name. A PO number travels through a
 *  vendor's order system and an email subject; punctuation earns nothing. */
function clean(word: string): string {
  return word.replace(/[^\p{L}\p{N}'\-]/gu, "").replace(/^[-']+|[-']+$/g, "").slice(0, 24);
}

/**
 * The PO number PPP quotes: the work order number, then the client's name.
 *
 * Kept as one function so the draft and the send-time retry cannot disagree —
 * a row storing "00318847 Smith" under an email saying "00318847" is the same
 * defect the PO-collision retry was written to prevent.
 */
export function poBaseFor(woNumber: string, accountName: string | null | undefined): string {
  const last = clientLastName(accountName);
  return last ? `${woNumber} ${last}` : woNumber;
}
