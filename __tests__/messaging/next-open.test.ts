import { describe, it, expect } from "vitest";
import { fillNextOpen, nextOpenPhrase, wantsNextOpen } from "@/lib/messaging/next-open";
import { afterHoursReply } from "@/lib/messaging/after-hours";

/**
 * "We'll get back to you after we open at ___."
 *
 * The thing under test is not the formatting. It is that the hour we PROMISE
 * is the hour the gate will actually act on — resolved through nextWindowOpen,
 * the same function that decides whether a send is allowed, rather than by a
 * second reading of the hours. A second reading is how a predicate and its
 * scheduler drift apart, and here the drift is a broken promise to a customer.
 */

/** 11:30 PM Eastern on Monday 2026-09-28 — out of hours everywhere. */
const MON_LATE = new Date("2026-09-29T03:30:00Z");
const ET = "America/New_York";
const PT = "America/Los_Angeles";

describe("spotting the merge field", () => {
  it.each([
    "We open at {{next_open}}.",
    "We open at {{ next_open }}.",
    "We open at {{next_open_time}}.",
    // Hatch's own token, because the migration story is pasting their message
    // in, and a token that survives into a text is the worst way to find out.
    "We open at [[[[Next Open Time]]]].",
    "we open at [[[[next open time]]]].",
  ])("finds it in %j", (body) => {
    expect(wantsNextOpen(body)).toBe(true);
  });

  it("is not fooled by ordinary text", () => {
    expect(wantsNextOpen("We open at 9 AM.")).toBe(false);
    expect(wantsNextOpen("{{customer_name}}, we are closed.")).toBe(false);
  });

  it("does not get stuck between calls", () => {
    // A /g regex carries lastIndex. Two calls on the same string must agree,
    // or the second message of the day silently misses the token.
    const body = "We open at {{next_open}}.";
    expect(wantsNextOpen(body)).toBe(true);
    expect(wantsNextOpen(body)).toBe(true);
  });
});

describe("how a person would say the time", () => {
  it("gives just the hour when it is later the same day", () => {
    const morning = new Date("2026-09-29T12:00:00Z"); // 8 AM ET
    const open = new Date("2026-09-29T13:00:00Z");    // 9 AM ET
    expect(nextOpenPhrase(open, morning, ET)).toBe("9 AM");
  });

  it("says tomorrow when it is tomorrow", () => {
    const open = new Date("2026-09-29T13:00:00Z"); // 9 AM ET Tuesday
    expect(nextOpenPhrase(open, MON_LATE, ET)).toBe("9 AM tomorrow");
  });

  it("names the day when it is further out", () => {
    const friLate = new Date("2026-10-03T03:30:00Z");
    const open = new Date("2026-10-05T13:00:00Z");
    expect(nextOpenPhrase(open, friLate, ET)).toMatch(/^\w+day at 9 AM$/);
  });

  it("keeps the minutes when there are any", () => {
    // The weekend close is 5:30 PM, so half hours are real in this system.
    const open = new Date("2026-09-29T13:30:00Z");
    expect(nextOpenPhrase(open, MON_LATE, ET)).toBe("9:30 AM tomorrow");
  });

  it("reads the day in the RIGHT zone, not the server's", () => {
    // 9 AM Tuesday Pacific is still Tuesday in LA and Tuesday in UTC, but the
    // boundary cases are what bite: this is 11 PM Monday Pacific.
    const open = new Date("2026-09-29T16:00:00Z"); // 9 AM PT Tuesday
    expect(nextOpenPhrase(open, MON_LATE, PT)).toBe("9 AM tomorrow");
  });
});

