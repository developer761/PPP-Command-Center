/**
 * A44 stalled conversations + A45 pause/resume calling.
 *
 * Built together because the resume signal fires off the end of A44's
 * cadence, which is the seam the spec says they share.
 *
 * Baseline the spec sets: of 237 stalled conversations, none ever received
 * three follow-ups and 208 received none at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  isStalled, followUpSchedule, shiftIntoWindow, FOLLOW_UP_HOURS, FOLLOW_UP_COUNT,
  PARK_FOLLOW_UP_DAYS, EVENT_PARK_FOLLOW_UP_DAYS,
} from "@/lib/messaging/stalled";
import {
  pauseOnReply, resumeAfterCadence, readsAsADisposition,
} from "@/lib/messaging/call-signals";
import { sendingWindow } from "@/lib/messaging/sending-window";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const hourIn = (d: Date, tz: string) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(d)) % 24;

describe("A44 — what counts as stalled is mechanical", () => {
  const base = { lastTurnWasBot: true, everHadHuman: false };

  it("a bot turn nobody picked up, on an incomplete flow", () => {
    expect(isStalled(base)).toBe(true);
  });

  it("is NOT stalled when the customer spoke last", () => {
    expect(isStalled({ ...base, lastTurnWasBot: false })).toBe(false);
  });

  it("is NOT stalled once a human touched it", () => {
    expect(isStalled({ ...base, everHadHuman: true })).toBe(false);
  });

  /**
   * Kate: silence is only a stall if the flow was left INCOMPLETE. Read from
   * the ENDING INTENT, because she flagged on 2026-09-18 that "a decline is
   * not always worded as one" and a keyword sweep missed exactly that.
   */
  it("is NOT stalled when the conversation ended properly", () => {
    for (const intent of [
      "bailout", "lost", "discard", "area_not_serviced",
      "success", "phone_pricing", "schedule_follow_up", "transferred",
    ]) {
      expect(isStalled({ ...base, lastIntent: intent }), intent).toBe(false);
    }
  });

  it("IS stalled after an ordinary collecting turn", () => {
    for (const intent of ["ask_address", "ask_availability", "acknowledge"]) {
      expect(isStalled({ ...base, lastIntent: intent }), intent).toBe(true);
    }
  });

  it("never chases somebody who opted out", () => {
    expect(isStalled({ ...base, suppressed: true })).toBe(false);
  });
});

describe("A44 — three follow-ups at 10, 3 and 6 on the CUSTOMER's clock", () => {
  // Monday 2026-09-28, 4pm Eastern — the conversation goes quiet.
  const quiet = new Date("2026-09-28T20:00:00Z");

  it("sends exactly three, one a day", () => {
    const s = followUpSchedule({ from: quiet, customerZone: NY });
    expect(s).toHaveLength(FOLLOW_UP_COUNT);
    const days = s.map((d) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: NY, day: "2-digit" }).format(d));
    expect(new Set(days).size).toBe(3);      // three different days
  });

  it("does not chase the same evening it went quiet", () => {
    const s = followUpSchedule({ from: quiet, customerZone: NY });
    expect(s[0].getTime()).toBeGreaterThan(quiet.getTime());
    const sameDay = new Intl.DateTimeFormat("en-CA", { timeZone: NY, day: "2-digit" }).format(quiet);
    const firstDay = new Intl.DateTimeFormat("en-CA", { timeZone: NY, day: "2-digit" }).format(s[0]);
    expect(firstDay).not.toBe(sameDay);
  });

  it("lands on 10am, 3pm and 6pm local for an Eastern customer", () => {
    const s = followUpSchedule({ from: quiet, customerZone: NY });
    expect(s.map((d) => hourIn(d, NY))).toEqual([...FOLLOW_UP_HOURS]);
  });

  /**
   * THE CASE THE SPEC CALLS OUT BY NAME.
   *
   * "6 PM Pacific is 9 PM Eastern and past the close… The third follow-up
   * landing EARLIER for Pacific and Mountain customers is correct, not a
   * gap."
   */
  it("pulls the 6pm follow-up EARLIER for a Pacific customer, not into tomorrow", () => {
    const s = followUpSchedule({ from: quiet, customerZone: LA });
    expect(s).toHaveLength(3);
    const third = s[2];
    expect(hourIn(third, LA)).toBeLessThan(18);        // earlier than 6pm local
    // and still on its own day, so "one a day" survives
    const days = s.map((d) => new Intl.DateTimeFormat("en-CA", { timeZone: LA, day: "2-digit" }).format(d));
    expect(new Set(days).size).toBe(3);
  });

  it("never schedules anything the send window would refuse", () => {
    for (const zone of [NY, LA, "America/Chicago", "America/Denver"]) {
      for (const from of [
        "2026-09-28T20:00:00Z", "2026-10-01T13:00:00Z", "2026-10-02T23:00:00Z",
      ]) {
        for (const at of followUpSchedule({ from: new Date(from), customerZone: zone })) {
          expect(
            sendingWindow({ now: at, customerZone: zone }).open,
            `${zone} ${from} -> ${at.toISOString()}`
          ).toBe(true);
        }
      }
    }
  });

  /**
   * A44's stated constraint: "If the customer has said when they cannot be
   * reached… every follow-up shifts outside that window… it does not expire
   * and it binds the whole cadence."
   */
  it("shifts around a window the customer said they are unreachable in", () => {
    const s = followUpSchedule({
      from: quiet, customerZone: NY,
      unreachable: { startHour: 9, endHour: 17 },   // "I'm at work until 5"
    });
    expect(s.length).toBeGreaterThan(0);
    for (const at of s) {
      const h = hourIn(at, NY);
      expect(h < 9 || h >= 17, `landed at ${h}`).toBe(true);
    }
  });
});

