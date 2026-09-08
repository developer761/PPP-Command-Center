/**
 * AWS SigV4 request signing.
 *
 * Written out rather than pulled in. @aws-sdk/client-pinpoint-sms-voice-v2 is
 * a large dependency tree for exactly one API call, this repo is shared with
 * another active session, and package.json is the sort of file two agents
 * conflict in badly. SigV4 is a documented, deterministic algorithm and it is
 * testable against AWS's own published vectors, which is what the tests do.
 *
 * Pure: no network, no clock. The timestamp is passed in so a signature can be
 * reproduced exactly, which is the only way to check it against a vector.
 */
import { createHmac, createHash } from "crypto";

const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

export type SignInput = {
  method: string;
  /** Path, already URI-encoded. "/" for most service APIs. */
  path: string;
  /** Canonical query string, or "". */
  query?: string;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** ISO basic format: 20150830T123600Z */
  amzDate: string;
};

export function canonicalRequest(input: SignInput): { canonical: string; signedHeaders: string } {
  // Header names lowercased, values trimmed, sorted by name. Both sides have to
  // agree byte for byte or the signature simply does not match, with no clue
  // as to which header was wrong.
  const entries = Object.entries(input.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = entries.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = entries.map(([k]) => k).join(";");

  const canonical = [
    input.method.toUpperCase(),
    input.path || "/",
    input.query ?? "",
    canonicalHeaders,
    signedHeaders,
    hash(input.body),
  ].join("\n");

  return { canonical, signedHeaders };
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export function signRequest(input: SignInput): { authorization: string; signature: string } {
  const date = input.amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const { canonical, signedHeaders } = canonicalRequest(input);

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    hash(canonical),
  ].join("\n");

  const signature = createHmac("sha256", signingKey(input.secretAccessKey, date, input.region, input.service))
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, signature };
}

/** 20260908T131500Z */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
