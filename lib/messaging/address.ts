/**
 * How much of an address we actually hold.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * A11 is the most broken CRITICAL rule in Kate's grading: 287 breaches across
 * 1,234 conversations. It says "Ask only for the MISSING part of a partial
 * address."
 *
 * The bot could not obey it, because the only question the code could ask
 * about an address was whether there was one. `knownFields.address` is a
 * boolean. A customer who had given "482 Marchmont Ave" was either holding an
 * address (so the ask was refused and the conversation stalled with no zip) or
 * not holding one (so the bot asked for the whole thing again, which is the
 * breach). There was no third answer available, and A11 is entirely about the
 * third answer.
 *
 * ── WHAT COUNTS AS COMPLETE ─────────────────────────────────────────────
 *
 * Street and zip. Karan, 2026-09-22: "We only need Zip and street. We should
 * be able to fill in the city and state based off the zip."
 *
 * That is not a shortcut, it is how PPP's own data works: the 2,194 curated
 * Zip_Code__c rows carry City__c and State__c, so a zip resolves to a city and
 * a state and to the service territory that decides routing. Asking a customer
 * to type a city we can look up is asking them to do our work, which is the
 * family of complaint A11 and A13 both belong to.
 *
 * Pure. No database, no network.
 */

/** US ZIP, five digits with an optional plus-four. */
const ZIP = /\b(\d{5})(?:-\d{4})?\b/;

/**
 * A street line: a house number followed by at least one word.
 *
 * Deliberately looser than the scrubber's version in pii.ts, and the
 * difference matters. That one is deciding whether to REDACT, where a miss
 * leaks a customer's address, so it insists on a street-type word. This one
 * is deciding whether to ASK AGAIN, where a miss means pestering somebody for
 * something they already sent. "12 Hillcrest" and "1400 Ocean Parkway Apt 3B"
 * both have to count.
 *
 * Anchored to a digit-led token so a bare zip does not read as a street.
 */
const STREET = /\b\d{1,6}[A-Za-z]?\s+[A-Za-z][A-Za-z0-9.'-]*/;

export type AddressParts = {
  /** The street line as the customer wrote it, or null. */
  street: string | null;
  /** Five-digit zip, plus-four dropped, or null. */
  zip: string | null;
};

export function addressParts(raw: string | null | undefined): AddressParts {
  const t = (raw ?? "").trim();
  if (!t) return { street: null, zip: null };

  const zipMatch = ZIP.exec(t);
  const zip = zipMatch ? zipMatch[1] : null;

  // Look for the street in the text with the zip removed, so "11782" in
  // "Sayville 11782" cannot be read as a house number for "Sayville".
  const withoutZip = zipMatch ? t.replace(zipMatch[0], " ") : t;
  const streetMatch = STREET.exec(withoutZip);

  return { street: streetMatch ? streetMatch[0].trim() : null, zip };
}

/**
 * What is still missing, in the words the renderer needs.
 *
 * `null` means complete: street and zip are both held, and city and state are
 * ours to look up rather than theirs to type.
 */
export type AddressGap = "street" | "zip" | "both" | null;

export function addressGap(raw: string | null | undefined): AddressGap {
  const { street, zip } = addressParts(raw);
  if (street && zip) return null;
  if (street) return "zip";
  if (zip) return "street";
  return "both";
}

/** True when there is nothing left to ask about the address. */
export function addressIsComplete(raw: string | null | undefined): boolean {
  return addressGap(raw) === null;
}
