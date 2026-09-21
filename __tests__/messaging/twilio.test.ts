import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TwilioTransport, TWILIO_UNSUBSCRIBED } from "@/lib/messaging/transports/twilio";
import { activeTransport, LoggingTransport } from "@/lib/messaging/transport";
import { transportChoice } from "@/lib/messaging/transport-config";
import {
  verifyTwilioSignature, expectedSignature, signedPayload, formParams,
  twilioToInbound, webhookUrl,
} from "@/lib/messaging/twilio-webhook";
import { decideInbound } from "@/lib/messaging/inbound";
import type { E164 } from "@/lib/messaging/phone";

const FULL = {
  SMS_LIVE_SENDING: "true",
  SMS_TRANSPORT: "twilio",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000001",
  TWILIO_API_KEY_SID: "SK00000000000000000000000000000002",
  TWILIO_API_KEY_SECRET: "shhh",
};

const saved = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(FULL)) delete process.env[k];
});
afterEach(() => {
  process.env = { ...saved };
  vi.unstubAllGlobals();
});

/* ─────────────────────────────────────────────────────────────────────────
   Choosing the carrier
   ───────────────────────────────────────────────────────────────────────── */

describe("Twilio is chosen only when somebody switched it on", () => {
  it("is the fake when the credentials exist but sending is off", () => {
    Object.assign(process.env, FULL);
    delete process.env.SMS_LIVE_SENDING;
    expect(transportChoice().live).toBe(false);
    expect(activeTransport()).toBeInstanceOf(LoggingTransport);
  });

  it.each(["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"])(
    "falls back to the fake when %s is missing, rather than throwing", (missing) => {
      Object.assign(process.env, FULL);
      delete process.env[missing];
      // Throwing would make the queue worker crash-loop, which looks like an
      // outage. Recording looks like shadow mode, which is the safe failure.
      expect(transportChoice().live).toBe(false);
      expect(activeTransport()).toBeInstanceOf(LoggingTransport);
    }
  );

  it("goes live, and names Twilio as the carrier", () => {
    Object.assign(process.env, FULL);
    const choice = transportChoice();
    expect(choice.live).toBe(true);
    expect(choice.live && choice.carrier).toBe("twilio");
  });

  it("does not take AWS credentials as Twilio's", () => {
    Object.assign(process.env, {
      SMS_LIVE_SENDING: "true", SMS_TRANSPORT: "twilio",
      AWS_SMS_REGION: "us-east-1", AWS_SMS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SMS_SECRET_ACCESS_KEY: "s",
    });
    expect(transportChoice().live).toBe(false);
  });

  it("actually sends through Twilio once it is live, not through AWS", async () => {
    Object.assign(process.env, FULL);
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ sid: "SM1", status: "queued" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await activeTransport().send("+15167885933" as E164, "+15163448418" as E164, "hello");
    // The point of the whole branch: the bytes leave for Twilio's host.
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.twilio.com");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Sending
   ───────────────────────────────────────────────────────────────────────── */

describe("the Twilio adapter", () => {
  const t = () => new TwilioTransport({
    accountSid: "AC123", apiKeySid: "SK456", apiKeySecret: "secret",
  });

  const okResponse = (extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ sid: "SM9", status: "queued", ...extra }), { status: 201 });

  it("posts the message to the account's Messages resource", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const res = await t().send("+15167885933" as E164, "+15163448418" as E164, "hello");
    expect(res.providerId).toBe("SM9");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(init.method).toBe("POST");

    const body = new URLSearchParams(init.body as string);
    expect(body.get("To")).toBe("+15163448418");
    expect(body.get("From")).toBe("+15167885933");
    expect(body.get("Body")).toBe("hello");
  });

  it("authenticates with the API key, never the Auth Token", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    await t().send("+15167885933" as E164, "+15163448418" as E164, "x");

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    const [user, pass] = Buffer.from(headers.Authorization.replace("Basic ", ""), "base64").toString().split(":");
    // SK, not AC. An API key can be revoked on its own; the Auth Token also
    // signs inbound webhooks, so spending it on sends too would mean a leak
    // lets somebody forge a customer saying STOP.
    expect(user).toBe("SK456");
    expect(pass).toBe("secret");
  });

  it("sends from the workspace's own number and does not let Twilio choose", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    await t().send("+15167885933" as E164, "+15163448418" as E164, "x");

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    // A MessagingServiceSid would let Twilio pick the sender out of a pool,
    // and which number the customer sees is the local area code they
    // recognise and the thread they already have with us.
    expect(body.get("MessagingServiceSid")).toBeNull();
    expect(body.get("From")).toBe("+15167885933");
  });

  it("carries Twilio's own error text through, rather than a bare status", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ code: 21211, message: "The 'To' number is not a valid phone number" }), { status: 400 }));
    await expect(t().send("+15167885933" as E164, "+15163448418" as E164, "x"))
      .rejects.toThrow(/not a valid phone number/);
  });

  it("says plainly when Twilio's opt-out list and ours have drifted", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ code: TWILIO_UNSUBSCRIBED, message: "unsubscribed recipient" }), { status: 400 }));
    // The gate cleared this send, so our list did not have them. Twilio's did.
    // That gap is the finding, and a generic 400 would have buried it.
    await expect(t().send("+15167885933" as E164, "+15163448418" as E164, "x"))
      .rejects.toThrow(/drifted/);
  });

  it("refuses a success with no sid, because it could never be traced", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ status: "queued" }), { status: 201 }));
    await expect(t().send("+15167885933" as E164, "+15163448418" as E164, "x"))
      .rejects.toThrow(/no sid/);
  });

  it("refuses a 201 that already says the message failed", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ sid: "SM9", status: "failed", error_message: "unreachable carrier" }), { status: 201 }));
    // Returning a providerId here would record a send that never happened.
    await expect(t().send("+15167885933" as E164, "+15163448418" as E164, "x"))
      .rejects.toThrow(/unreachable carrier/);
  });

  it("does not pretend unreadable JSON was a send", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>502</html>", { status: 200 }));
    await expect(t().send("+15167885933" as E164, "+15163448418" as E164, "x"))
      .rejects.toThrow(/unreadable/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Proving an inbound request really came from Twilio
   ───────────────────────────────────────────────────────────────────────── */

describe("the inbound signature", () => {
  /**
   * CROSS-CHECKED AGAINST TWILIO'S OWN CODE, not against this file.
   *
   * Every signature below was produced by twilio@5's
   * `webhooks.getExpectedTwilioSignature` — the same function their server
   * side effectively runs — and pasted in. That is the only way to know this
   * implementation agrees with THEIRS rather than merely with itself, and a
   * vector generated by the code under test would prove nothing at all.
   *
   * The library is deliberately not a dependency: it is a large tree for one
   * HMAC, and package.json is shared with another active session. It was
   * installed outside the repo, run once, and the outputs live here.
   *
   * An earlier draft of this test asserted a signature recalled from memory
   * rather than obtained from a source. It was wrong, and the only reason that
   * is known is that this test existed and failed.
   */
  const VECTOR = {
    token: "12345",
    url: "https://mycompany.com/myapp.php?foo=1&bar=2",
    params: {
      Digits: "1234",
      To: "+18005551212",
      From: "+14158675310",
      Caller: "+14158675310",
      CallSid: "CA1234567890ABCDE",
    },
    signature: "GvWf1cFY/Q7PnoempGyD5oXAezc=",
  };

  const TOKEN = "a".repeat(32);

  it("matches a signature made by Twilio's own library", () => {
    expect(expectedSignature(VECTOR.token, VECTOR.url, VECTOR.params)).toBe(VECTOR.signature);
  });

  it("matches on the payload PPP will actually receive", () => {
    // A real inbound STOP to a real PPP endpoint, signed by twilio@5.
    expect(expectedSignature(TOKEN, "https://cc.example.com/api/webhooks/twilio-inbound", {
      From: "+15163448418", To: "+15167885933", Body: "Stop.",
      MessageSid: "SM123", NumMedia: "0", AccountSid: "AC1",
    })).toBe("RgV1yrYiUeJ/jll9AUpsMtDls+I=");
  });

  it("agrees with Twilio on non-ASCII, where byte-vs-character bugs live", () => {
    // An emoji is one character and four bytes. Hashing the characters rather
    // than the UTF-8 bytes verifies fine against itself and against nothing
    // Twilio ever sends — and customers send emoji constantly.
    expect(expectedSignature(TOKEN, "https://cc.example.com/api/webhooks/twilio-inbound", {
      From: "+15163448418", To: "+15167885933", Body: "sounds good 👍 café",
      MessageSid: "SM124", NumMedia: "0",
    })).toBe("XfoWIcvOsQqtYWtICM+9D9a9bkY=");
  });

  it("agrees with Twilio on an empty parameter value", () => {
    expect(expectedSignature(TOKEN, "https://cc.example.com/hook", { A: "", B: "1" }))
      .toBe("azs+IVPoO3/tp3QBRkjBOiJ37AU=");
  });

  it("accepts a request signed with the account's token", () => {
    expect(verifyTwilioSignature({
      authToken: VECTOR.token, url: VECTOR.url, params: VECTOR.params, signature: VECTOR.signature,
    })).toEqual({ ok: true });
  });

  it("sorts the parameters by name, because Twilio does", () => {
    expect(signedPayload("u", { b: "2", a: "1" })).toBe("ua1b2");
    // Same parameters, different insertion order, same signed string.
    expect(expectedSignature("t", "u", { b: "2", a: "1" }))
      .toBe(expectedSignature("t", "u", { a: "1", b: "2" }));
  });

  it("rejects a body somebody edited in flight", () => {
    const tampered = { ...VECTOR.params, Digits: "9999" };
    const v = verifyTwilioSignature({
      authToken: VECTOR.token, url: VECTOR.url, params: tampered, signature: VECTOR.signature,
    });
    expect(v.ok).toBe(false);
  });

  it("rejects a parameter somebody ADDED, not only one they changed", () => {
    // Every parameter is signed, so smuggling an extra one in breaks it too.
    const extra = { ...VECTOR.params, Body: "STOP" };
    expect(verifyTwilioSignature({
      authToken: VECTOR.token, url: VECTOR.url, params: extra, signature: VECTOR.signature,
    }).ok).toBe(false);
  });

  it("rejects a signature made for a different URL", () => {
    expect(verifyTwilioSignature({
      authToken: VECTOR.token, url: "https://mycompany.com/other.php", params: VECTOR.params, signature: VECTOR.signature,
    }).ok).toBe(false);
  });

  it("fails closed when no token is configured", () => {
    // The dangerous reading is "nothing to check against, so let it through".
    const v = verifyTwilioSignature({
      authToken: undefined, url: VECTOR.url, params: VECTOR.params, signature: VECTOR.signature,
    });
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/TWILIO_AUTH_TOKEN/);
  });

  it("rejects a request with no signature header at all", () => {
    expect(verifyTwilioSignature({
      authToken: VECTOR.token, url: VECTOR.url, params: VECTOR.params, signature: null,
    }).ok).toBe(false);
  });

  it("rejects a signature of the wrong length without throwing", () => {
    // timingSafeEqual throws on mismatched lengths; a thrown error inside the
    // verifier would become a 500 rather than a 403.
    expect(() => verifyTwilioSignature({
      authToken: VECTOR.token, url: VECTOR.url, params: VECTOR.params, signature: "short",
    })).not.toThrow();
  });
});

describe("the URL the signature is checked against", () => {
  it("prefers the one configured, because that is what Twilio was told to call", () => {
    expect(webhookUrl({
      configured: "https://cc.example.com/api/webhooks/twilio-inbound",
      requestUrl: "http://localhost/api/webhooks/twilio-inbound",
      forwardedProto: "https", forwardedHost: "somewhere-else.vercel.app",
    })).toBe("https://cc.example.com/api/webhooks/twilio-inbound");
  });

  it("restores the scheme and host the proxy replaced", () => {
    // Vercel terminates TLS ahead of the function, so the request arriving
    // here says http while Twilio called https — and the scheme is part of the
    // signed string.
    expect(webhookUrl({
      configured: undefined,
      requestUrl: "http://internal.local/api/webhooks/twilio-inbound",
      forwardedProto: "https", forwardedHost: "cc.example.com",
    })).toBe("https://cc.example.com/api/webhooks/twilio-inbound");
  });

  it("keeps the query string, which is signed too", () => {
    expect(webhookUrl({
      configured: undefined,
      requestUrl: "http://internal.local/hook?a=1&b=2",
      forwardedProto: "https", forwardedHost: "cc.example.com",
    })).toBe("https://cc.example.com/hook?a=1&b=2");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Reading what Twilio sent
   ───────────────────────────────────────────────────────────────────────── */

describe("Twilio's payload, read into the shape the system already speaks", () => {
  const base = {
    From: "+15163448418", To: "+15167885933", Body: "sounds good",
    MessageSid: "SM123", NumMedia: "0",
  };

  it("maps the fields the decision needs", () => {
    expect(twilioToInbound(base)).toMatchObject({
      originationNumber: "+15163448418",
      destinationNumber: "+15167885933",
      messageBody: "sounds good",
      inboundMessageId: "SM123",
    });
  });

  it("collects media without ever fetching it", () => {
    const m = twilioToInbound({ ...base, NumMedia: "2", MediaUrl0: "https://a", MediaUrl1: "https://b" });
    expect(m.mediaUrls).toEqual(["https://a", "https://b"]);
  });

  it("survives a NumMedia that is missing, junk or absurd", () => {
    expect(twilioToInbound({ ...base, NumMedia: "" }).mediaUrls).toEqual([]);
    expect(twilioToInbound({ ...base, NumMedia: "banana" }).mediaUrls).toEqual([]);
    expect(twilioToInbound({ ...base, NumMedia: "-3" }).mediaUrls).toEqual([]);
    // A huge count must not spin; it is capped and the absent URLs are skipped.
    expect(twilioToInbound({ ...base, NumMedia: "99999" }).mediaUrls).toEqual([]);
  });

  it("falls back to SmsMessageSid when MessageSid is absent", () => {
    const { MessageSid: _drop, ...noSid } = base;
    expect(twilioToInbound({ ...noSid, SmsMessageSid: "SM456" }).inboundMessageId).toBe("SM456");
  });

  it("hands a STOP to the same classifier AWS messages go through", () => {
    // The whole reason for translating rather than re-deciding: one opt-out
    // rule, tested once, for both carriers.
    const d = decideInbound(twilioToInbound({ ...base, Body: "Stop." }));
    expect(d.kind).toBe("accept");
    expect(d.kind === "accept" && d.keyword).toBe("opt_out");
  });

  it("is refused, not half-stored, when the payload is unusable", () => {
    const d = decideInbound(twilioToInbound({ ...base, From: "not a phone" }));
    expect(d.kind).toBe("reject");
  });

  it("reads form parameters the way Twilio's own validators do", () => {
    expect(formParams(new URLSearchParams("A=1&B=two&C=%2B15163448418")))
      .toEqual({ A: "1", B: "two", C: "+15163448418" });
  });
});
