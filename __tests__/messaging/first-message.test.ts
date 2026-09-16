import { describe, it, expect } from "vitest";
import {
  firstMessageChecks, firstMessageProblem, applyFirstMessageFix, openerStepId, smsSegments,
  withDisclosure, needsDisclosure,
} from "@/lib/messaging/first-message";
import { withDisclosure as gateWithDisclosure, needsDisclosure as gateNeeds } from "@/lib/messaging/gate";

/** PPP's live opener, from migration 199. It must pass as written. */
const PPP_OPENER =
  "Hello, this is Precision Painting Plus. Thanks for requesting a free estimate! Could you share details about your project and your availability for an appointment? Call us at {{workspace_phone}} with any questions. Reply END to stop texts.";

describe("what the first text has to say", () => {
  it("PPP's own opener already passes, so nothing live breaks", () => {
    expect(firstMessageProblem(PPP_OPENER)).toBeNull();
    expect(firstMessageChecks(PPP_OPENER).every((c) => c.ok)).toBe(true);
  });

  it("refuses one that does not say who it is from", () => {
    const p = firstMessageProblem("Thanks for reaching out! Reply STOP to opt out.");
    expect(p).toMatch(/Precision Painting Plus/);
    expect(p).not.toMatch(/how to stop/);
  });

  it("refuses one that does not say how to stop", () => {
    const p = firstMessageProblem("Hi, this is Precision Painting Plus. When can we come by?");
    expect(p).toMatch(/how to stop/);
  });

  it("names both when both are missing", () => {
    const p = firstMessageProblem("Hi! When can we come by?");
    expect(p).toMatch(/Precision Painting Plus/);
    expect(p).toMatch(/how to stop/);
  });

  it("accepts any of the stop words the system honours", () => {
    for (const s of ["Reply STOP to opt out.", "Text END to stop.", "Reply QUIT anytime.", "To unsubscribe, reply here.", "Opt-out anytime."]) {
      expect(needsDisclosure(`This is Precision Painting Plus. ${s}`)).toBe(false);
    }
  });
});

describe("the one-tap fixes", () => {
  it("puts the name at the front and the stop line at the end, and then it passes", () => {
    let body = "Thanks for requesting a free estimate!";
    body = applyFirstMessageFix(body, "business_name");
    body = applyFirstMessageFix(body, "opt_out");
    expect(body).toBe("This is Precision Painting Plus. Thanks for requesting a free estimate! Reply STOP to opt out.");
    expect(firstMessageProblem(body)).toBeNull();
  });

  it("does not add either twice", () => {
    expect(applyFirstMessageFix(PPP_OPENER, "business_name")).toBe(PPP_OPENER);
    expect(applyFirstMessageFix(PPP_OPENER, "opt_out")).toBe(PPP_OPENER);
  });
});

describe("which step is the first text", () => {
  it("is the lowest-ordinal text, not an email that happens to come first", () => {
    expect(openerStepId([
      { id: "e", ordinal: 1, channel: "email" },
      { id: "b", ordinal: 3, channel: "sms" },
      { id: "a", ordinal: 2, channel: "sms" },
    ])).toBe("a");
    expect(openerStepId([{ id: "e", ordinal: 1, channel: "email" }])).toBeNull();
  });
});

describe("the editor and the gate agree", () => {
  it("use the same stop-line test, so the preview is what the gate sends", () => {
    for (const b of ["Hello", "Hello. Reply END to stop texts.", "Reply stop"]) {
      expect(withDisclosure(b)).toBe(gateWithDisclosure(b));
      expect(needsDisclosure(b)).toBe(gateNeeds(b));
    }
  });
});

describe("how many texts it costs", () => {
  it("counts plain text in 160s and switches to 70 when an emoji is in it", () => {
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("Thanks 👍")).toBe(1);
    expect(smsSegments("a".repeat(69) + "👍")).toBe(2);
  });

  it("PPP's opener with a number filled in and nothing appended is two texts", () => {
    const sent = withDisclosure(PPP_OPENER.replace("{{workspace_phone}}", "516-344-8418"));
    expect(smsSegments(sent)).toBe(2);
  });
});
