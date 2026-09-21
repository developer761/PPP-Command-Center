/**
 * What to say when somebody texts HELP.
 *
 * compliance.ts has carried the comment "Help keywords. A reply is legally
 * required." since the keywords were written — and the only thing that ever
 * consumed the classification was record-inbound.ts, which used it to SUPPRESS
 * the agent turn. So HELP was recognised, correctly kept away from the model,
 * and then answered by nobody.
 *
 * The reasoning at the time (simulator.ts: "The carrier answers HELP itself")
 * is true on some setups and not on this one. Twilio answers HELP automatically
 * through a Messaging Service's Advanced Opt-Out, and transports/twilio.ts
 * deliberately does not use a Messaging Service, so nothing in the path
 * replies. Not answering HELP is a CTIA violation, and carriers check it during
 * A2P campaign vetting — which PPP is in the middle of.
 *
 * WHAT CTIA ASKS FOR: who is texting, how to reach a person, that message and
 * data rates may apply, and how to stop. All four, inside one segment where
 * possible, because a HELP reply that fragments looks like spam.
 *
 * Pure. The number is the workspace's own, so the customer can call back the
 * number they were texted from rather than a switchboard they never saw.
 */
import { BUSINESS_NAME, OPT_OUT_DISCLOSURE } from "./first-message";

/** Pretty-print E.164 for a person: +15163448418 -> (516) 344-8418. */
export function humanPhone(e164: string | null | undefined): string | null {
  const t = (e164 ?? "").trim();
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(t);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return t || null;
}

/**
 * The reply.
 *
 * Built rather than stored as a constant because the callback number differs
 * per workspace — somebody texted from a 516 number should be told to call the
 * 516 number. A workspace with no number still gets a valid reply; it simply
 * cannot offer a callback, which is better than saying "call null".
 */
export function helpReply(workspacePhone: string | null | undefined): string {
  const phone = humanPhone(workspacePhone);
  const contact = phone ? ` Call us at ${phone}.` : "";
  return `${BUSINESS_NAME}: painting estimates and appointment updates.${contact} Msg & data rates may apply. ${OPT_OUT_DISCLOSURE}`;
}

/**
 * Everything CTIA asks a HELP reply to contain, as a checkable list.
 *
 * A test asserting the exact string would pass for a reply that had quietly
 * lost half its obligations to a typo. These assert the OBLIGATIONS.
 */
export function helpReplyChecks(body: string): { key: string; ok: boolean; label: string }[] {
  return [
    { key: "business_name", ok: /precision\s+painting\s+plus/i.test(body), label: "Says who it is from" },
    { key: "program", ok: /estimate|appointment/i.test(body), label: "Says what the messages are" },
    { key: "rates", ok: /msg\s*&?\s*data rates/i.test(body), label: "Msg & data rates may apply" },
    { key: "opt_out", ok: /\bstop\b/i.test(body), label: "How to stop" },
  ];
}