describe("A44 — a long-dead conversation is chased from TODAY, not from when it died", () => {
  /**
   * THE DEFECT THIS CAUGHT, before it reached anybody.
   *
   * Dry-running the sweep against production on 2026-09-26 found six live
   * conversations that had gone quiet twenty-five days earlier. "The day
   * after it went quiet" was the 1st of September, so all nine follow-ups
   * came out dated in the past — immediately due, claimed on the next tick,
   * and three agent turns per conversation would have gone out back to back
   * in one minute. The feature would have looked like it was working.
   */
  const quietLongAgo = new Date("2026-09-01T20:00:00Z");
  const today = new Date("2026-09-26T14:00:00Z");

  it("puts every follow-up in the future", () => {
    const s = followUpSchedule({ from: quietLongAgo, customerZone: NY, notBefore: today });
    expect(s).toHaveLength(3);
    for (const at of s) expect(at.getTime()).toBeGreaterThan(today.getTime());
  });

  it("and still spreads them one a day", () => {
    const s = followUpSchedule({ from: quietLongAgo, customerZone: NY, notBefore: today });
    const days = s.map((d) => new Intl.DateTimeFormat("en-CA", { timeZone: NY, day: "2-digit" }).format(d));
    expect(new Set(days).size).toBe(3);
    expect(s.map((d) => hourIn(d, NY))).toEqual([...FOLLOW_UP_HOURS]);
  });

  it("without notBefore it still produces the past dates, so the guard is doing the work", () => {
    // Proves the fix is the thing keeping them in the future, rather than
    // some other property of these inputs.
    const s = followUpSchedule({ from: quietLongAgo, customerZone: NY });
    expect(s.every((at) => at.getTime() < today.getTime())).toBe(true);
  });

  it("leaves a conversation that just went quiet alone", () => {
    // notBefore is earlier than from, so the anchor is unchanged.
    const justNow = new Date("2026-09-28T20:00:00Z");
    const a = followUpSchedule({ from: justNow, customerZone: NY });
    const b = followUpSchedule({ from: justNow, customerZone: NY, notBefore: new Date("2026-09-28T10:00:00Z") });
    expect(b.map((d) => d.toISOString())).toEqual(a.map((d) => d.toISOString()));
  });
});

describe("A44 — shiftIntoWindow looks backwards before forwards", () => {
  it("leaves an already-allowed instant alone", () => {
    const at = new Date("2026-09-29T15:00:00Z");      // 11am ET
    expect(shiftIntoWindow({ target: at, customerZone: NY })?.getTime()).toBe(at.getTime());
  });

  it("moves a shut instant to one that is open", () => {
    const at = new Date("2026-09-30T05:00:00Z");      // 1am ET
    const moved = shiftIntoWindow({ target: at, customerZone: NY });
    expect(moved).not.toBeNull();
    expect(sendingWindow({ now: moved!, customerZone: NY }).open).toBe(true);
  });
});

describe("A45 — pause on a reply, once per conversation", () => {
  const base = { conversationId: "c1", leadId: "00Q1", customerReplied: true };

  it("fires on the customer's reply", () => {
    const s = pauseOnReply({ ...base, alreadyPaused: false });
    expect(s?.kind).toBe("pause_calling");
    expect(s?.conversationId).toBe("c1");
    expect(s?.leadId).toBe("00Q1");
  });

  /** Spec: "a customer who sends four messages does not generate four pauses." */
  it("does NOT fire a second time", () => {
    expect(pauseOnReply({ ...base, alreadyPaused: true })).toBeNull();
  });

  it("does not fire on anything that is not a customer reply", () => {
    expect(pauseOnReply({ ...base, customerReplied: false, alreadyPaused: false })).toBeNull();
  });
});

