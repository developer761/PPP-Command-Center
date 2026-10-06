/**
 * Twilio, the carrier PPP is porting its fifteen numbers to.
 *
 * WHY TWILIO AND NOT AWS. The numbers live in Salesforce's AWS account today,
 * on Amazon Connect. AWS documents no account-to-account transfer of a phone
 * number, End User Messaging does not accept ported numbers at all, and Connect
 * cannot share one number between voice and SMS. So keeping them inside AWS
 * meant either Salesforce retaining ownership — which Karan ruled out — or
 * splitting texting and calling across two different numbers. Porting out
 * solves both, and on Twilio one number does both.
 *
 * ONE CALL. Create a Message on the REST API. Written against the HTTP API
 * rather than the `twilio` npm package on purpose, for the same reason the AWS
 * adapter avoids the AWS SDK: a large dependency tree for a single POST, in a
 * package.json shared with another active session.
 *
 * NOT VERIFIED AGAINST A REAL TWILIO ACCOUNT. The request shape follows the
 * API reference and every branch below is tested against a stubbed fetch, but
 * no message has gone through it — PPP's account is still being upgraded and
 * the numbers are still mid-port. The first real send needs somebody watching.
 * Saying so is worth more than the reassurance of pretending otherwise.
 *
 * NOTHING HERE MAY BE CALLED OUTSIDE THE GATE. This directory is carved out of
 * gate-is-the-only-path.test.ts as a place for concrete adapters — a thing the
 * gate constructs, never a thing a page can reach around it.
 */
import type { E164 } from "../phone";
import type { MessageTransport, SendResult } from "../transport";
import type { TwilioChoice } from "../transport-config";

/**
 * Twilio keeps its own opt-out list and enforces it before we do. A send
 * refused with this code means somebody is suppressed at the carrier and NOT
 * in `sms_opt_outs` — a real gap between the two lists, not a transient error,
 * and retrying it will fail forever.
 */
export const TWILIO_UNSUBSCRIBED = 21610;

/**
 * The carrier says this person is unsubscribed, and we did not know.
 *
 * A distinguishable type rather than a message, because the comment above was
 * already right about what it means — "not a transient error, and retrying it
 * will fail forever" — and the code then threw a plain Error, which the
 * scheduler reads as transient and retries five times before failing. The
 * number was never written to sms_opt_outs either, so every other workspace
 * and every other channel went on trying the same person.
 *
 * Carries the number so the caller can close the gap it describes.
 */
export class CarrierUnsubscribedError extends Error {
  // Written out, NOT a constructor parameter property — for the reason spelled
  // out on TwilioTransport just below, which this class was added four lines
  // above and broke anyway. Node's strip-only TypeScript mode cannot parse
  // them, and every verify:* script loads this module through it: tsc and
  // next build were both green while the entire end-to-end suite died on
  // import. See __tests__/messaging/strip-only-safe.test.ts.
  readonly to: string;

  constructor(to: string, message: string) {
    super(message);
    this.to = to;
    this.name = "CarrierUnsubscribedError";
  }
}

export class TwilioTransport implements MessageTransport {
  // Written out rather than declared as constructor parameter properties.
  // verify-messaging-e2e.mjs runs the transport modules through node's
  // strip-only TypeScript mode, which does not support them.
  private readonly cfg: TwilioChoice;

  constructor(cfg: TwilioChoice) {
    this.cfg = cfg;
  }

  async send(from: E164, to: E164, body: string): Promise<SendResult> {
    // No MessagingServiceSid. Twilio would then pick the sender out of the
    // service's pool, and WHICH number the customer sees is not a detail — it
    // is the local area code they recognise and the thread they already have
    // with us. The gate resolved `from` for that reason; overriding it here
    // would quietly undo it. A2P campaign association is a property of the
    // number, not of how the send is addressed.
    const form = new URLSearchParams({ To: to, From: from, Body: body });

    // WHERE TWILIO SHOULD REPORT BACK TO.
    //
    // Without this, delivery_status stays "sent" forever and a message a
    // carrier filtered looks exactly like one that arrived. On a fresh 10DLC
    // campaign, filtering (error 30007) is the likeliest failure there is and
    // has no other signal — delivery just quietly falls off.
    //
    // Optional, because it is a URL that only exists once the app is deployed
    // somewhere Twilio can reach. Unset means no receipts, which is what the
    // system did before this existed, rather than a send that fails.
    const callback = process.env.TWILIO_STATUS_WEBHOOK_URL?.trim();
    if (callback) form.set("StatusCallback", callback);

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          // An API key, not the Auth Token. See TwilioChoice for why.
          Authorization: `Basic ${Buffer.from(`${this.cfg.apiKeySid}:${this.cfg.apiKeySecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      }
    );

    const text = await res.text();
    if (!res.ok) {
      // Carry Twilio's own message through. A bare status here costs a round
      // trip to diagnose — the mistake the Anthropic 400 already taught.
      let code: number | undefined;
      try { code = (JSON.parse(text) as { code?: number }).code; } catch { /* keep the raw text */ }
      if (code === TWILIO_UNSUBSCRIBED) {
        throw new CarrierUnsubscribedError(
          to,
          `Twilio ${res.status}: this number is on Twilio's own opt-out list and is not in `
          + `sms_opt_outs, which means the two lists have drifted — ${text.slice(0, 300)}`
        );
      }
      throw new Error(`Twilio ${res.status}: ${text.slice(0, 500)}`);
    }

    let parsed: { sid?: string; status?: string; error_message?: string | null };
    try { parsed = JSON.parse(text) as typeof parsed; }
    catch { throw new Error(`Twilio accepted the send but returned unreadable JSON: ${text.slice(0, 200)}`); }

    // Twilio can answer 201 for a message it has already given up on.
    if (parsed.status === "failed" || parsed.status === "undelivered") {
      throw new Error(`Twilio created the message as ${parsed.status}: ${parsed.error_message ?? "no reason given"}`);
    }
    if (!parsed.sid) {
      // Without an id we cannot correlate a delivery receipt, and a send we
      // cannot trace is a send we cannot prove happened.
      throw new Error("Twilio accepted the send but returned no sid");
    }
    return { providerId: parsed.sid };
  }
}
