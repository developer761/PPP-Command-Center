/**
 * WHEN SOMEBODY CALLS THE NUMBER WE HAVE BEEN TEXTING THEM ON.
 *
 * Kate, 2026-09-26, moving this into Iteration 1: "we will need that in
 * iteration 1 because customers do call the number we're texting them on and
 * we'd want the call forwarded to the call center."
 *
 * She is right that it cannot wait. Every campaign message carries a number,
 * and a proportion of people will always ring it instead of replying. Today
 * that number is a Twilio number with no voice handling at all, so the call
 * fails — and the customer's conclusion is that PPP does not answer its
 * phone, which is worse than never having texted them.
 *
 * ── THIS IS FORWARDING, NOT A VOICE PLATFORM ────────────────────────────
 *
 * Hatch does three voice things: call forwarding, voicemail greetings, and
 * inbound-call AI agents. Kate asked for the first. This builds the first and
 * nothing else, and says so rather than implying the rest came with it.
 *
 * The columns for the other two already exist on the workspace
 * (voicemail_greeting_url, record_calls_default) and are deliberately left
 * unused — a greeting nobody recorded is not a feature, and recording calls
 * is a consent question in two-party states that nobody has asked.
 *
 * ── FAILING CLOSED HERE MEANS A BUSY TONE ───────────────────────────────
 *
 * Everywhere else in this system the safe direction is to refuse. Not here: a
 * refused call is a customer who thinks PPP is not reachable. So when a
 * workspace has no forwarding number configured the call is NOT dropped — it
 * gets a short spoken line telling them to try the main number, which is the
 * least-bad outcome and the one that does not look broken.
 *
 * Pure. The caller does the lookup and the HTTP.
 */

/**
 * PPP's main line, the fallback when a workspace has no number of its own.
 *
 * Read from Hatch's own Call Forwarding setting on 2026-09-26, where every
 * workspace forwards here. It is also the number on PPP's marketing email.
 */
export const MAIN_LINE = "+18776453563";

/** XML-escape. A number should never contain these, but neither should a
 *  greeting, and one day somebody will put an ampersand in one. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export type ForwardPlan =
  | { kind: "dial"; to: string; callerId: string | null }
  | { kind: "no_destination" };

/**
 * Where this call should go.
 *
 * `forwardTo` is the workspace's own setting; MAIN_LINE is the fallback, so a
 * workspace nobody has configured still reaches a human rather than failing.
 * Only a genuinely unknown number — one that matches no workspace — has
 * nowhere to go.
 */
export function forwardPlan(input: {
  /** The workspace's call_forward_to, if it has one. */
  forwardTo?: string | null;
  /** True when the called number matched a workspace we know. */
  known: boolean;
  /** Show the CUSTOMER's number to the call centre, not ours, so the agent
   *  sees who is calling and can ring them back. */
  callerId?: string | null;
}): ForwardPlan {
  if (!input.known) return { kind: "no_destination" };
  const to = (input.forwardTo ?? "").trim() || MAIN_LINE;
  return { kind: "dial", to, callerId: input.callerId ?? null };
}

/**
 * The TwiML Twilio executes.
 *
 * `answerOnBridge` so the caller hears real ringing rather than silence while
 * the call centre's phone rings — without it there is a dead-air gap that
 * people hang up in.
 *
 * `timeout` 25s: long enough for a real pickup, short enough that a customer
 * is not left listening to ringing forever if nobody is there.
 */
export function forwardTwiml(plan: ForwardPlan): string {
  if (plan.kind === "no_destination") {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      `  <Say voice="alice">Thanks for calling Precision Painting Plus. Please call us on 8 7 7, 6 4 5, 3 5 6 3.</Say>`,
      "</Response>",
    ].join("\n");
  }
  const callerId = plan.callerId ? ` callerId="${esc(plan.callerId)}"` : "";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Dial answerOnBridge="true" timeout="25"${callerId}>${esc(plan.to)}</Dial>`,
    "</Response>",
  ].join("\n");
}
