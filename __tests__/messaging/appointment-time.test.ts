/**
 * Hatch parity gaps 2-4: what to say when the customer names a time.
 *
 * The negatives matter most. A number in a text message is usually not a
 * time — it is a house number, a room count, a square footage — and reading
 * one as a time puts a wrong appointment in front of a person.
 */
import { describe, it, expect } from "vitest";
import { renderMessage } from "@/lib/messaging/render";
import { tooManyAsks } from "@/lib/messaging/one-ask";
import {
  resolveBareHour, requestedTime, slotVerdict, replyToRequestedTime,
  FIRST_SLOT_HOUR, LAST_SLOT_HOUR,
} from "@/lib/messaging/appointment-time";

describe("a bare hour, per Hatch's rule", () => {
  // "Assume times between 8 and 11 are AM and 12 to 7 are PM."
  it("8 through 11 are morning", () => {
    expect(resolveBareHour(8)).toBe(8);
    expect(resolveBareHour(11)).toBe(11);
  });

  it("12 is noon and 1 through 7 are afternoon", () => {
    expect(resolveBareHour(12)).toBe(12);
    expect(resolveBareHour(1)).toBe(13);
    expect(resolveBareHour(3)).toBe(15);
    expect(resolveBareHour(7)).toBe(19);
  });

  it("refuses anything that is not a clock hour", () => {
    for (const h of [0, 13, 25, -1, 1.5, NaN]) expect(resolveBareHour(h)).toBeNull();
  });
});

describe("reading a time out of a message", () => {
  const cases: Array<[string, { hour: number; minute: number; explicit: boolean } | null]> = [
    ["can you do 2pm", { hour: 14, minute: 0, explicit: true }],
    ["2:30 pm works", { hour: 14, minute: 30, explicit: true }],
    ["how about 9am", { hour: 9, minute: 0, explicit: true }],
    ["12pm please", { hour: 12, minute: 0, explicit: true }],
    ["12am is fine", { hour: 0, minute: 0, explicit: true }],
    ["at 10:15", { hour: 10, minute: 15, explicit: false }],
    // THE ONE THE RULE EXISTS FOR — a bare 3 means the afternoon.
    ["at 3", { hour: 15, minute: 0, explicit: false }],
    ["around 9", { hour: 9, minute: 0, explicit: false }],
    // Qualified by words rather than by am/pm.
    ["at 8 in the morning", { hour: 8, minute: 0, explicit: true }],
    ["at 4 in the afternoon", { hour: 16, minute: 0, explicit: true }],
  ];
  for (const [text, want] of cases) {
    it(`${JSON.stringify(text)}`, () => {
      expect(requestedTime(text)).toEqual(want);
    });
  }
});

describe("numbers that are NOT times", () => {
  /**
   * Each of these is a real thing a customer says. Reading one as a time puts
   * a wrong appointment in front of a person, which is worse than missing a
   * real one — the customer will say it again.
   */
  for (const t of [
    "4821 Oak Lane",
    "I have 3 rooms to paint",
    "about 2 bedrooms and a bath",
    "roughly 1500 sq ft",
    "my zip is 11722",
    "2 cars in the driveway",
    "I need 4 windows done",
    "whenever suits you",
    "",
  ]) {
    it(`${JSON.stringify(t)} names no time`, () => {
      expect(requestedTime(t)).toBeNull();
    });
  }

  it("a bare number with no preposition is not a time", () => {
    // "3 works" could be three rooms. A time needs at/around/by, a colon,
    // or an am/pm.
    expect(requestedTime("3 works for me")).toBeNull();
  });
});

describe("which side of the appointment day it falls on", () => {
  it("inside is inside", () => {
    expect(slotVerdict({ hour: 10, minute: 0, explicit: true })).toBe("in_hours");
    expect(slotVerdict({ hour: 14, minute: 30, explicit: true })).toBe("in_hours");
    expect(slotVerdict({ hour: LAST_SLOT_HOUR, minute: 0, explicit: true })).toBe("in_hours");
  });

  it("before the first slot", () => {
    expect(slotVerdict({ hour: 8, minute: 0, explicit: true })).toBe("too_early");
    expect(slotVerdict({ hour: FIRST_SLOT_HOUR - 1, minute: 59, explicit: true })).toBe("too_early");
  });

  it("after the last slot, including five past five", () => {
    expect(slotVerdict({ hour: LAST_SLOT_HOUR, minute: 5, explicit: true })).toBe("too_late");
    expect(slotVerdict({ hour: 19, minute: 0, explicit: true })).toBe("too_late");
  });
});

