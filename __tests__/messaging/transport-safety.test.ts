import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { activeTransport, LoggingTransport, EndUserMessagingTransport } from "@/lib/messaging/transport";
import { transportChoice } from "@/lib/messaging/transport-config";
import type { E164 } from "@/lib/messaging/phone";

const FULL = {
  SMS_LIVE_SENDING: "true",
  SMS_TRANSPORT: "aws",
  AWS_SMS_REGION: "us-east-1",
  AWS_SMS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SMS_SECRET_ACCESS_KEY: "secret",
};

const saved = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(FULL)) delete process.env[k];
});
afterEach(() => { process.env = { ...saved }; });

/**
 * The only thing in this system that can reach a real person.
 *
 * Every one of these asserts the SAFE direction: that nothing is delivered
 * unless somebody deliberately turned it on.
 */
describe("nothing sends by accident", () => {
  it("is the fake with no configuration at all", () => {
    expect(activeTransport()).toBeInstanceOf(LoggingTransport);
    expect(transportChoice().live).toBe(false);
  });

  /** Credentials arriving in the environment is not consent to text people. */
  it("is still the fake when credentials exist but sending is not switched on", () => {
    Object.assign(process.env, FULL, { SMS_LIVE_SENDING: undefined });
    delete process.env.SMS_LIVE_SENDING;
    expect(activeTransport()).toBeInstanceOf(LoggingTransport);
  });

  it("is still the fake when sending is on but no carrier is chosen", () => {
    Object.assign(process.env, FULL);
    delete process.env.SMS_TRANSPORT;
    expect(activeTransport()).toBeInstanceOf(LoggingTransport);
  });

  it.each(["AWS_SMS_REGION", "AWS_SMS_ACCESS_KEY_ID", "AWS_SMS_SECRET_ACCESS_KEY"])(
    "falls back to the fake when %s is missing, rather than throwing", (missing) => {
      Object.assign(process.env, FULL);
      delete process.env[missing];
      // Throwing would make a queue worker crash-loop, which looks like an
      // outage. Recording looks like shadow mode, which is the safe failure.
      expect(activeTransport()).toBeInstanceOf(LoggingTransport);
      expect(transportChoice().live).toBe(false);
    }
  );

  it('treats anything other than exactly "true" as off', () => {
    for (const v of ["1", "yes", "TRUE", "on", " true"]) {
      Object.assign(process.env, FULL, { SMS_LIVE_SENDING: v });
      expect(activeTransport(), v).toBeInstanceOf(LoggingTransport);
    }
  });

  it("goes live only when both switches and every credential are set", () => {
    Object.assign(process.env, FULL);
    // Asserting BEHAVIOUR rather than the class: activeTransport now returns a
    // wrapper that routes SMS and email separately, and a test pinned to the
    // concrete class would have failed for a reason that has nothing to do
    // with whether anything can actually send.
    expect(transportChoice().live).toBe(true);
    expect(activeTransport()).not.toBeInstanceOf(LoggingTransport);
  });

  it("still reaches the real carrier when it is live", async () => {
    Object.assign(process.env, FULL);
    const t = activeTransport();
    // The AWS adapter throws without a real endpoint; the fake never would.
    // That difference is the thing worth asserting.
    await expect(t.send("+15167885933" as never, "+15163448418" as never, "x")).rejects.toBeTruthy();
  });
});

describe("the AWS adapter", () => {
  const t = () => new EndUserMessagingTransport(
    { region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "s" },
    () => new Date("2026-09-08T13:15:00Z")
  );

  it("signs the request and targets SendTextMessage", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ MessageId: "m-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await t().send("+15167885933" as E164, "+15163448418" as E164, "hello");
    expect(res.providerId).toBe("m-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sms-voice.us-east-1.amazonaws.com/");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Amz-Target"]).toBe("PinpointSMSVoiceV2.SendTextMessage");
    expect(headers.Authorization).toContain("AWS4-HMAC-SHA256");
    expect(JSON.parse(init.body as string)).toMatchObject({
      DestinationPhoneNumber: "+15163448418",
      OriginationIdentity: "+15167885933",
      MessageBody: "hello",
    });
    vi.unstubAllGlobals();
  });

  it("carries AWS's own error text through, rather than a bare status", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"message":"number opted out"}', { status: 400 }));
    await expect(t().send("+15167885933" as E164, "+15163448418" as E164, "x"))
      .rejects.toThrow(/number opted out/);
    vi.unstubAllGlobals();
  });

  it("refuses a success with no MessageId, because it could never be traced", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    await expect(t().send("+15167885933" as E164, "+15163448418" as E164, "x"))
      .rejects.toThrow(/no MessageId/);
    vi.unstubAllGlobals();
  });
});
