import { describe, it, expect } from "vitest";
import { renderMessage, OPT_OUT_DISCLOSURE } from "@/lib/messaging/render";
import { classifyInbound } from "@/lib/messaging/compliance";

/**
 * The first thing a stranger receives from an automated system has to tell
 * them how to make it stop. That is a TCPA requirement, and it was missing
 * from every outbound message this system could produce — PPP's own campaign
 * text has carried "Reply END to stop texts." the whole time.
 */
describe("the opt-out disclosure", () => {
  it("is on the first message we ever send someone", () => {
    const out = renderMessage({ intent: "ask_project_details", isFirstOutbound: true });
    expect(out).toContain(OPT_OUT_DISCLOSURE);
  });

  it("is not repeated on later messages", () => {
    const out = renderMessage({ intent: "ask_address", isFirstOutbound: false });
    expect(out).not.toContain(OPT_OUT_DISCLOSURE);
    // Repeating it every time is what makes a thread read like spam.
    expect(renderMessage({ intent: "ask_address" })).not.toContain(OPT_OUT_DISCLOSURE);
  });

  it("comes after the message, not instead of it", () => {
    const out = renderMessage({ intent: "ask_project_details", isFirstOutbound: true });
    expect(out).toMatch(/painted\?? .*Reply STOP/i);
    expect(out.indexOf(OPT_OUT_DISCLOSURE)).toBeGreaterThan(10);
  });

  /** A disclosure on its own is not a message. */
  it("is not sent alone when there is nothing to say", () => {
    // answer_question with no rapport renders nothing; appending the
    // disclosure would turn a dropped turn into a bare "Reply STOP to opt out."
    expect(renderMessage({ intent: "answer_question", isFirstOutbound: true })).toBe("");
  });

  it("is not appended to an intent that stays silent on purpose", () => {
    expect(renderMessage({ intent: "discard", isFirstOutbound: true })).toBe("");
    expect(renderMessage({ intent: "msg_liked_loved", isFirstOutbound: true })).toBe("");
  });

  /**
   * The word we tell them to send has to be one we actually act on. This is
   * the pairing that matters: a disclosure naming a keyword the system ignores
   * is worse than none.
   */
  it("names a keyword the system honours", () => {
    expect(classifyInbound("STOP")).toBe("opt_out");
  });

  it("also honours what PPP's existing campaigns tell people to send", () => {
    for (const word of ["END", "STOP", "QUIT", "UNSUBSCRIBE", "CANCEL"]) {
      expect(classifyInbound(word), word).toBe("opt_out");
    }
  });

  it("keeps the first message a sane length", () => {
    const out = renderMessage({ intent: "ask_project_details", isFirstOutbound: true });
    expect(out.length).toBeLessThan(320);
  });
});
