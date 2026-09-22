import { describe, it, expect } from "vitest";
import { SAYS } from "@/lib/messaging/render";
import { checkRapport } from "@/lib/messaging/agent-output";
import { afterHoursReply } from "@/lib/messaging/after-hours";
import { helpReply } from "@/lib/messaging/help-reply";

/**
 * THE TEMPLATES MUST OBEY THE RULES WE GIVE THE MODEL.
 *
 * A23 — "no em dashes, no parenthetical prose, no ellipsis, no hyphenated
 * compounds, no semicolons" — is the most broken rule in Kate's grading:
 * 618 breaches, 27% of every defect she marked across 1,234 conversations.
 *
 * The reason it was broken so often was not the model ignoring it. The style
 * check ran on the model's RAPPORT only, so three of the templates the bot
 * sends were themselves breaching A23 on every send that used them ("the
 * write-up", "an off-site quote", "a friendly check-in"), and the system
 * prompt that hands the model the rule was itself written with five em dashes
 * and the compound "in-person" — Kate's own example of the violation.
 *
 * You cannot ask a model to write in a register while showing it the opposite
 * register. So the rule is now checked where the words actually come from.
 */

/** A23, as Kate states it. Letters both sides of the hyphen so a phone number
 *  or a date range is not mistaken for a compound. */
const A23 = [
  { re: /[—–]/, why: "em dash" },
  { re: /\.\.\.|…/, why: "ellipsis" },
  // PROSE, which is the word Kate uses. "(516) 344-8418" is a phone number in
  // the format every American writes it in, and it appears in the one reply
  // CTIA obliges us to send verbatim. A rule that fired on it would be
  // demanding we break a compliance obligation over punctuation.
  { re: /\([^)]*[A-Za-z]{2,}[^)]*\)/, why: "parenthetical prose" },
  { re: /[a-z]{2,}-[a-z]{2,}/i, why: "hyphenated compound" },
  { re: /;/, why: "semicolon" },
];

const breaches = (text: string) =>
  A23.filter((r) => r.re.test(text)).map((r) => r.why);

describe("the templates obey A23", () => {
  const all = Object.entries(SAYS).flatMap(([intent, variants]) =>
    variants.map((text, i) => ({ intent, i, text }))
  );

  it("has templates to check", () => {
    // Guards against the whole suite passing because SAYS was renamed and the
    // import quietly resolved to an empty object.
    expect(all.length).toBeGreaterThan(30);
  });

  it.each(all.filter((t) => t.text.trim()))(
    "$intent [$i] uses none of the punctuation A23 forbids",
    ({ text }) => {
      expect({ text, breaks: breaches(text) }).toEqual({ text, breaks: [] });
    }
  );
});

describe("the canned replies obey A23", () => {
  // The HELP reply never passes through the model at all, so nothing else
  // would catch a breach in it. It is also the one message we are obliged to
  // send verbatim, which makes a stray hyphen in it permanent.
  it("the HELP reply, with a callback number", () => {
    expect(breaches(helpReply("+19995550101"))).toEqual([]);
  });

  it("the HELP reply, with no number to offer", () => {
    expect(breaches(helpReply(null))).toEqual([]);
  });

  it("the formatted phone number is not read as a compound", () => {
    // "(516) 344-8418" has a hyphen and brackets. Both are digits-only cases
    // and neither is what A23 is about, but a careless rule would fire on the
    // one message we cannot change.
    const r = helpReply("+15163448418");
    expect(r).toContain("344-8418");
    expect(breaches(r).filter((b) => b === "hyphenated compound")).toEqual([]);
  });
});

/**
 * The after-hours message is written by the office in the workspace settings,
 * not by us, so it cannot be asserted here. What CAN be asserted is that when
 * one is sent, it went through the same door everything else does.
 */
describe("the after-hours reply is operator-authored", () => {
  it("refuses to send one nobody has written", () => {
    const d = afterHoursReply({
      workspace: { after_hours_autoreply: true, after_hours_message: "  ", time_zone: "America/New_York" } as never,
      now: new Date("2026-09-22T04:00:00Z"),
      alreadySentToday: 0,
      keyword: null,
    });
    expect(d.send).toBe(false);
  });
});

/**
 * PROVE THE CHECK CAN FAIL.
 *
 * Every assertion above passes on an empty string, so a broken import or a
 * renamed export would make this file green while checking nothing. These are
 * the exact strings that were live in render.ts before this was written.
 */
describe("the check catches what was actually there", () => {
  it.each([
    ["Can I grab your name and email for the write-up?", "hyphenated compound"],
    ["we can put together an off-site quote from photos", "hyphenated compound"],
    ["Just a friendly check-in to see whether you had any questions", "hyphenated compound"],
    ["the estimator owns the number — the office owns the calendar", "em dash"],
    ["Offer one when an in-person visit does not suit.", "hyphenated compound"],
    ["We can do that; let me check the calendar.", "semicolon"],
    ["We can do that (probably) next week.", "parenthetical prose"],
    ["Let me check...", "ellipsis"],
  ])("flags %j", (text, why) => {
    expect(breaches(text)).toContain(why);
  });

  it("does not flag a phone number, a date range or a price", () => {
    expect(breaches("Call 516-344-8418 between 9-5, the quote is $1,200.")).toEqual([]);
  });
});

/**
 * The model's own prose is checked by checkRapport, and A23's last two items
 * were missing from it: a rule enforced at three fifths reads, from the side
 * being graded, as a rule the bot ignores.
 */
describe("checkRapport enforces all five of A23", () => {
  it.each([
    ["Happy to help with the follow-up.", "hyphenated compound"],
    ["Happy to help; we do that often.", "semicolon"],
    ["Happy to help — we do that often.", "em dash"],
    ["Happy to help (we do that often).", "parentheses"],
    ["Happy to help...", "ellipsis"],
  ])("rejects %j", (text) => {
    expect(checkRapport(text).ok).toBe(false);
  });

  it("still accepts ordinary rapport", () => {
    expect(checkRapport("Happy to help with that.").ok).toBe(true);
    expect(checkRapport("That sounds like a straightforward job.").ok).toBe(true);
  });
});
