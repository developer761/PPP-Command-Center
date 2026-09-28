/**
 * The email address a customer typed, when there is exactly one and it is
 * unmistakably theirs.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * The bot asks "Can I grab your name and email for the quote?", the customer
 * answers, and nothing kept the answer. `customer_email` is written once at
 * enrolment from the lead and never again — the same hole `inquiry_scope` and
 * `customer_address` each had, found the same way and fixed the same way.
 *
 * It is the worst of the three, because the email is not bookkeeping. On the
 * off-site route the quote GOES to it (A6, A7). So the bot asked a question,
 * the customer answered it, the answer was discarded, and the thing the answer
 * was for could not happen.
 *
 * ── WHY THIS IS STRICTER THAN addressFromCustomer ───────────────────────
 *
 * A wrong address is a bad record. A wrong email is a message to a stranger:
 * `customer_email` is what scheduler-db passes as `toEmail`. So where the
 * address parser takes the first plausible match, this refuses anything it is
 * not sure of, and returns null rather than guessing:
 *
 *   TWO ADDRESSES       "mine's tom@a.com but send it to my wife jan@b.com"
 *                       has no single answer. Which one is a judgement about
 *                       who the customer is, and a person should make it.
 *   ONE OF OURS         somebody asking "should I email you at info@<us>?"
 *                       is naming our address, not giving theirs. Storing it
 *                       would make the system send the quote to itself.
 *
 * Both return null, which leaves the record as it was and the leg uncollected
 * — the bot asks again, which is the safe direction to be wrong in.
 *
 * Never scan our own sentences with this. A reaction arrives as
 * `Liked "<our message>"`, so the caller passes the customer's OWN words —
 * normalizeInbound().text — exactly as the address path does.
 *
 * Pure.
 */
import { PPP_BRAND } from "../brand";

/**
 * Deliberately conservative: a single-label TLD of at least two letters, no
 * trailing dot, no consecutive dots. It is matching something a person typed
 * into a phone, not validating against the RFC.
 */
const AN_EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/** Our own domains, which a customer naming is not a customer giving. */
function ourDomains(extra?: readonly (string | null | undefined)[]): string[] {
  const fromBrand = PPP_BRAND.contact.website
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  const fromCallers = (extra ?? [])
    .map((e) => (e ?? "").split("@")[1]?.trim().toLowerCase())
    .filter((d): d is string => !!d);
  return [fromBrand, ...fromCallers];
}

export function emailFromCustomer(
  text: string | null | undefined,
  opts: { ours?: readonly (string | null | undefined)[] } = {}
): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;

  const ours = ourDomains(opts.ours);
  const found = [...new Set((t.match(AN_EMAIL) ?? []).map((e) => e.toLowerCase()))];

  // Ours is not theirs. Dropped BEFORE the count, so "email you at info@<us>?
  // mine is tom@example.com" still resolves to the one they gave.
  const theirs = found.filter((e) => {
    const domain = e.split("@")[1] ?? "";
    return !ours.some((d) => domain === d || domain.endsWith(`.${d}`));
  });

  // Exactly one, or a person decides. See the header.
  return theirs.length === 1 ? theirs[0] : null;
}
