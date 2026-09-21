import { describe, it, expect } from "vitest";
import { helpReply, helpReplyChecks, humanPhone } from "@/lib/messaging/help-reply";
import { classifyInbound } from "@/lib/messaging/compliance";
import { smsSegments } from "@/lib/messaging/first-message";

/**
 * HELP was recognised and answered by nobody.
 *
 * compliance.ts has carried "a reply is legally required" since the keywords
 * were written; the only thing that consumed the classification used it to keep
 * the agent away. Carriers check HELP during A2P campaign vetting, which PPP is
 * in the middle of.
 */
describe("the HELP reply says everything it has to", () => {
  const body = helpReply("+15163448418");

  it("contains all four obligations", () => {
    // Asserted as OBLIGATIONS rather than as one exact string: a test pinned to
    // the exact wording passes happily for a reply that lost half its meaning
    // to a rewrite.
    for (const c of helpReplyChecks(body)) expect(c.ok, c.label).toBe(true);
  });

  it("names the company", () => {
    expect(body).toMatch(/Precision Painting Plus/);
  });

  it("gives back the number they texted, not a switchboard", () => {
    // Somebody texted by the 516 number should be told to call the 516 number.
    expect(body).toContain("(516) 344-8418");
  });

  it("tells them how to stop", () => {
    expect(body).toMatch(/Reply STOP to opt out\./);
  });

  it("fits in one text", () => {
    // A HELP reply that fragments across segments reads as spam, and is the
    // one message guaranteed to be read by somebody already unsure about us.
    expect(smsSegments(body)).toBe(1);
  });
});

describe("a workspace with no number still gets a usable reply", () => {
  const body = helpReply(null);

  it("never says to call nothing", () => {
    expect(body).not.toMatch(/null|undefined|\(\)/);
    expect(body).not.toMatch(/Call us at\s*\./);
  });

  it("still carries the obligations it can", () => {
    for (const key of ["business_name", "program", "rates", "opt_out"]) {
      expect(helpReplyChecks(body).find((c) => c.key === key)?.ok, key).toBe(true);
    }
  });
});

describe("the checks can fail — otherwise they prove nothing", () => {
  it("catches a reply that forgot how to stop", () => {
    const bad = "Precision Painting Plus: estimates. Msg & data rates may apply.";
    expect(helpReplyChecks(bad).find((c) => c.key === "opt_out")?.ok).toBe(false);
  });

  it("catches a reply that forgot the rates line", () => {
    const bad = "Precision Painting Plus: estimates. Reply STOP to opt out.";
    expect(helpReplyChecks(bad).find((c) => c.key === "rates")?.ok).toBe(false);
  });

  it("catches a reply that never says who it is", () => {
    const bad = "Estimates and appointments. Msg & data rates may apply. Reply STOP to opt out.";
    expect(helpReplyChecks(bad).find((c) => c.key === "business_name")?.ok).toBe(false);
  });
});

describe("phone numbers are shown the way a person reads them", () => {
  it("formats a US number", () => {
    expect(humanPhone("+15163448418")).toBe("(516) 344-8418");
  });

  it("leaves anything else alone rather than mangling it", () => {
    expect(humanPhone("+442079460958")).toBe("+442079460958");
  });

  it("is null when there is no number, not the string null", () => {
    expect(humanPhone(null)).toBeNull();
    expect(humanPhone("")).toBeNull();
  });
});

describe("what counts as asking for help", () => {
  it("recognises the words carriers require", () => {
    for (const w of ["HELP", "help", "Help", "INFO", "info"]) {
      expect(classifyInbound(w), w).toBe("help");
    }
  });

  it("does not read an ordinary sentence as a HELP keyword", () => {
    // "Can you help me choose a color?" is a customer question for the agent,
    // not a carrier keyword — answering it with boilerplate would be worse
    // than useless.
    expect(classifyInbound("Can you help me choose a color?")).toBe("normal");
  });
});