describe("what the bot says back", () => {
  /**
   * THE POINT OF ALL THREE GAPS. Hatch says it twice — "Do not restate or
   * confirm their time", "Don't thank them" — because a reply that repeats
   * the time reads as agreement, and A15 forbids agreeing to a slot nobody
   * checked.
   */
  it("holds an in-hours time without confirming it", () => {
    const r = replyToRequestedTime("can you do Tuesday at 2?")!;
    expect(r.verdict).toBe("in_hours");
    expect(r.reply).toBe("I'll check the calendar for that time.");
  });

  it("never restates the time, on any branch", () => {
    for (const t of ["can you do 2pm", "how about 7am", "how about 8pm", "at 3"]) {
      const r = replyToRequestedTime(t);
      expect(r, t).not.toBeNull();
      // No digits at all in the in-hours line; the out-of-hours lines name
      // OUR slot, never theirs.
      expect(r!.reply, t).not.toMatch(/\b(?:2|7|8|3)\s*(?:pm|am|o'clock)\b/i);
      expect(r!.reply, t).not.toMatch(/tuesday/i);
    }
  });

  it("redirects a too-early time without refusing it", () => {
    const r = replyToRequestedTime("can someone come at 7am?")!;
    expect(r.verdict).toBe("too_early");
    expect(r.reply).toContain("10 AM");
    expect(r.reply).toMatch(/Saturday/);
    // Leaves a door open rather than saying no.
    expect(r.reply).toMatch(/\?$/);
  });

  it("redirects a too-late time", () => {
    const r = replyToRequestedTime("8pm is the only time I can do")!;
    expect(r.verdict).toBe("too_late");
    expect(r.reply).toContain("5 PM");
  });

  it("says nothing when no time was named", () => {
    expect(replyToRequestedTime("I need my kitchen painted")).toBeNull();
    expect(replyToRequestedTime("4821 Oak Lane")).toBeNull();
  });

  it("offers no specific slot of its own — that would be A15", () => {
    /**
     * The first version of this test asserted the reply contains no weekday
     * at all, and failed on "or a Saturday" — which is Hatch's own approved
     * wording and is NOT an offer. "I can ask about a Saturday" names a
     * category of day we would check; "Saturday at 2 works" invents an
     * appointment. Only the second is A15, so this asserts the thing A15
     * actually forbids rather than the thing that was easy to match.
     */
    for (const t of ["7am?", "9pm?"]) {
      const r = replyToRequestedTime(t)!;
      // No day paired with a time, which is what an offered slot looks like.
      expect(r.reply, t).not.toMatch(/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b[^.?!]{0,12}\b\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)?\b/i);
      expect(r.reply, t).not.toMatch(/\btomorrow\b|\bnext week\b/i);
      // And no offering language. We ask; we never propose.
      expect(r.reply, t).not.toMatch(/\bhow about\b|\bwe have (?:an? )?opening|\bI have\b|\bdoes .* work\b/i);
    }
  });

  it("and the A15 detector above actually detects an offer", () => {
    // Otherwise the assertions pass over a check that never fires.
    const offered = "Saturday at 2 works, I have an opening then.";
    expect(offered).toMatch(/\b(?:satur)day\b[^.?!]{0,12}\b\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)?\b/i);
    expect(offered).toMatch(/\bI have\b/i);
  });
});

/**
 * THE NAMED TIME IS ACKNOWLEDGED, THEN THE FLOW CARRIES ON.
 *
 * Played in the simulator on 2026-09-27:
 *
 *   customer  "I need the kitchen and two bedrooms painted. Can you come
 *              Tuesday at 2?"
 *   BOT       "What's the address for the project?"
 *
 * A15 was satisfied — nothing was confirmed, which is the expensive half — but
 * the customer asked a direct question and got nothing back. replyToRequested-
 * Time existed for exactly this and only fired when the model happened to pick
 * an availability intent; its own comment says "the flow carries on after".
 */
