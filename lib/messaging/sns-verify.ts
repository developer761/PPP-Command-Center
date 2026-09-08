/**
 * Verifying that an SNS notification really came from AWS.
 *
 * AWS End User Messaging delivers inbound SMS by publishing to an SNS topic,
 * which POSTs to an HTTPS endpoint. That endpoint is public, so anything that
 * can reach it can claim to be a customer replying — including claiming to be
 * a customer saying STOP, or saying yes to an appointment.
 *
 * SNS signs every message. The signature is over a canonical string built from
 * specific fields in a specific order, using a certificate AWS publishes. This
 * verifies that properly rather than trusting a shared secret in a URL,
 * because the URL ends up in logs, dashboards and screenshots and the
 * signature does not.
 *
 * Two things here are security-critical rather than merely correct:
 *
 *   The certificate URL is checked against AWS's own hostname pattern BEFORE
 *   it is fetched. Without that, an attacker signs a message with their own
 *   key, points SigningCertURL at their own server, and we obligingly fetch
 *   their certificate and confirm their signature. It also makes the endpoint
 *   a fetcher of arbitrary URLs, which is the other half of the same bug.
 *
 *   Only the documented fields go into the canonical string, in the documented
 *   order. Including whatever the payload happens to carry would let an
 *   attacker add a field and change the meaning of a message that still
 *   verifies.
 *
 * Pure except for the injected fetcher, so the whole thing is testable without
 * a network.
 */
import { createVerify } from "crypto";

export type SnsMessage = {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Timestamp: string;
  Signature: string;
  SignatureVersion: string;
  SigningCertURL?: string;
  SigningCertUrl?: string;
  Message?: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
  [k: string]: unknown;
};

/** Fields that are signed, in the order they are signed, per message type. */
const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};

/** AWS's own signing hosts, and nothing else. */
const CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function certUrlIsAws(raw: string | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (!CERT_HOST.test(u.hostname)) return false;
  // A .pem, not a redirect to something else that happens to live on the host.
  return u.pathname.endsWith(".pem");
}

export function canonicalString(msg: SnsMessage): string | null {
  const fields = SIGNED_FIELDS[msg.Type];
  if (!fields) return null;
  let out = "";
  for (const f of fields) {
    const v = msg[f];
    // Subject is optional and is omitted entirely when absent — not included
    // as an empty string, which would produce a different string and fail.
    if (v === undefined || v === null) continue;
    out += `${f}\n${String(v)}\n`;
  }
  return out;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export async function verifySns(
  msg: SnsMessage,
  fetchCert: (url: string) => Promise<string>
): Promise<VerifyResult> {
  const certUrl = msg.SigningCertURL ?? msg.SigningCertUrl;
  if (!certUrlIsAws(certUrl)) {
    return { ok: false, reason: "signing certificate URL is not an AWS SNS URL" };
  }
  const canonical = canonicalString(msg);
  if (canonical === null) return { ok: false, reason: `unknown message type "${msg.Type}"` };
  if (!msg.Signature) return { ok: false, reason: "no signature" };

  // SignatureVersion 1 is SHA1, 2 is SHA256. Anything else is not something
  // AWS produces, so it is refused rather than guessed at.
  const algo = msg.SignatureVersion === "1" ? "RSA-SHA1"
    : msg.SignatureVersion === "2" ? "RSA-SHA256"
    : null;
  if (!algo) return { ok: false, reason: `unsupported signature version "${msg.SignatureVersion}"` };

  let pem: string;
  try { pem = await fetchCert(certUrl!); }
  catch { return { ok: false, reason: "could not fetch the signing certificate" }; }

  try {
    const v = createVerify(algo);
    v.update(canonical, "utf8");
    v.end();
    return v.verify(pem, msg.Signature, "base64")
      ? { ok: true }
      : { ok: false, reason: "signature does not match" };
  } catch {
    return { ok: false, reason: "signature could not be checked" };
  }
}

/** Fetch a certificate, refusing any URL that is not AWS's. The guard is
 *  repeated here so the fetcher is safe on its own, not only when called
 *  after verifySns has checked. */
export async function fetchAwsCert(url: string): Promise<string> {
  if (!certUrlIsAws(url)) throw new Error("refusing to fetch a non-AWS certificate URL");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`certificate fetch failed: ${res.status}`);
  return res.text();
}