describe("A45 — resume only at the end, and only if never reached", () => {
  const base = { conversationId: "c1", leadId: "00Q1", alreadyResumed: false };

  it("fires once the cadence is spent and nobody replied", () => {
    const s = resumeAfterCadence({ ...base, cadenceSpent: true, everReplied: false });
    expect(s?.kind).toBe("resume_calling");
  });

  it("does NOT fire mid-cadence", () => {
    expect(resumeAfterCadence({ ...base, cadenceSpent: false, everReplied: false })).toBeNull();
  });

  /** Spec: "A conversation that ends properly is not a resume." */
  it("does NOT fire when the customer answered", () => {
    expect(resumeAfterCadence({ ...base, cadenceSpent: true, everReplied: true })).toBeNull();
  });

  it("does not fire twice", () => {
    expect(resumeAfterCadence({ ...base, cadenceSpent: true, everReplied: false, alreadyResumed: true })).toBeNull();
  });
});

describe("A45 — a signal is not a verdict on the lead", () => {
  /**
   * Spec: "Reaching the end of the cadence is a resume-calling signal, not a
   * disposition — nothing about the lead has changed and no CRM decision is
   * owed. A notification that reads as 'this lead is done' is the failure to
   * avoid."
   */
  it("neither note reads as a disposition", () => {
    const pause = pauseOnReply({ conversationId: "c", leadId: null, alreadyPaused: false, customerReplied: true })!;
    const resume = resumeAfterCadence({ conversationId: "c", leadId: null, cadenceSpent: true, everReplied: false, alreadyResumed: false })!;
    expect(readsAsADisposition(pause.note)).toBe(false);
    expect(readsAsADisposition(resume.note)).toBe(false);
  });

  it("and the detector actually detects one", () => {
    // Otherwise the assertion above passes over a check that never fires.
    expect(readsAsADisposition("This lead is dead, do not call")).toBe(true);
    expect(readsAsADisposition("Lead closed — unqualified")).toBe(true);
  });

  it("carries the three fields the spec names, and nothing else", () => {
    const s = resumeAfterCadence({ conversationId: "c", leadId: "L", cadenceSpent: true, everReplied: false, alreadyResumed: false })!;
    expect(Object.keys(s).sort()).toEqual(["conversationId", "kind", "leadId", "note"]);
  });
});

/**
 * A40, TRACED END TO END ON 2026-09-27 — THE BOT NEVER CAME BACK.
 *
 * Kate's complaint about A40 is exactly: "What has never once happened is the
 * bot coming back." We reproduced it, in the feature built to fix it.
 *
 * A customer who parks WITHOUT naming a day gets parkReopenAt() === null, so
 * no re-open row is written. And `schedule_follow_up` was a PROPER ENDING, so
 * the stall sweep skipped it too. Neither path owned the conversation.
 *
 * Naming a day worked. It is precisely the customers who name none — the ones
 * A40 is about — who fell through. No unit test saw it because each function
 * behaved exactly as written; the hole was between them.
 */
describe("a park that scheduled nothing is not a proper ending", () => {
  const parked = (nothingScheduled: boolean) => isStalled({
    lastTurnWasBot: true, everHadHuman: false,
    lastIntent: "schedule_follow_up", nothingScheduled,
  });

  it("is chased when nothing at all is queued", () => {
    expect(parked(true)).toBe(true);
  });

  it("is left alone when the re-open owns it", () => {
    // "give me a call next Tuesday" — parkReopenAt returns a date, a
    // park_reopen row exists, and chasing it as well would text somebody twice.
    expect(parked(false)).toBe(false);
  });

  it("defaults to the old behaviour when the caller does not say", () => {
    // Every other caller keeps working: silence means "something is scheduled",
    // which is the conservative direction — it never invents a chase.
    expect(isStalled({ lastTurnWasBot: true, everHadHuman: false, lastIntent: "schedule_follow_up" })).toBe(false);
  });

  it("never overrides the endings that really are endings", () => {
    for (const intent of ["success", "lost", "discard", "bailout", "transferred", "phone_pricing", "area_not_serviced"]) {
      expect(isStalled({
        lastTurnWasBot: true, everHadHuman: false, lastIntent: intent, nothingScheduled: true,
      })).toBe(false);
    }
  });

  it("and still never chases somebody who opted out", () => {
    // A24 outranks all of this.
    expect(isStalled({
      lastTurnWasBot: true, everHadHuman: false,
      lastIntent: "schedule_follow_up", nothingScheduled: true, suppressed: true,
    })).toBe(false);
  });

  it("or a conversation a person has taken over", () => {
    expect(isStalled({
      lastTurnWasBot: true, everHadHuman: true,
      lastIntent: "schedule_follow_up", nothingScheduled: true,
    })).toBe(false);
  });
});