describe("a time named on a collecting turn is not ignored", () => {
  const asked = "I need the kitchen and two bedrooms painted. Can you come Tuesday at 2?";

  it("leads with the calendar line, then asks the flow's question", () => {
    const out = renderMessage({ intent: "ask_address", turn: 1, customerText: asked });
    expect(out).toMatch(/check the calendar/i);
    expect(out).toMatch(/address|property/i);
  });

  it("never promises the time", () => {
    const out = renderMessage({ intent: "ask_address", turn: 1, customerText: asked });
    // A15: no day, no hour, nothing that reads as a booking.
    expect(out).not.toMatch(/\btuesday\b/i);
    expect(out).not.toMatch(/\b\d{1,2}\s*(?:am|pm)\b/i);
    expect(out).not.toMatch(/\bbooked\b|\bconfirmed\b|\bsee you\b/i);
  });

  it("still asks for only one thing", () => {
    for (const intent of ["ask_address", "ask_contact"] as const) {
      const out = renderMessage({ intent, turn: 1, customerText: asked });
      expect(tooManyAsks(out), out).toBeNull();
      expect((out.match(/\?/g) ?? []).length).toBe(1);
    }
  });

  /**
   * A22 OUTRANKS THE COURTESY. Checked by running tooManyAsks over the RESULT
   * rather than by reasoning about which intents are safe — and that is what
   * caught a false positive in tooManyAsks itself, which counted "calendar"
   * and "project" out of a sentence describing our own next step and called a
   * single question three asks.
   *
   * The invariant is the point, not any one intent: adding the line must never
   * take a message over the limit, on any turn, for any of them.
   */
  it("never takes a message over the one-ask limit", () => {
    const known = { address: "12 Oak St, 11530", scope: "the kitchen and two bedrooms", phone: "999-784-6046", email: "t@x.com" };
    for (const intent of [
      "ask_project_details", "ask_address", "ask_contact",
      "confirm_scope", "confirm_address", "confirm_contact",
    ] as const) {
      for (const turn of [0, 1, 2, 3]) {
        const out = renderMessage({ intent, turn, customerText: asked, known });
        if (!out) continue;
        expect(tooManyAsks(out), `${intent} turn ${turn}: ${out}`).toBeNull();
      }
    }
  });

  it("keeps the acknowledgement on a read-back, which is still one ask", () => {
    const out = renderMessage({
      intent: "confirm_address", turn: 1, customerText: asked,
      known: { address: "12 Oak St, 11530" },
    });
    expect(out).toMatch(/check the calendar/i);
    expect(tooManyAsks(out), out).toBeNull();
  });

  it("says nothing extra when no time was named", () => {
    const out = renderMessage({ intent: "ask_address", turn: 1, customerText: "paint my kitchen" });
    expect(out).not.toMatch(/calendar/i);
  });

  /**
   * too_early and too_late carry their OWN question, so prefixing one to an
   * ask would put two questions in a message. They get their full answer when
   * the flow reaches the availability turn.
   */
  it("leaves the out-of-hours variants to the availability turn", () => {
    const early = renderMessage({ intent: "ask_address", turn: 1, customerText: "can you come at 7am?" });
    expect(early).not.toMatch(/earliest/i);
    expect(renderMessage({ intent: "ask_availability", turn: 1, customerText: "can you come at 7am?" }))
      .toMatch(/earliest/i);
  });

  it("the availability turn still answers in full, unprefixed", () => {
    expect(renderMessage({ intent: "ask_availability", turn: 1, customerText: asked }))
      .toBe("I'll check the calendar for that time.");
  });
});

/**
 * "AT" IS ALSO HOW PEOPLE WRITE AN ADDRESS.
 *
 * Found in the sandbox 2026-10-01. The customer's opening message was
 * "looking to get the living room and hallway painted at 12 Marchmont Ave,
 * Garden City NY 11530" — no time anywhere in it — and the bot replied
 * "I'll check the calendar for that time."
 *
 * The three prepositions that make a bare number a time are the same three
 * that introduce an address, so every low house number was an appointment.
 * The worst of them is "come by 7 Oak Road": 7pm is past the last slot, so
 * somebody who gave us their address was told our latest visit is usually
 * 5 PM and asked what else worked.
 *
 * This file's own header already said "a number in a text message is usually
 * not a time — it is a house number". It was never tested with a preposition
 * in front of it, which is the only shape that reaches this branch.
 */
describe("a house number after at/around/by is not a time", () => {
  it.each([
    "looking to get the living room and hallway painted at 12 Marchmont Ave, Garden City NY 11530",
    "we're at 9 Lakeview Dr Massapequa NY 11758",
    "the house is at 3 Elm St",
    "I'm at 10 Maple Lane, Garden City",
    "come by 7 Oak Road please",
    "property at 12 Marchmont Avenue",
    "it's at 5 Old Mill Road",
    "around 4 Birch Lane, the back of the house",
  ])("reads no time in %j", (text) => {
    expect(requestedTime(text)).toBeNull();
    expect(replyToRequestedTime(text)).toBeNull();
  });

  /** The half that must not regress: these are real times and still are. */
  it.each([
    ["can you call me at 2pm", 14],
    ["how about Tuesday at 2", 14],
    ["around 10 in the morning works", 10],
    ["by 11 would be great", 11],
    ["at 3 works for me", 15],
    ["at 12 works", 12],
  ])("still reads %j as %i", (text, hour) => {
    expect(requestedTime(text)?.hour).toBe(hour);
  });

  /**
   * BOTH IN ONE MESSAGE, which is why the branch scans instead of giving up
   * on the first address it meets.
   */
  it("finds a real time that follows an address", () => {
    expect(requestedTime("at 12 Marchmont Ave, can you come at 3?")?.hour).toBe(15);
  });

  it("does not turn an address into a too-late refusal", () => {
    expect(replyToRequestedTime("come by 7 Oak Road please")).toBeNull();
  });
});
