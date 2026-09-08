/**
 * What we already know about the person we are texting.
 *
 * Kate's graded conversations, 2026-09-08, all failed the same way:
 *
 *   "asked customer for phone number + to type out phone number :skull:"
 *   "asked for scope instead of using existing scope information from inquiry"
 *   "would ideally quote the customer's address to them to confirm, not have
 *    to ask them to type it out"
 *   "Would be nice to have a 'scope summary' merge field that can quote the
 *    customer's scope so they don't have to type it out when we already have it"
 *
 * Four notes, one bug: the bot had the inquiry in front of it and asked anyway.
 * Asking somebody to type out the number you are currently texting them on is
 * the single most obvious way to prove no one is reading, and it is the thing
 * Kate reacted to hardest.
 *
 * So known values are not decoration in the prompt — they change which intents
 * are available. With an address on file the bot cannot ask for an address; it
 * can only read it back. That is enforced in agent-output.ts rather than
 * requested here, because a prompt that says "do not ask" is a preference and a
 * missing enum entry is a guarantee.
 */
import { toE164, formatUs } from "./phone";

export type KnownCustomer = {
  name?: string | null;
  /** The handset this conversation is happening on. We are texting it; there
   *  is never a reason to ask for it. */
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  /** The scope as the customer wrote it on the inquiry form — Kate's "scope
   *  summary merge field". Quoting this back is what stops them retyping it. */
  inquiryScope?: string | null;
};

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/**
 * Human-readable, because "+15167846046" in a text message reads like a
 * machine wrote it.
 *
 * Dashed rather than "(516) 784-6046" for two reasons, and the second one is
 * the real one. It matches how Emily actually writes it in the conversation
 * Kate graded well: "Is 516-784-6046 and tomrvc@gmail.com the best contact".
 * And Kate's tone rules ban parentheses, so the bracketed form would have put
 * a rule violation into every contact confirmation we send.
 *
 * Falls back to what we were given if it will not parse.
 */
export function displayPhone(raw: string | null | undefined): string | null {
  const t = clean(raw);
  if (!t) return null;
  const e = toE164(t);
  if (!e) return t;
  const d = e.replace(/^\+1/, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : formatUs(e);
}

export function knownFields(k: KnownCustomer | undefined): {
  name: string | null; phone: string | null; email: string | null;
  address: string | null; inquiryScope: string | null;
} {
  return {
    name: clean(k?.name),
    phone: displayPhone(k?.phone),
    email: clean(k?.email),
    address: clean(k?.address),
    inquiryScope: clean(k?.inquiryScope),
  };
}

/** True when we hold a usable value for that field. */
export function knows(k: KnownCustomer | undefined, field: keyof KnownCustomer): boolean {
  return knownFields(k)[field as keyof ReturnType<typeof knownFields>] != null;
}

/**
 * The block that goes into the system prompt.
 *
 * Deliberately blunt about the phone number. Kate saw the bot ask for it twice
 * in one conversation and then ask a third time five hours later.
 */
export function knownCustomerPrompt(k: KnownCustomer | undefined): string {
  const f = knownFields(k);
  const have: string[] = [];
  if (f.name) have.push(`Their name: ${f.name}`);
  if (f.address) have.push(`The property address: ${f.address}`);
  if (f.email) have.push(`Their email: ${f.email}`);
  if (f.inquiryScope) have.push(`What they said they need, in their own words: "${f.inquiryScope}"`);

  const phoneLine = f.phone
    ? `You are texting them on ${f.phone}. You already have their phone number. NEVER ask for it, and NEVER ask them to type it out — read it back to confirm if you must, nothing more.`
    : `You are texting them on the number they contacted us from, so you already have their phone number. NEVER ask for it.`;

  if (!have.length) {
    return `WHAT WE ALREADY KNOW:\n${phoneLine}\nNothing else is on file for them yet.`;
  }

  return `WHAT WE ALREADY KNOW — confirm these, never ask for them again:
${have.map((h) => `- ${h}`).join("\n")}
${phoneLine}

Anything on that list is something they have ALREADY told us. Asking for it
again is the clearest possible sign that nobody read their enquiry. Read it
back to them to confirm instead — "Is <the address> the right address for the
estimate?" — and move on to the first thing we genuinely do not have.`;
}
