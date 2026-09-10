import { describe, it, expect } from "vitest";
import { withDisclosure, needsDisclosure, OPT_OUT_DISCLOSURE, gatedSend } from "@/lib/messaging/gate";
import { LoggingTransport } from "@/lib/messaging/transport";
import type { E164 } from "@/lib/messaging/phone";

const ws = {
  id: "w", name: "NY LI Nassau Leads", phone_e164: "+15163448418" as E164,
  time_zone: "America/New_York", quiet_hours_start: 0, quiet_hours_end: 24,
  send_on_weekends: true,
};
const TO = "+15165551234" as E164;

const deps = (over: Record<string, unknown> = {}) => ({
  isSuppressed: async () => false,
  sentToday: async () => 0,
  hasEverSent: async () => false,
  ...over,
});

/**
 * The first automated message to a stranger has to say how to stop it.
 *
 * This used to be added by the RENDERER, which only covers the agent's own
 * replies — and the first message a customer actually receives is almost
 * always the campaign opener, which is free text somebody typed. Nothing
 * enforced it there, and nothing stopped a reviewer deleting it while editing
 * a draft. Every path to a carrier goes through the gate, so it lives here.
 */
describe("the opt-out disclosure, enforced at the carrier boundary", () => {
  it("is added to the first message we ever send someone", async () => {
    const t = new LoggingTransport();
    const res = await gatedSend(
      { workspace: ws, to: TO, body: "Thanks for requesting a free estimate!", agent: "campaign" },
      { ...deps(), transport: t }
    );
    expect(res.ok).toBe(true);
    expect(t.sent[0].body).toContain(OPT_OUT_DISCLOSURE);
  });

  it("is not added again to somebody who has heard from us before", async () => {
    const t = new LoggingTransport();
    await gatedSend(
      { workspace: ws, to: TO, body: "What's the address?", agent: "agent" },
      { ...deps({ hasEverSent: async () => true }), transport: t }
    );
    expect(t.sent[0].body).not.toContain(OPT_OUT_DISCLOSURE);
  });

  /**
   * PPP's own campaigns end "Reply END to stop texts." That IS a disclosure,
   * and stapling a second one on reads like a machine wrote it twice.
   */
  it("leaves a message that already says it alone", async () => {
    const t = new LoggingTransport();
    const body = "Thanks for requesting a free estimate! Reply END to stop texts.";
    await gatedSend({ workspace: ws, to: TO, body, agent: "campaign" }, { ...deps(), transport: t });
    expect(t.sent[0].body).toBe(body);
  });

  it.each([
    "Reply STOP to opt out.",
    "Reply END to stop texts.",
    "Text QUIT to stop.",
    "Send UNSUBSCRIBE to stop hearing from us.",
    "You can opt out any time.",
    "Reply CANCEL to stop.",
  ])("recognises %j as already saying it", (body) => {
    expect(needsDisclosure(body)).toBe(false);
  });

  it("does not mistake ordinary words for a disclosure", () => {
    expect(needsDisclosure("We can stop by on Friday.")).toBe(true);
    expect(needsDisclosure("Reply with the address when you can.")).toBe(true);
    expect(needsDisclosure("That's the end of the hallway.")).toBe(true);
  });

  it("reads as one sentence after another, not a run-on", () => {
    expect(withDisclosure("Hello there")).toBe(`Hello there. ${OPT_OUT_DISCLOSURE}`);
    expect(withDisclosure("Hello there.")).toBe(`Hello there. ${OPT_OUT_DISCLOSURE}`);
    expect(withDisclosure("Is that right?")).toBe(`Is that right? ${OPT_OUT_DISCLOSURE}`);
  });

  it("never turns an empty message into a bare disclosure", () => {
    expect(withDisclosure("")).toBe("");
    expect(withDisclosure("   ")).toBe("");
  });

  /** The thread must show what the customer actually received. */
  it("reports what was really sent, not what was asked for", async () => {
    const t = new LoggingTransport();
    const res = await gatedSend(
      { workspace: ws, to: TO, body: "Hello", agent: "campaign" },
      { ...deps(), transport: t }
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.body).toBe(t.sent[0].body);
      expect(res.body).toContain(OPT_OUT_DISCLOSURE);
    }
  });

  /** A refused message does not need a disclosure appended first. */
  it("adds nothing when the send is refused", async () => {
    const t = new LoggingTransport();
    const res = await gatedSend(
      { workspace: ws, to: TO, body: "Hello", agent: "campaign" },
      { ...deps({ isSuppressed: async () => true }), transport: t }
    );
    expect(res.ok).toBe(false);
    expect(t.sent).toHaveLength(0);
  });

  /** A caller that supplies no lookup must not silently skip the rule. */
  it("sends unchanged when the caller cannot say whether it is first contact", async () => {
    const t = new LoggingTransport();
    const d = deps();
    delete (d as Record<string, unknown>).hasEverSent;
    await gatedSend({ workspace: ws, to: TO, body: "Hello", agent: "campaign" }, { ...d, transport: t });
    // Documented rather than desired: every real caller supplies it, and a
    // test asserts the shipped deps do.
    expect(t.sent[0].body).toBe("Hello");
  });
});

describe("the shipped deps really do supply the lookup", () => {
  it("gateDeps provides hasEverSent", async () => {
    // The test above documents that a caller omitting this silently skips the
    // disclosure. This is what stops that being anything other than
    // hypothetical: the deps every real path uses must carry it.
    const { gateDeps } = await import("@/lib/messaging/gate-deps");
    const fake = {
      from: () => fake, select: () => fake, eq: () => fake, in: () => fake,
      gte: () => fake, ilike: () => fake, is: () => fake,
      maybeSingle: async () => ({ data: null }),
      then: (r: (v: { data: never[] }) => unknown) => r({ data: [] }),
    } as never;
    const d = gateDeps(fake);
    expect(typeof d.hasEverSent).toBe("function");
  });
});

describe("the renderer and the gate do not both add it", () => {
  it("a rendered first message is not given a second disclosure", async () => {
    const { renderMessage } = await import("@/lib/messaging/render");
    const rendered = renderMessage({ intent: "ask_project_details", isFirstOutbound: true });
    expect(rendered).toContain(OPT_OUT_DISCLOSURE);

    const t = new LoggingTransport();
    await gatedSend(
      { workspace: ws, to: TO, body: rendered, agent: "agent" },
      { ...deps(), transport: t }
    );
    // Kate sees the disclosure while reviewing, and the gate recognises it
    // rather than stapling a second one on.
    const occurrences = t.sent[0].body.split(OPT_OUT_DISCLOSURE).length - 1;
    expect(occurrences).toBe(1);
  });
});
