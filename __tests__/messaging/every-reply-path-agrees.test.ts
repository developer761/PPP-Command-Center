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
  const sites: [string, RegExp][] = [
    ["the held reply", /agent: "agent_autosend",\s*\n?\s*answersInbound: true/],
    ["the immediate autosend", /agent: "agent_autosend", answersInbound: true/],
    ["approving a draft", /agent: "human_review", answersInbound: true/],
    ["a person's own reply", /agent: "human_reply", answersInbound: answering/],
  ];

  it.each(sites)("%s", (_label, re) => {
    const src = [
      readFileSync("lib/messaging/scheduler-db.ts", "utf8"),
      readFileSync("lib/messaging/drafts-write.ts", "utf8"),
      readFileSync("lib/messaging/reply-write.ts", "utf8"),
    ].join("\n");
    expect(re.test(src)).toBe(true);
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
