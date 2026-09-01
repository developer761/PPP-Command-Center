/**
 * The carrier boundary.
 *
 * Every unknown about how PPP's messages physically leave the building lives
 * behind this interface: whether the numbers end up on Twilio or AWS End User
 * Messaging, whose account they sit in, how the port out of Salesforce's AWS
 * account lands. None of it changes a line of the system above.
 *
 * That is deliberate and it is what let the substrate get built while the port
 * was still an open question with Katie. When the destination is settled we
 * write one adapter — roughly a day — and nothing else moves.
 *
 * IMPORTANT: nothing outside lib/messaging/gate.ts may call `send`. The gate is
 * the only path to a customer's phone, and __tests__/messaging/gate-is-the-only-
 * path.test.ts fails the build if any other file imports this module's sender.
 */
import type { E164 } from "./phone";

export type SendResult = { providerId: string };

export interface MessageTransport {
  /** `from` is the workspace's own number — the local area code the customer
   *  sees and replies to. Routing depends on it being the real one. */
  send(from: E164, to: E164, body: string): Promise<SendResult>;
}

/**
 * Development transport. Records instead of sending.
 *
 * Not a stub to be replaced and forgotten: shadow mode (Stage 7) runs the whole
 * system on real leads with this in place, so the drafts land in the inbox and
 * Hatch keeps handling those customers for real. It is how the quality
 * comparison gets made without risking a single message.
 */
export class LoggingTransport implements MessageTransport {
  readonly sent: Array<{ from: string; to: string; body: string; at: Date }> = [];

  async send(from: E164, to: E164, body: string): Promise<SendResult> {
    const at = new Date();
    this.sent.push({ from, to, body, at });
    // Deterministic id so a test can assert on it and a retry is recognisable.
    return { providerId: `logging-${this.sent.length}` };
  }
}

/**
 * The live transport, or nothing.
 *
 * Returns the logging fake unless a real carrier is deliberately wired here.
 * That default is a safety property, not laziness: the tick can be scheduled,
 * the queue can drain and the gate can run, and NOTHING reaches a customer
 * until somebody changes this function. Shadow mode is the resting state.
 *
 * Twilio or AWS End User Messaging plugs in here once Katie settles the
 * destination and the numbers are ported off the Salesforce account.
 */
export function activeTransport(): MessageTransport {
  return new LoggingTransport();
}