describe("filling it in", () => {
  it("leaves a message with no token completely alone", () => {
    const r = fillNextOpen({
      body: "Thanks! We are closed right now.", now: MON_LATE, customerZone: ET,
    });
    expect(r).toEqual({ ok: true, body: "Thanks! We are closed right now." });
  });

  it("puts a real time in, on the customer's clock", () => {
    const r = fillNextOpen({
      body: "We'll get back to you after we open at {{next_open}}.",
      now: MON_LATE, customerZone: ET,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toMatch(/after we open at 9 AM tomorrow\.$/);
    // The token must be GONE. A half-substituted message is worse than none.
    expect(r.body).not.toMatch(/\{\{|\]\]/);
  });

  it("answers a Pacific customer on Pacific time, not the office's", () => {
    /**
     * nextWindowOpen returns the next instant BOTH windows are open. At 11:30
     * PM Eastern a Californian is at 8:30 PM, and their own window reopens at
     * 9 AM Pacific — which is noon in the office. Telling them "noon" would
     * be the office's answer to a question they did not ask.
     */
    const r = fillNextOpen({
      body: "We open at {{next_open}}.", now: MON_LATE, customerZone: PT,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toBe("We open at 9 AM tomorrow.");
  });

  it("labels the hour with a zone name when the customer's zone is unknown", () => {
    // An unqualified hour in a zone the reader does not share is a wrong time
    // stated confidently.
    const r = fillNextOpen({
      body: "We open at {{next_open}}.", now: MON_LATE, customerZone: "",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Read off the date, so it is right on both sides of a DST change.
    expect(r.body).toMatch(/ E[SD]T\.$/);
  });

  it("replaces EVERY occurrence, not just the first", () => {
    const r = fillNextOpen({
      body: "Open at {{next_open}}. Again: {{next_open}}.",
      now: MON_LATE, customerZone: ET,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).not.toMatch(/\{\{/);
  });

  /**
   * THE REFUSAL. The three alternatives are all worse than silence: a text
   * containing "{{next_open}}", a sentence ending "we open at .", or an hour
   * nobody will honour.
   */
  it("refuses rather than sending an unresolved token", () => {
    const r = fillNextOpen({
      body: "We open at {{next_open}}.",
      now: MON_LATE,
      customerZone: ET,
      // A window that never opens — the misconfigured-workspace case.
      officeHours: { startHour: 9, endHour: 9 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.why).toMatch(/does not open inside a week/i);
  });

  it("does NOT refuse a message that never asked for a time", () => {
    // The refusal must be scoped to the feature. A broken window should not
    // silence an out-of-hours reply that says nothing about opening.
    const r = fillNextOpen({
      body: "Thanks, we are closed.",
      now: MON_LATE, customerZone: ET,
      officeHours: { startHour: 9, endHour: 9 },
    });
    expect(r.ok).toBe(true);
  });
});

describe("through afterHoursReply, which is what actually sends", () => {
  const ws = {
    after_hours_autoreply: true,
    after_hours_message: "Thanks! We're closed, but we'll reply after we open at {{next_open}}.",
    time_zone: ET,
    quiet_hours_start: 9,
    quiet_hours_end: 20,
  };
  /**
   * 8:30 PM Eastern, Monday. Out of the OFFICE window (which closes at 8) but
   * inside the federal 8am-9pm bound, which is the only gap where an
   * out-of-hours reply is sent at all. MON_LATE at 11:30 PM is correctly
   * silent, so it would have tested nothing here.
   */
  const EVENING = new Date("2026-09-29T00:30:00Z");
  const base = { now: EVENING, alreadySentToday: 0, keyword: null as null };

  it("sends the filled message", () => {
    const d = afterHoursReply({ ...base, workspace: ws, customerZone: ET });
    expect(d.send).toBe(true);
    if (!d.send) return;
    expect(d.body).toMatch(/after we open at 9 AM tomorrow\./);
    expect(d.body).not.toMatch(/\{\{/);
  });

  it("refuses the whole reply when the time cannot be resolved", () => {
    const d = afterHoursReply({
      ...base,
      workspace: { ...ws, quiet_hours_start: 9, quiet_hours_end: 9 },
      customerZone: ET,
    });
    expect(d.send).toBe(false);
  });

  it("still refuses for the ordinary reasons FIRST", () => {
    // The merge field is resolved last, so a workspace that was never going to
    // send gets its real reason rather than an error about a token.
    const d = afterHoursReply({ ...base, workspace: ws, keyword: "opt_out", customerZone: ET });
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.why).toMatch(/opt_out/);
  });

  it("leaves a plain static message working exactly as before", () => {
    // The whole existing behaviour, unchanged: no token, no new failure mode.
    const d = afterHoursReply({
      ...base,
      workspace: { ...ws, after_hours_message: "Thanks! We're closed right now." },
      customerZone: ET,
    });
    expect(d.send).toBe(true);
    if (!d.send) return;
    expect(d.body).toBe("Thanks! We're closed right now.");
  });
});
