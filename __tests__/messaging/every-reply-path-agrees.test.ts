import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { latestInboundIsAnswered } from "@/lib/messaging/handoff";

/**
 * FOUR DOORS OUT, AND ONLY ONE OF THEM KNEW IT WAS ANSWERING SOMEBODY.
 *
 * A reply to a customer who has just written obeys the federal 8 AM-9 PM on
 * their own clock. Contact PPP STARTS obeys a narrower window — 9 AM to 7 PM
 * plus the office being open — because that is a callback to set an
 * appointment, not an answer. The gate is told which by `answersInbound`.
 *
 * Only sendHeldReply passed it. The immediate autosend, a reviewer approving a
 * draft, and a person typing into the thread all did not — so after 7 PM the
 * same reply to the same message was legal or not depending on which door it
 * came through, and which door it came through depends on whether that
 * workspace happens to have a reply delay configured.
 *
 * The customer experience is the part that matters: somebody who texts at 7:25
 * PM gets the bot's answer, and gets silence from the person who tried to
 * answer them by hand at 7:30.
 *
 * Asserted on the call sites rather than through the gate, because what was
 * wrong was the ARGUMENT, not the rule it feeds.
 */
describe("every path that answers a customer says so", () => {
  /**
   * EACH SITE IS ASSERTED ON THE ARGUMENT'S PRESENCE, NOT ITS VALUE.
   *
   * The first version of this test matched the literal `answersInbound: true`
   * for the draft path. That pinned the bug's opposite rather than the rule:
   * when the draft path was corrected to ASK the question instead of assuming
   * the answer, this test went red while the thing it exists to protect was
   * still true. A constant is an instance. "This call site tells the gate" is
   * the shape.
   */
  const sites: [string, RegExp][] = [
    ["the held reply", /agent: "agent_autosend",\s*\n?\s*answersInbound:/],
    ["the immediate autosend", /agent: "agent_autosend", answersInbound:/],
    ["approving a draft", /agent: "human_review",\s*\n?\s*answersInbound:/],
    ["a person's own reply", /agent: "human_reply", answersInbound:/],
  ];

  it.each(sites)("%s", (_label, re) => {
    const src = [
      readFileSync("lib/messaging/scheduler-db.ts", "utf8"),
      readFileSync("lib/messaging/drafts-write.ts", "utf8"),
      readFileSync("lib/messaging/reply-write.ts", "utf8"),
    ].join("\n");
    expect(re.test(src)).toBe(true);
  });

  /**
   * AND THE TWO THAT CAN BE STALE MUST SAY WHEN.
   *
   * answersInbound waives PPP's own hours, the weekend rule and the holiday
   * rule, on the grounds that the customer wrote just now. A review queue and
   * a person scrolling back through old threads both break that — nothing ages
   * a pending draft out, so the claim can be days old by the time somebody
   * presses Send. These two pass the inbound's time and let the gate judge it
   * on the recipient's own day. The autosend and the held reply run inside the
   * turn that read the message and have no queue to go stale in.
   */
  it.each([
    ["approving a draft", "lib/messaging/drafts-write.ts"],
    ["a person's own reply", "lib/messaging/reply-write.ts"],
  ])("%s also tells the gate WHEN the customer wrote", (_label, file) => {
    const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src, file).toMatch(/answersInboundAt:\s*latestInboundAt\(/);
  });

  it("no gatedSend in a reply path is left without the flag", () => {
    // The shape that was wrong, and it reads perfectly naturally.
    for (const f of ["lib/messaging/drafts-write.ts", "lib/messaging/reply-write.ts"]) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, f).not.toMatch(/agent: "human_re\w+" \}/);
    }
  });
});

/**
 * A PERSON'S OWN REPLY IS THE ONE THAT GENUINELY DEPENDS.
 *
 * A draft always answers an inbound — answers_message_id is what makes it a
 * draft. Somebody typing into a thread may be answering, or may be picking a
 * conversation back up days later, which is contact PPP starts.
 */
describe("whether a human reply is answering anybody", () => {
  const at = (iso: string, direction: "inbound" | "outbound") => ({ direction, created_at: iso });

  it("is answering when the customer spoke last", () => {
    expect(latestInboundIsAnswered([
      at("2026-10-06T18:00:00Z", "outbound"),
      at("2026-10-06T19:00:00Z", "inbound"),
    ])).toBe(false);
  });

  it("is NOT answering when we spoke last", () => {
    expect(latestInboundIsAnswered([
      at("2026-10-06T19:00:00Z", "inbound"),
      at("2026-10-06T19:05:00Z", "outbound"),
    ])).toBe(true);
  });

  it("treats an empty thread as nothing owed", () => {
    expect(latestInboundIsAnswered([])).toBe(true);
  });
});
