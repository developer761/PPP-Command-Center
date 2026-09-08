import { describe, it, expect } from "vitest";
import { decideInbound } from "@/lib/messaging/inbound";

const msg = (o: Record<string, unknown> = {}) => ({
  originationNumber: "+15163448418",
  destinationNumber: "+15167885933",
  messageBody: "Hi, looking for a quote",
  inboundMessageId: "aws-1",
  ...o,
});

describe("deciding what an inbound message is", () => {
  it("accepts an ordinary reply", () => {
    const d = decideInbound(msg());
    expect(d.kind).toBe("accept");
    if (d.kind === "accept") {
      expect(d.from).toBe("+15163448418");
      expect(d.keyword).toBeNull();
    }
  });

  it.each(["STOP", "stop", "Stop.", "END", "unsubscribe", "QUIT"])(
    "recognises %j as an opt-out", (body) => {
      const d = decideInbound(msg({ messageBody: body }));
      expect(d.kind).toBe("accept");
      if (d.kind === "accept") expect(d.keyword).toBe("opt_out");
    }
  );

  it("recognises HELP", () => {
    const d = decideInbound(msg({ messageBody: "HELP" }));
    if (d.kind === "accept") expect(d.keyword).toBe("help");
  });

  it("does not read an opt-out out of ordinary prose", () => {
    // "Stop by whenever" is not an opt-out, and treating it as one silently
    // loses a customer.
    const d = decideInbound(msg({ messageBody: "Can you stop by on Friday to look at it?" }));
    if (d.kind === "accept") expect(d.keyword).toBeNull();
  });

  it("falls back to the keyword AWS matched when the body reads as ordinary", () => {
    const d = decideInbound(msg({ messageBody: "....", messageKeyword: "STOP" }));
    if (d.kind === "accept") expect(d.keyword).toBe("opt_out");
  });

  it("prefers our own classification over AWS's", () => {
    const d = decideInbound(msg({ messageBody: "STOP", messageKeyword: "CONFIRM" }));
    if (d.kind === "accept") expect(d.keyword).toBe("opt_out");
  });

  it("counts media without fetching any of it", () => {
    const d = decideInbound(msg({ messageBody: "", mediaUrls: ["u1", "u2"] }));
    expect(d.kind).toBe("accept");
    if (d.kind === "accept") expect(d.mediaCount).toBe(2);
  });

  it("accepts a photo with no words at all", () => {
    const d = decideInbound(msg({ messageBody: "  ", mediaUrls: ["u1"] }));
    expect(d.kind).toBe("accept");
  });

  it("refuses a message with neither text nor media", () => {
    expect(decideInbound(msg({ messageBody: "" })).kind).toBe("reject");
  });

  it("refuses rather than guesses at an unusable number", () => {
    expect(decideInbound(msg({ originationNumber: "12345" })).kind).toBe("reject");
    expect(decideInbound(msg({ destinationNumber: undefined })).kind).toBe("reject");
  });

  /** Without an id, an SNS redelivery would post the same reply twice. */
  it("refuses a message with no id, because a retry could not be recognised", () => {
    const d = decideInbound(msg({ inboundMessageId: undefined }));
    expect(d.kind).toBe("reject");
    if (d.kind === "reject") expect(d.reason).toMatch(/retry/);
  });

  it("normalises the numbers it accepts", () => {
    const d = decideInbound(msg({ originationNumber: "(516) 344-8418" }));
    if (d.kind === "accept") expect(d.from).toBe("+15163448418");
  });
});
