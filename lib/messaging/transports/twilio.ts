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
import { randomUUID } from "crypto";
import { reportWarn } from "@/lib/observability";

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

    /**
     * PAST THIS LINE THE CARRIER HAS ACCEPTED THE MESSAGE, SO NOTHING MAY THROW.
     *
     * Every caller treats a throw as "it did not go out": the scheduler
     * reschedules it as an error and retries up to five times, and the review
     * queue leaves the draft claimed so it returns to the queue two minutes
     * later. Both of those are right for a connection that dropped before the
     * POST and catastrophic for one that answered 201 — the customer gets the
     * same text two to five times, and the only evidence is an error message
     * that literally begins "Twilio accepted the send".
     *
     * So an unreadable body or a missing sid now closes the row with an id of
     * our own. ResendEmailTransport already does exactly this, and its comment
     * explains the random suffix: provider_id carries a UNIQUE index, so a
     * timestamp sentinel would collide for two sends in the same millisecond.
     *
     * What is lost is delivery-receipt correlation for that one message, which
     * is a reporting gap. What is avoided is texting somebody five times.
     */
    let parsed: { sid?: string; status?: string; error_message?: string | null };
    try { parsed = JSON.parse(text) as typeof parsed; }
    catch {
      reportWarn({
        key: "twilio_unreadable_accept", platform: "ppp_cc",
        message: "Twilio accepted a send and returned a body we could not parse — recorded as sent with an id of ours",
        context: { to, body: text.slice(0, 200) },
      });
      return { providerId: `twilio-unparsed-${randomUUID()}` };
    }

    /**
     * The exception, and it is not a retry risk: a 201 whose status is already
     * failed or undelivered is a message Twilio created and will not deliver.
     * Nobody receives it, so a retry cannot duplicate anything — and the
     * scheduler surfacing it is the right outcome, because the cause is
     * usually a number that will fail every time.
     */
    if (parsed.status === "failed" || parsed.status === "undelivered") {
      throw new Error(`Twilio created the message as ${parsed.status}: ${parsed.error_message ?? "no reason given"}`);
    }

    if (!parsed.sid) {
      reportWarn({
        key: "twilio_accept_without_sid", platform: "ppp_cc",
        message: "Twilio accepted a send and returned no sid — recorded as sent with an id of ours",
        context: { to, status: parsed.status ?? null },
      });
      return { providerId: `twilio-nosid-${randomUUID()}` };
    }
    return { providerId: parsed.sid };
  }
}
