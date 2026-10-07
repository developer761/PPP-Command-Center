import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TwilioTransport } from "@/lib/messaging/transports/twilio";
import type { E164 } from "@/lib/messaging/phone";

/**
 * THE ONE PROPERTY THAT MATTERS ON THE DAY SENDING IS SWITCHED ON.
 *
 * Nothing in this system can tell the difference between "the carrier never
 * saw it" and "the carrier took it and we lost the answer" — and the two want
 * opposite handling. Every caller treats a throw from the transport as the
 * first: the scheduler reschedules it as an error and retries up to five
 * times, and the review queue leaves the draft claimed so it returns to the
 * queue after two minutes.
 *
 * So the rule is: PAST ACCEPTANCE, NOTHING THROWS. Both audits of this
 * codebase found the same thing from different directions, and both found it
 * in more than one place, so it is asserted here as a property rather than
 * patched per site.
 *
 * The cost is a message we cannot correlate with a delivery receipt. The
 * alternative is a customer receiving the same text up to five times, which on
 * a marketing message is a complaint and a compliance problem.
 */
const t = () => new TwilioTransport({
  live: true, why: "test", carrier: "twilio",
  twilio: { accountSid: "AC1", apiKeySid: "SK1", apiKeySecret: "secret" },
} as unknown as ConstructorParameters<typeof TwilioTransport>[0]);

const FROM = "+15163448418" as E164;
const TO = "+15167885933" as E164;

describe("a message the carrier accepted is never sent again", () => {
  /** Every 2xx shape the adapter can meet. None may throw. */
  const accepted: [string, string][] = [
    ["a normal queued message", JSON.stringify({ sid: "SM1", status: "queued" })],
    ["no sid at all", JSON.stringify({ status: "queued" })],
    ["an empty object", "{}"],
    ["a proxy's HTML error page", "<html>502 Bad Gateway</html>"],
    ["an empty body", ""],
  ];

  it.each(accepted)("does not throw on 201 with %s", async (_label, body) => {
    globalThis.fetch = (async () => new Response(body, { status: 201 })) as typeof fetch;
    const res = await t().send(TO, FROM, "hello");
    expect(res.providerId).toBeTruthy();
  });

  it("still throws when the carrier REFUSED it, which is not a send", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ code: 21211, message: "invalid number" }), { status: 400 })) as typeof fetch;
    await expect(t().send(TO, FROM, "hello")).rejects.toThrow();
  });

  it("still throws on a 201 that already failed, which nobody received", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ sid: "SM9", status: "failed", error_message: "unreachable" }), { status: 201 })) as typeof fetch;
    await expect(t().send(TO, FROM, "hello")).rejects.toThrow(/unreachable/);
  });
});

/**
 * And the other half: the writes that CLOSE a row after a send must be checked.
 *
 * postgrest-js does not throw — it returns `{ error }` — so `await sb.from(…)
 * .update(…)` with the result discarded is a write that can silently not
 * happen. After a send, that leaves the row claimed or the draft pending, and
 * both are picked up again and sent a second time.
 */
describe("the writes that close a sent row are not discarded", () => {
  it("markSent checks the update that marks the action done", () => {
    const src = readFileSync("lib/messaging/scheduler-db.ts", "utf8");
    const markSent = src.slice(src.indexOf("async markSent("), src.indexOf("async reschedule("));
    expect(markSent).toMatch(/state: "failed"/);
    expect(markSent).toMatch(/sms_sent_not_closed/);
    // The shape that was wrong: an awaited update whose result is thrown away.
    expect(markSent).not.toMatch(/await sb\.from\("sms_scheduled_actions"\)\.update\(\{ state: "done"/);
  });

  it("sendDraft checks the update that marks the draft sent", () => {
    const src = readFileSync("lib/messaging/drafts-write.ts", "utf8");
    expect(src).toMatch(/sms_draft_sent_not_closed/);
    expect(src).toMatch(/closeErr/);
  });

  it("a refused reply that cannot be filed as a draft throws rather than vanishing", () => {
    // Returning "drafted" marks the action done, so a discarded insert error
    // means no message, no draft, and a closed action: answered by nobody.
    const src = readFileSync("lib/messaging/scheduler-db.ts", "utf8");
    expect(src).toMatch(/could not write the refused reply as a draft/);
    expect(src).toMatch(/could not write the held reply as a draft/);
  });
});
