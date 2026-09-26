/**
 * MORE THAN ONE PROPERTY IN ONE CONVERSATION.
 *
 * Hatch parity gap 6, verbatim: "Multiple properties: gather info for each
 * property one at a time. Complete the full flow for the first, then repeat
 * for the next. Contact info can be reused if it applies to both."
 *
 * ── WHY OUR FLOW CANNOT EXPRESS THIS TODAY ──────────────────────────────
 *
 * FLOW_ORDER is a linear four-stage sequence and stageFromIntents counts the
 * intents already used. Asking for a second address therefore reads as going
 * BACKWARDS (out_of_order) or as asking for a field we already hold (A13), so
 * the two guards that make the flow trustworthy are exactly the two that stop
 * it handling a second property.
 *
 * ── WHAT THIS BUILDS, AND WHAT IT DOES NOT ──────────────────────────────
 *
 * BUILT: the bot notices a second property, is allowed to ask for its address
 * without tripping the held-field guard, and CANNOT close the conversation
 * claiming success while a property it was told about has no address.
 *
 * NOT BUILT: per-property state. The record holds one address and one scope,
 * so "which of the two is this zip for" is not answerable from the schema.
 * Doing it properly means a properties table and a stage machine that knows
 * which one it is on, which is a schema change and an Iteration 2 shape.
 *
 * That split is deliberate rather than partial. The failure this prevents —
 * closing a two-property job having collected one — is the expensive one: a
 * second property is a second job, and it is lost silently because the
 * conversation looks complete. Asking twice is merely untidy.
 *
 * Pure.
 */

/**
 * Words that mean a PLACE, not a part of one.
 *
 * "Two rooms" and "three bedrooms" are one property. "Two houses" and "my
 * rental as well" are two. Getting this wrong in the loose direction makes
 * the bot ask for a second address that does not exist, which is worse than
 * missing one — the customer has to correct it.
 */
const PLACE =
  "(?:propert(?:y|ies)|house|houses|home|homes|building|buildings|unit|units|rental|rentals|condo|condos|apartment|apartments|address|addresses|location|locations|place|places|duplex|storefront)";

/** "two houses", "3 properties", "both places" */
const COUNTED = new RegExp(
  `\\b(?:two|three|four|both|several|multiple|\\d+)\\s+(?:different\\s+|separate\\s+)?${PLACE}\\b`, "i"
);

/** "my rental too", "and the other house", "also my condo" */
const ANOTHER = new RegExp(
  `\\b(?:another|a\\s+second|the\\s+other|my\\s+other|as\\s+well\\s+as|plus)\\s+(?:\\w+\\s+){0,2}${PLACE}\\b`
  + `|\\b${PLACE}\\b[^.?!]{0,30}\\b(?:too|as well|also)\\b`
  + `|\\b(?:also|and)\\s+(?:my|our|the)\\s+(?:\\w+\\s+){0,2}${PLACE}\\b`, "i"
);

/**
 * Has the customer told us about more than one property?
 *
 * Reads the whole thread: "and my rental too" often arrives a turn or two
 * after the first address, and by then the flow has moved on.
 */
export function mentionsSecondProperty(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  return COUNTED.test(t) || ANOTHER.test(t);
}

export function threadMentionsSecondProperty(customerMessages: readonly string[]): boolean {
  return customerMessages.some((m) => mentionsSecondProperty(m));
}

/**
 * How many distinct addresses the conversation has actually collected.
 *
 * Counted from what was CONFIRMED rather than from what was asked, because
 * asking twice and receiving once is the shape this exists to catch.
 */
export function addressesCollected(addresses: readonly (string | null | undefined)[]): number {
  const seen = new Set(
    addresses
      .map((a) => (a ?? "").trim().toLowerCase().replace(/[.,]/g, ""))
      .filter((a) => a.length > 0)
  );
  return seen.size;
}

/**
 * May the conversation close as a success?
 *
 * False when a second property was mentioned and only one address is held.
 * Spec-adjacent but really just arithmetic: a second property is a second
 * job, and closing without its address loses it silently — the conversation
 * looks complete, so nobody goes looking.
 */
export function secondPropertyOutstanding(input: {
  customerMessages: readonly string[];
  addressesHeld: readonly (string | null | undefined)[];
}): boolean {
  if (!threadMentionsSecondProperty(input.customerMessages)) return false;
  return addressesCollected(input.addressesHeld) < 2;
}

/**
 * Hatch's own guidance, as the line to send.
 *
 * "Complete the full flow for the first, then repeat for the next." So the
 * ask names which one it is about, or the customer cannot tell which address
 * we want.
 */
export function askSecondPropertyAddress(): string {
  return "Got it. And what's the address for the second property?";
}

export function askSecondPropertyAddressEs(): string {
  return "Entendido. ¿Y cuál es la dirección de la segunda propiedad?";
}

/**
 * "Contact info can be reused if it applies to both."
 *
 * So the contact leg is NOT repeated per property, and a bot that asks for a
 * phone number twice because there are two houses is making the A13 mistake
 * the rest of the flow works to avoid.
 */
export const CONTACT_IS_SHARED_ACROSS_PROPERTIES = true;
