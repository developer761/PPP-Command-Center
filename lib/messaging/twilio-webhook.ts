/**
 * Proving an inbound webhook really came from Twilio, and reading what it says.
 *
 * The endpoint is public, so anything that can reach it can claim to be a
 * customer replying — including claiming to be a customer saying STOP, or
 * saying yes to an appointment. Twilio signs every request it makes; this
 * checks the signature rather than trusting a secret in the URL, because a URL
 * ends up in logs, dashboards and screenshots and a signature does not.
 *
 * THE SIGNING KEY IS THE ACCOUNT'S AUTH TOKEN, and there is no API-key
 * alternative for X-Twilio-Signature — Twilio computes it with the Auth Token
 * and nothing else. That is the one Twilio secret that cannot be scoped or
 * revoked on its own, so TWILIO_AUTH_TOKEN is typed straight into Vercel's
 * environment variables by a person, and is never pasted into a chat, a
 * commit, a ticket or a terminal. Sending goes through an API key instead —
 * see TwilioChoice — precisely so this token is used for nothing else.
 *
 * THE URL MUST BE THE ONE TWILIO CALLED, byte for byte, including the scheme
 * and any query string, because the URL is the first thing in the signed
 * string. Behind Vercel the incoming request often says `http` internally, so
 * a URL rebuilt naively from the request verifies against nothing. Prefer the
 * one configured in TWILIO_WEBHOOK_URL, which is also the value pasted into
 * Twilio's console, and derive only as a fallback.
 *
 * Pure. No network, no database.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { EumInbound } from "./inbound";

export type TwilioVerification = { ok: true } | { ok: false; reason: string };

/**
 * The string Twilio signed: the full URL, then every POST parameter appended
 * as name immediately followed by value, in alphabetical order by name.
 */
export function signedPayload(url: string, params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
}

export function expectedSignature(authToken: string, url: string, params: Record<string, string>): string {
  return createHmac("sha1", authToken).update(Buffer.from(signedPayload(url, params), "utf8")).digest("base64");
}

export function verifyTwilioSignature(input: {
  authToken: string | undefined;
  /** Exactly the URL Twilio was configured to call. */
  url: string;
  params: Record<string, string>;
  /** The X-Twilio-Signature header. */
  signature: string | null;
}): TwilioVerification {
  // FAIL CLOSED. A missing token must never read as "nothing to check against,
  // so let it through" — that turns a misconfigured deploy into an open door.
  if (!input.authToken) return { ok: false, reason: "no TWILIO_AUTH_TOKEN is configured, so nothing can be verified" };
  if (!input.signature) return { ok: false, reason: "no X-Twilio-Signature header" };

  const expected = Buffer.from(expectedSignature(input.authToken, input.url, input.params), "utf8");
  const given = Buffer.from(input.signature, "utf8");
  // Length is compared first because timingSafeEqual throws on a mismatch, and
  // the length of a base64 SHA1 is fixed and public anyway.
  if (expected.length !== given.length) return { ok: false, reason: "signature does not match" };
  if (!timingSafeEqual(expected, given)) return { ok: false, reason: "signature does not match" };
  return { ok: true };
}

/**
 * Form parameters as Twilio signed them.
 *
 * Twilio's own validators hold the parameters in a dictionary, so a repeated
 * name keeps one value. Its inbound payloads never repeat one — media arrives
 * as MediaUrl0, MediaUrl1 — but matching the behaviour rather than inventing a
 * different one is what keeps this verifying the same string Twilio hashed.
 */
export function formParams(form: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form) out[k] = v;
  return out;
}

/** The URL Twilio called: the configured one, or rebuilt from the request. */
export function webhookUrl(input: {
  configured: string | undefined;
  requestUrl: string;
  forwardedProto: string | null;
  forwardedHost: string | null;
}): string {
  if (input.configured) return input.configured.trim();
  const u = new URL(input.requestUrl);
  // Vercel terminates TLS ahead of the function, so the request arriving here
  // can say http while Twilio called https. Trusting the forwarded headers is
  // safe only because the signature is what actually authenticates the call —
  // getting these wrong makes verification FAIL, never wrongly succeed.
  if (input.forwardedProto) u.protocol = `${input.forwardedProto.split(",")[0].trim()}:`;
  if (input.forwardedHost) u.host = input.forwardedHost.split(",")[0].trim();
  return u.toString();
}

/**
 * Twilio's inbound shape, read into the one the rest of the system speaks.
 *
 * Deliberately a translation and nothing more. decideInbound already holds
 * every judgement about what an inbound message means — the opt-out
 * classifier, the empty-message rule, the missing-id rule — and it has tests.
 * A second carrier must reuse that, not grow a parallel copy that drifts.
 */
export function twilioToInbound(p: Record<string, string>): EumInbound {
  const count = Number.parseInt(p.NumMedia ?? "0", 10);
  const mediaUrls: string[] = [];
  // NaN, a negative, or a number Twilio would never send all collapse to none
  // rather than throwing or looping.
  for (let i = 0; i < (Number.isFinite(count) ? Math.min(Math.max(count, 0), 10) : 0); i++) {
    const url = p[`MediaUrl${i}`];
    if (url) mediaUrls.push(url);
  }
  return {
    originationNumber: p.From,
    destinationNumber: p.To,
    messageBody: p.Body,
    // MessageSid is what makes recording idempotent. Twilio does not retry an
    // inbound webhook, but its fallback URL can fire on the same message.
    inboundMessageId: p.MessageSid || p.SmsMessageSid,
    mediaUrls,
  };
}
