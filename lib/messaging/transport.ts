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
import { signRequest, amzDate } from "./aws-sigv4";
import { transportChoice } from "./transport-config";

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
 * AWS End User Messaging.
 *
 * One call — SendTextMessage on pinpoint-sms-voice-v2 — signed with SigV4.
 * Written against the REST API rather than the AWS SDK on purpose: the SDK is
 * a large dependency tree for a single request, and this repo is shared with
 * another active session where package.json is a bad place to collide.
 *
 * NOT VERIFIED AGAINST A REAL AWS ACCOUNT. The signing is checked against
 * AWS's own published test vector, and the request shape follows the API
 * reference, but no message has been sent through it because PPP has no
 * messaging account of its own yet and the numbers are still on Salesforce's.
 * The first real send will need someone watching it. Saying so here is worth
 * more than the reassurance of pretending otherwise.
 */
export type EumConfig = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Configuration set name, if PPP uses one for delivery events. */
  configurationSetName?: string;
};

export class EndUserMessagingTransport implements MessageTransport {
  // Written out rather than declared as constructor parameter properties.
  // verify-messaging-e2e.mjs runs this file through node's strip-only
  // TypeScript mode, which does not support them — and that script exercising
  // the REAL transport module is worth more than the shorter syntax.
  private readonly cfg: EumConfig;
  private readonly now: () => Date;

  constructor(cfg: EumConfig, now: () => Date = () => new Date()) {
    this.cfg = cfg;
    this.now = now;
  }

  async send(from: E164, to: E164, body: string): Promise<SendResult> {
    const host = `sms-voice.${this.cfg.region}.amazonaws.com`;
    const payload = JSON.stringify({
      DestinationPhoneNumber: to,
      OriginationIdentity: from,
      MessageBody: body,
      MessageType: "TRANSACTIONAL",
      ...(this.cfg.configurationSetName ? { ConfigurationSetName: this.cfg.configurationSetName } : {}),
    });

    const date = amzDate(this.now());
    const headers: Record<string, string> = {
      Host: host,
      "Content-Type": "application/x-amz-json-1.0",
      "X-Amz-Date": date,
      "X-Amz-Target": "PinpointSMSVoiceV2.SendTextMessage",
      ...(this.cfg.sessionToken ? { "X-Amz-Security-Token": this.cfg.sessionToken } : {}),
    };

    const { authorization } = signRequest({
      method: "POST", path: "/", query: "", headers, body: payload,
      region: this.cfg.region, service: "sms-voice",
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      sessionToken: this.cfg.sessionToken,
      amzDate: date,
    });

    const res = await fetch(`https://${host}/`, {
      method: "POST",
      headers: { ...headers, Authorization: authorization },
      body: payload,
    });

    const text = await res.text();
    if (!res.ok) {
      // Carry AWS's own message through. A bare status here would cost a round
      // trip to diagnose, which is the mistake the Anthropic 400 already taught.
      throw new Error(`AWS End User Messaging ${res.status}: ${text.slice(0, 500)}`);
    }

    let parsed: { MessageId?: string };
    try { parsed = JSON.parse(text) as { MessageId?: string }; }
    catch { throw new Error(`AWS accepted the send but returned unreadable JSON: ${text.slice(0, 200)}`); }

    if (!parsed.MessageId) {
      // Without an id we cannot correlate a delivery receipt, and a send we
      // cannot trace is a send we cannot prove happened.
      throw new Error("AWS accepted the send but returned no MessageId");
    }
    return { providerId: parsed.MessageId };
  }
}

/**
 * The live transport, or the fake.
 *
 * TWO switches, and that is deliberate. Credentials being present is not
 * consent to start texting people — a key can arrive in the environment for
 * any number of reasons, including somebody wiring up a different feature. So
 * delivery requires SMS_LIVE_SENDING to be exactly "true" AS WELL AS a
 * configured transport, and either one missing means the fake.
 *
 * The fake is not a stub awaiting replacement. Shadow mode runs the entire
 * system on real leads with it in place: drafts land in the inbox, Hatch keeps
 * handling those customers for real, and the quality comparison gets made
 * without risking a single message. That is the resting state, and it is what
 * Kate will be testing against.
 */
export function activeTransport(): MessageTransport {
  const choice = transportChoice();
  // Incomplete or switched-off configuration returns the fake rather than
  // throwing. A queue worker that crashes retries forever and looks like an
  // outage; one that records and does not deliver looks exactly like shadow
  // mode, which is the safe direction to fail in.
  if (!choice.live) return new LoggingTransport();
  return new EndUserMessagingTransport(choice.aws);
}

