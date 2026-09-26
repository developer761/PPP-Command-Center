/**
 * Call forwarding, moved into Iteration 1 by Kate on 2026-09-26:
 * "customers do call the number we're texting them on and we'd want the call
 * forwarded to the call center."
 */
import { describe, it, expect } from "vitest";
import { forwardPlan, forwardTwiml, MAIN_LINE } from "@/lib/messaging/voice-forward";

describe("where the call goes", () => {
  it("to the workspace's own number when it has one", () => {
    const p = forwardPlan({ forwardTo: "+15551234567", known: true, callerId: "+15169998888" });
    expect(p).toEqual({ kind: "dial", to: "+15551234567", callerId: "+15169998888" });
  });

  /**
   * NOT a refusal. A workspace nobody has configured still reaches a human —
   * the alternative is a customer hearing a failed call and concluding PPP
   * does not answer its phone.
   */
  it("to the main line when the workspace has no number set", () => {
    const p = forwardPlan({ forwardTo: null, known: true });
    expect(p).toEqual({ kind: "dial", to: MAIN_LINE, callerId: null });
    expect(forwardPlan({ forwardTo: "   ", known: true })).toEqual({ kind: "dial", to: MAIN_LINE, callerId: null });
  });

  it("nowhere only when the number matches no workspace at all", () => {
    expect(forwardPlan({ known: false })).toEqual({ kind: "no_destination" });
  });
});

describe("the TwiML Twilio runs", () => {
  it("dials, and shows the CUSTOMER as the caller", () => {
    // So the agent sees who is calling and can ring back. Ours would make
    // every call look like it came from the campaign line.
    const x = forwardTwiml({ kind: "dial", to: "+18776453563", callerId: "+15169998888" });
    expect(x).toContain("<Dial");
    expect(x).toContain("+18776453563</Dial>");
    expect(x).toContain('callerId="+15169998888"');
  });

  it("rings audibly rather than leaving dead air", () => {
    // Without answerOnBridge the caller hears silence while the far end
    // rings, which people hang up in.
    expect(forwardTwiml({ kind: "dial", to: "+1", callerId: null })).toContain('answerOnBridge="true"');
  });

  it("times out rather than ringing forever", () => {
    expect(forwardTwiml({ kind: "dial", to: "+1", callerId: null })).toContain('timeout="25"');
  });

  it("omits callerId entirely when there is none", () => {
    expect(forwardTwiml({ kind: "dial", to: "+1", callerId: null })).not.toContain("callerId");
  });

  it("speaks a number rather than dropping an unknown call", () => {
    const x = forwardTwiml({ kind: "no_destination" });
    expect(x).toContain("<Say");
    expect(x).not.toContain("<Dial");
    expect(x).toMatch(/Precision Painting Plus/);
  });

  it("is well-formed XML with a declaration", () => {
    for (const p of [{ kind: "dial" as const, to: "+1", callerId: null }, { kind: "no_destination" as const }]) {
      const x = forwardTwiml(p);
      expect(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(x).toContain("<Response>");
      expect(x).toContain("</Response>");
    }
  });

  it("escapes anything that could break the document", () => {
    const x = forwardTwiml({ kind: "dial", to: 'a&b"c<d', callerId: null });
    expect(x).toContain("a&amp;b&quot;c&lt;d");
    expect(x).not.toMatch(/to="a&b/);
  });
});

describe("what this deliberately is NOT", () => {
  /**
   * Hatch does three voice things: forwarding, voicemail greetings, and
   * inbound-call AI agents. Kate asked for the first. The columns for the
   * other two exist on the workspace and are left unused on purpose — a
   * greeting nobody recorded is not a feature, and recording calls is a
   * consent question in two-party states that nobody has asked.
   */
  it("never records, and never plays a greeting", () => {
    const x = forwardTwiml({ kind: "dial", to: "+1", callerId: null });
    expect(x).not.toContain("<Record");
    expect(x).not.toContain("<Play");
    expect(x).not.toContain("record=");
  });
});
