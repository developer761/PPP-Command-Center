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
import {
  isStalled, followUpSchedule, shiftIntoWindow, FOLLOW_UP_HOURS, FOLLOW_UP_COUNT,
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