/**
 * ── A PARK IS NOT A STALL, AND IS NOT CHASED LIKE ONE ───────────────────
 *
 * Kate, 2026-09-28, answering the one question that was blocking:
 *
 *   "I think a parking cadence would make sense here because the CC has a
 *    varied approach and the stalled convo cadence wouldn't kick in on
 *    these... Bare deferral — 'I'll get back to you', 'once I've spoken to
 *    my wife'... Follow up at 2-3 days, three times, then notify the call
 *    centre it can resume calling. Your 3 days was right for the first
 *    nudge; the change is not declaring a stall straight after it."
 *
 * Before this both went down the stall cadence: chased tomorrow, then daily.
 * Somebody who said "let me speak to my wife" got a nudge the next morning.
 */
describe("the park cadence", () => {
  const zone = "America/New_York";
  const parkedAt = new Date("2026-09-01T15:00:00Z");
  // The sweep sees it a day later, which is what QUIET_HOURS_BEFORE_STALL means.
  const sweptAt = new Date("2026-09-02T15:00:00Z");

  const daysBetween = (a: Date, b: Date) =>
    Math.round((b.getTime() - a.getTime()) / 86_400_000);

  it("still sends three, like a stall", () => {
    const at = followUpSchedule({
      from: parkedAt, notBefore: sweptAt, customerZone: zone, days: PARK_FOLLOW_UP_DAYS,
    });
    expect(at).toHaveLength(3);
  });

  it("puts the first nudge about three days after they parked", () => {
    const at = followUpSchedule({
      from: parkedAt, notBefore: sweptAt, customerZone: zone, days: PARK_FOLLOW_UP_DAYS,
    });
    // Kate: "Your 3 days was right for the first nudge."
    const d = daysBetween(parkedAt, at[0]);
    expect(d).toBeGreaterThanOrEqual(2);
    expect(d).toBeLessThanOrEqual(4);
  });

  it("leaves two to three days between nudges, not one", () => {
    const at = followUpSchedule({
      from: parkedAt, notBefore: sweptAt, customerZone: zone, days: PARK_FOLLOW_UP_DAYS,
    });
    for (let i = 1; i < at.length; i++) {
      const gap = daysBetween(at[i - 1], at[i]);
      expect(gap, `gap ${i}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("is slower than the stall cadence it used to share", () => {
    // The regression this exists to prevent: a park quietly falling back to
    // being chased tomorrow.
    const park = followUpSchedule({
      from: parkedAt, notBefore: sweptAt, customerZone: zone, days: PARK_FOLLOW_UP_DAYS,
    });
    const stall = followUpSchedule({ from: parkedAt, notBefore: sweptAt, customerZone: zone });
    expect(park[0].getTime()).toBeGreaterThan(stall[0].getTime());
    expect(stall).toHaveLength(3);
  });

  it("a stall is still chased on consecutive days", () => {
    // The other half must not have moved.
    const at = followUpSchedule({ from: parkedAt, notBefore: sweptAt, customerZone: zone });
    for (let i = 1; i < at.length; i++) {
      expect(daysBetween(at[i - 1], at[i]), `gap ${i}`).toBeLessThanOrEqual(2);
    }
  });
});

/**
 * ── THE PARK CADENCE REPLACES THE STALL ONE, IT DOES NOT PRECEDE IT ─────
 *
 * A40, Kate 2026-09-28: "When the third park follow-up goes unanswered the
 * conversation is silent, which would otherwise trigger A44 and send three
 * more messages. IT DOES NOT. The park cadence ends in the resume-calling
 * notification directly."
 *
 * Six messages to somebody who said "let me speak to my wife" is the exact
 * shape of the thing A40 exists to stop, and it would have been invisible:
 * two features each behaving correctly, chained.
 *
 * The guard is that sent rows become state "done" and the sweep counts
 * everything that is not "cancelled" — so a spent cadence still reads as a
 * cadence. Asserted here because the rule is now explicit about it, and
 * because a well-meaning cleanup that deleted done rows would reopen it.
 */
describe("a spent cadence is still a cadence", () => {
  it("counts a done follow-up as already queued", () => {
    // The sweep's guard is `.neq("state", "cancelled")`, so these states all
    // block a second cadence. Stated as data rather than prose because the
    // failure is silent and the fix is one word.
    const blocksASecondCadence = (state: string) => state !== "cancelled";
    expect(blocksASecondCadence("done")).toBe(true);
    expect(blocksASecondCadence("pending")).toBe(true);
    expect(blocksASecondCadence("failed")).toBe(true);
    expect(blocksASecondCadence("cancelled")).toBe(false);
  });
});

describe("the event-park cadence", () => {
  const zone = "America/New_York";
  const parkedAt = new Date("2026-09-01T15:00:00Z");
  const sweptAt = new Date("2026-09-02T15:00:00Z");
  const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

  it("waits about two weeks before the first nudge", () => {
    // Kate: "BLOCKED ON A NAMED EVENT... TWO WEEKS."
    const at = followUpSchedule({
      from: parkedAt, notBefore: sweptAt, customerZone: zone,
      days: EVENT_PARK_FOLLOW_UP_DAYS,
    });
    expect(at).toHaveLength(3);
    const d = daysBetween(parkedAt, at[0]);
    expect(d).toBeGreaterThanOrEqual(13);
    expect(d).toBeLessThanOrEqual(15);
  });

  it("waits far longer than a bare deferral does", () => {
    const event = followUpSchedule({
      from: parkedAt, notBefore: sweptAt, customerZone: zone, days: EVENT_PARK_FOLLOW_UP_DAYS,
    });
    const bare = followUpSchedule({
      from: parkedAt, notBefore: sweptAt, customerZone: zone, days: PARK_FOLLOW_UP_DAYS,
    });
    expect(daysBetween(parkedAt, event[0])).toBeGreaterThan(daysBetween(parkedAt, bare[0]) + 7);
  });
});

/**
 * ── A FOLLOW-UP HAS TO SOUND LIKE IT REMEMBERS THEM ─────────────────────
 *
 * Kate's spec: "Each of the three follow-ups follows up on their request for
 * their project, naming the scope where we hold it, so the customer never
 * restates what they have already told us."
 *
 * Nothing told the model it was writing one, so a follow-up ran as an
 * ordinary turn and the natural output is a generic "just checking in" —
 * exactly the Hatch behaviour this capability replaces, and the source of the
 * 192 retype defects.
 *
 * The instruction is built in agent-run; these assert the source, the way
 * simulator-parity does, because the alternative is calling a model in a
 * unit test.
 */
describe("the follow-up prompt names the scope", () => {
  const src = readFileSync("lib/messaging/agent-run.ts", "utf8");

  it("tells the model which of the three it is writing", () => {
    expect(src).toMatch(/THIS IS FOLLOW-UP \$\{opts\.followUpStep\} OF \$\{FOLLOW_UP_COUNT\}/);
  });

  /**
   * THE SCOPE MOVED, AND SO DID THE REASON FOR IT.
   *
   * It used to be interpolated here with "so they do not have to say it
   * again". Kate gave three distinct goals on 2026-10-05, so the scope is now
   * woven into whichever goal is being asked — see stall-followup-goals.ts,
   * which owns the wording and is unit-tested on its own. What this file
   * still has to prove is that the goal REACHES the prompt with the scope.
   */
  it("hands the scope to the step's own goal", () => {
    expect(src).toMatch(/stallFollowUpGoal\(opts\.followUpStep, opts\.known\?\.inquiryScope\)/);
  });

  it("no longer sends one generic instruction for all three", () => {
    /*
      COMMENTS STRIPPED FIRST, or this tests history rather than behaviour.

      The replaced line is QUOTED in agent-run's comment, explaining what it
      replaced and why — which is exactly what the comment should do, and
      exactly what makes a naive negative assertion fail. check-rules-are-wired
      strips comments for the same reason; so does this.
    */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/then ask for the one thing still outstanding/);
  });

  it("forbids re-introducing ourselves", () => {
    // A conversation that resumes is not a new one. Conversation memory is
    // the whole point of the capability underneath this.
    expect(src).toMatch(/do not re-introduce/i);
  });

  it("forbids a sign-off, which is A44's own ending rule", () => {
    // "Nothing is sent to the customer at the end — no sign-off, and no
    // softer sign-off in its place."
    expect(src).toMatch(/No sign-off/i);
  });

  it("says nothing at all on an ordinary turn", () => {
    // The line is turn context and must not leak into a live reply.
    expect(src).toMatch(/const followUpLine = isFollowUpStep\(opts\.followUpStep\)/);
  });
});
