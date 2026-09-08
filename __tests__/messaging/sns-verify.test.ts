import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createSign, X509Certificate } from "crypto";
import { verifySns, certUrlIsAws, canonicalString, type SnsMessage } from "@/lib/messaging/sns-verify";

/**
 * Signed with a real key so the check is proven, not assumed. A test that
 * stubs the crypto proves only that the stub was called.
 */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc123.pem";

function sign(msg: SnsMessage): string {
  const s = createSign(msg.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256");
  s.update(canonicalString(msg)!, "utf8");
  s.end();
  return s.sign(privateKey, "base64");
}

const base = (over: Partial<SnsMessage> = {}): SnsMessage => ({
  Type: "Notification",
  MessageId: "m-1",
  TopicArn: "arn:aws:sns:us-east-1:1:inbound",
  Timestamp: "2026-09-08T10:00:00.000Z",
  Message: JSON.stringify({ originationNumber: "+15551230000", messageBody: "hello" }),
  SignatureVersion: "2",
  SigningCertURL: CERT_URL,
  Signature: "",
  ...over,
});

const fetchCert = async () => pubPem;

describe("SNS signature verification", () => {
  it("accepts a genuinely signed notification", async () => {
    const m = base();
    m.Signature = sign(m);
    expect(await verifySns(m, fetchCert)).toEqual({ ok: true });
  });

  /** The control: the check must be able to fail. */
  it("rejects a message whose body was changed after signing", async () => {
    const m = base();
    m.Signature = sign(m);
    m.Message = JSON.stringify({ originationNumber: "+15551230000", messageBody: "STOP" });
    const res = await verifySns(m, fetchCert);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/does not match/);
  });

  it("rejects a signature that is simply wrong", async () => {
    const m = base({ Signature: Buffer.from("nope").toString("base64") });
    expect((await verifySns(m, fetchCert)).ok).toBe(false);
  });

  /**
   * The one that matters most. Without this an attacker signs with their own
   * key, points the cert URL at their own server, and we confirm their
   * signature for them.
   */
  it("refuses a certificate URL that is not AWS's, before fetching it", async () => {
    let fetched = false;
    const spy = async (u: string) => { fetched = true; return pubPem; };
    const m = base({ SigningCertURL: "https://evil.example.com/cert.pem" });
    m.Signature = sign(m);
    const res = await verifySns(m, spy);
    expect(res.ok).toBe(false);
    expect(fetched).toBe(false);
  });

  it.each([
    ["http://sns.us-east-1.amazonaws.com/x.pem", "not https"],
    ["https://sns.us-east-1.amazonaws.com.evil.com/x.pem", "suffix attack"],
    ["https://evil.com/sns.us-east-1.amazonaws.com/x.pem", "path, not host"],
    ["https://sns.us-east-1.amazonaws.com/x.txt", "not a pem"],
    ["", "empty"],
  ])("rejects cert URL %j (%s)", (url) => {
    expect(certUrlIsAws(url)).toBe(false);
  });

  it("accepts AWS's real shape, including other regions", () => {
    expect(certUrlIsAws(CERT_URL)).toBe(true);
    expect(certUrlIsAws("https://sns.eu-west-2.amazonaws.com/a.pem")).toBe(true);
  });

  it("handles a subscription confirmation, which signs different fields", async () => {
    const m = base({
      Type: "SubscriptionConfirmation",
      Token: "tok",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription",
    });
    m.Signature = sign(m);
    expect(await verifySns(m, fetchCert)).toEqual({ ok: true });
  });

  it("omits Subject entirely when absent rather than signing an empty one", () => {
    const without = canonicalString(base())!;
    expect(without).not.toContain("Subject");
    const withSubject = canonicalString(base({ Subject: "hi" }))!;
    expect(withSubject).toContain("Subject\nhi\n");
  });

  it("refuses a message type it does not know", async () => {
    const m = base({ Type: "SomethingElse" });
    const res = await verifySns(m, fetchCert);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/unknown message type/);
  });

  it("refuses a signature version AWS does not produce", async () => {
    const m = base({ SignatureVersion: "9" });
    expect((await verifySns(m, fetchCert)).ok).toBe(false);
  });

  it("fails closed when the certificate cannot be fetched", async () => {
    const m = base();
    m.Signature = sign(m);
    const res = await verifySns(m, async () => { throw new Error("network"); });
    expect(res.ok).toBe(false);
  });
});
