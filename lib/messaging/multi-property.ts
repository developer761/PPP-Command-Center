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

import { addressFromCustomer } from "./address";

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
 *
 * ── DEDUPED ON HOUSE NUMBER AND ZIP, NOT ON THE STRING ──────────────────
 *
 * Because a customer repeats an address in different words. "12 Oak St,
 * 11530" and "12 Oak Street, 11530" are one property, and a string compare
 * calls them two — which would satisfy the second-property check with one
 * property and close over the very job this is here to protect. The house
 * number and the zip together identify a property closely enough for that
 * question, and two genuinely different places almost never share both.
 */
function addressKey(raw: string): string {
  const norm = raw.trim().toLowerCase().replace(/[.,]/g, "");
  const number = /^\s*(\d+[a-z]?)\b/.exec(norm)?.[1];
  const zip = /\b(\d{5})\b/.exec(norm)?.[1];
  // Both halves present is the ordinary case, and the only one where a key
  // narrower than the whole string is safe.
  return number && zip ? `${number}|${zip}` : norm;
}

export function addressesCollected(addresses: readonly (string | null | undefined)[]): number {
  const seen = new Set(
    addresses
      .map((a) => (a ?? "").trim())
      .filter((a) => a.length > 0)
      .map(addressKey)
  );
  return seen.size;
}

/**
 * EVERY ADDRESS THE THREAD HOLDS — which is the whole point, and was the bug.
 *
 * The caller used to build this from the single `customer_address` field, so
 * the list could never have more than ONE entry. `addressesCollected(...) < 2`
 * was therefore permanently true from the moment a second property was
 * mentioned, and `success` was refused for the life of the conversation — on
 * every turn, for ever, no matter how many addresses the customer typed.
 *
 * Nothing looked broken: twenty other intents stayed available, so the bot
 * kept talking and the lead simply ended as a follow-up instead of a booked
 * estimate. A whole class of lead that could not convert, with no error
 * anywhere. The "silent nothing" shape again.
 *
 * The record still WINS for the first address — it is the office's version —
 * but the thread is read for the others, because the schema has one column and
 * a customer with two houses types two addresses into the chat. Per-property
 * state is still Iteration 2 (see the header); counting them is not.
 */
export function addressesInThread(input: {
  /** Every customer message in the thread, oldest first, including the latest. */
  customerMessages: readonly string[];
  /** The address on the record, if any. Kept first: the office's version. */
  onFile?: string | null;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (a: string | null | undefined) => {
    const v = (a ?? "").trim();
    if (!v) return;
    const key = addressKey(v);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  add(input.onFile);
  for (const m of input.customerMessages) add(addressFromCustomer(m));
  return out;
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
