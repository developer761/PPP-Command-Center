import { describe, it, expect } from "vitest";
import { classifyInbound, normalizeKeyword, withinQuietHours, nextSendableTime, localHour, clampToFederal, withinDailyCap, DEFAULT_QUIET_HOURS, FEDERAL_BOUND, DEFAULT_DAILY_CAP, optOutSource, isPlainLanguageOptOut } from "@/lib/messaging/compliance";

/** A wall-clock instant expressed in UTC, for readable fixtures. */
const utc = (iso: string) => new Date(iso);

describe("classifyInbound — opt-out keywords", () => {
  it("catches every carrier keyword, bare", () => {
    for (const k of ["stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout"]) {
      expect(classifyInbound(k)).toBe("opt_out");
    }
  });

  it("is case-insensitive and tolerates punctuation and padding", () => {
    // Every one of these is a real shape a customer sends.
    for (const s of ["STOP", "Stop.", " stop ", "stop!", "STOP!!", "Stop,", "\nSTOP\n", "  Stop . "]) {
      expect(classifyInbound(s)).toBe("opt_out");
    }
  });

  it("treats 'opt out' with a space as opting out", () => {
    expect(classifyInbound("Opt Out")).toBe("opt_out");
    expect(classifyInbound("opt-out")).toBe("opt_out"); // hyphen normalises to space
  });

  it("does NOT opt out on a keyword inside a sentence", () => {
    // The expensive false positive: unsubscribing someone who was talking
    // about their appointment.
    for (const s of [
      "please don't cancel my appointment",
      "can we stop by at 3?",
      "I want to cancel the 2pm and rebook",
      "stop by whenever",
      "the end of the week works",
    ]) {
      expect(classifyInbound(s)).toBe("normal");
    }
  });

  it("handles empty, whitespace and punctuation-only bodies as normal", () => {
    for (const s of ["", "   ", "\n\n", "...", "?!"]) expect(classifyInbound(s)).toBe("normal");
  });

  it("normalises full-width and unicode punctuation", () => {
    expect(classifyInbound("ＳＴＯＰ")).toBe("opt_out"); // full-width, via NFKC
    expect(classifyInbound("stop。")).toBe("opt_out");   // ideographic full stop
  });

  it("separates opt-in and help from opt-out", () => {
    for (const s of ["start", "START", "Unstop"]) expect(classifyInbound(s)).toBe("opt_in");
    for (const s of ["help", "HELP", "Info", "info."]) expect(classifyInbound(s)).toBe("help");
  });

  it("does NOT read a bare yes as a re-subscribe", () => {
    // "YES" is a re-subscribe only inside a double opt-in confirmation flow,
    // and PPP has never had one. For a bot that asks a question in nearly
    // every message it is the commonest one-word reply there is — so treating
    // it as opt_in silently put anyone who had opted out back on the list the
    // moment they answered a question, and made them textable again.
    for (const s of ["yes", "Yes", "YES", "yes."]) expect(classifyInbound(s)).toBe("normal");
  });

  it("normalizeKeyword collapses to a bare comparable token", () => {
    expect(normalizeKeyword("  Stop!! ")).toBe("stop");
    expect(normalizeKeyword("OPT-OUT")).toBe("opt out");
  });
});

describe("quiet hours — timezone correctness", () => {
  it("reads the local hour, not the server's", () => {
    // 2026-07-15T18:00Z = 2pm EDT in New York, 11am PDT in Los Angeles.
    const t = utc("2026-07-15T18:00:00Z");
    expect(localHour(t, "America/New_York")).toBe(14);
    expect(localHour(t, "America/Los_Angeles")).toBe(11);
  });

  it("the SAME instant can be legal in Nassau and illegal in San Diego", () => {
    // 2026-07-16T02:30Z = 10:30pm EDT (shut) / 7:30pm PDT (open).
    const t = utc("2026-07-16T02:30:00Z");
    expect(withinQuietHours(t, "America/New_York")).toBe(false);
    expect(withinQuietHours(t, "America/Los_Angeles")).toBe(true);
  });

  it("handles DST: the same UTC hour differs in January and July", () => {
    // 13:00Z is 8am EST in winter (shut, before 9) and 9am EDT in summer (open).
    expect(localHour(utc("2026-01-15T13:00:00Z"), "America/New_York")).toBe(8);
    expect(localHour(utc("2026-07-15T13:00:00Z"), "America/New_York")).toBe(9);
    expect(withinQuietHours(utc("2026-01-15T13:00:00Z"), "America/New_York")).toBe(false);
    expect(withinQuietHours(utc("2026-07-15T13:00:00Z"), "America/New_York")).toBe(true);
  });

  it("is inclusive at open and EXCLUSIVE at close", () => {
    const nine = utc("2026-07-15T13:00:00Z");   // 09:00 EDT
    const eight = utc("2026-07-16T00:00:00Z");  // 20:00 EDT
    const seven59 = utc("2026-07-15T23:59:00Z"); // 19:59 EDT
    expect(withinQuietHours(nine, "America/New_York")).toBe(true);
    expect(withinQuietHours(seven59, "America/New_York")).toBe(true);
    expect(withinQuietHours(eight, "America/New_York")).toBe(false);
  });

  it("never lets a misconfigured workspace authorise an illegal send", () => {
    // A workspace asking for 6am-11pm gets clamped to the federal 8am-9pm.
    expect(clampToFederal({ startHour: 6, endHour: 23 })).toEqual(FEDERAL_BOUND);
    const sevenAm = utc("2026-07-15T11:00:00Z"); // 07:00 EDT
    expect(withinQuietHours(sevenAm, "America/New_York", { startHour: 6, endHour: 23 })).toBe(false);
  });

  it("lets a workspace be STRICTER than the default", () => {
    const tenAm = utc("2026-07-15T14:00:00Z"); // 10:00 EDT
    expect(withinQuietHours(tenAm, "America/New_York", { startHour: 11, endHour: 17 })).toBe(false);
  });

  it("the default is tighter than federal at both ends", () => {
    expect(DEFAULT_QUIET_HOURS.startHour).toBeGreaterThan(FEDERAL_BOUND.startHour);
    expect(DEFAULT_QUIET_HOURS.endHour).toBeLessThan(FEDERAL_BOUND.endHour);
  });
});

describe("nextSendableTime — deferring instead of dropping", () => {
  it("returns the same instant when already inside the window", () => {
    const t = utc("2026-07-15T18:00:00Z"); // 2pm EDT
    expect(nextSendableTime(t, "America/New_York").getTime()).toBe(t.getTime());
  });

  it("defers a late-night message to the next morning, in local terms", () => {
    const lateNight = utc("2026-07-16T03:30:00Z"); // 11:30pm EDT
    const next = nextSendableTime(lateNight, "America/New_York");
    expect(next.getTime()).toBeGreaterThan(lateNight.getTime());
    expect(withinQuietHours(next, "America/New_York")).toBe(true);
    expect(localHour(next, "America/New_York")).toBe(DEFAULT_QUIET_HOURS.startHour);
  });

  it("defers an early-morning message forward the same day", () => {
    const early = utc("2026-07-15T10:00:00Z"); // 6am EDT
    const next = nextSendableTime(early, "America/New_York");
    expect(localHour(next, "America/New_York")).toBe(9);
    // Same calendar day locally — it should not skip 24 hours.
    expect(next.getTime() - early.getTime()).toBeLessThan(6 * 3600 * 1000);
  });

  it("produces a valid sendable instant across a DST spring-forward", () => {
    // US DST begins 2026-03-08. 2am local does not exist that night.
    const beforeJump = utc("2026-03-08T05:30:00Z");
    const next = nextSendableTime(beforeJump, "America/New_York");
    expect(withinQuietHours(next, "America/New_York")).toBe(true);
    expect(Number.isNaN(next.getTime())).toBe(false);
  });

  it("always lands inside the window, for every timezone PPP operates in", () => {
    const zones = [
      "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    ];
    for (const tz of zones) {
      for (let h = 0; h < 24; h++) {
        const t = utc(`2026-07-15T${String(h).padStart(2, "0")}:00:00Z`);
        expect(withinQuietHours(nextSendableTime(t, tz), tz)).toBe(true);
      }
    }
  });
});

describe("daily cap", () => {
  it("allows up to the cap and refuses at it", () => {
    expect(withinDailyCap(0)).toBe(true);
    expect(withinDailyCap(DEFAULT_DAILY_CAP - 1)).toBe(true);
    expect(withinDailyCap(DEFAULT_DAILY_CAP)).toBe(false);
    expect(withinDailyCap(DEFAULT_DAILY_CAP + 5)).toBe(false);
  });

  it("honours a per-workspace override", () => {
    expect(withinDailyCap(1, 1)).toBe(false);
    expect(withinDailyCap(0, 1)).toBe(true);
  });
});

/**
 * A24 — LIVE, CRITICAL, AND NOT IMPLEMENTED UNTIL NOW.
 *
 * "Any clear 'STOP', 'stop', or PLAIN-LANGUAGE REQUEST to end or halt
 * communication STOPS all further text outreach immediately."
 *
 * Only the carrier keywords were honoured, so every one of these came back
 * `normal` and the bot carried on texting somebody who had asked it to stop.
 * This sat open for weeks as "a decision for Kate" when Kate had already
 * decided it, in a rule marked critical.
 */
describe("A24 — an opt-out can be a sentence", () => {
  it("honours a plain-language request to stop", () => {
    for (const t of [
      "stop texting me", "please stop texting me", "take me off your list",
      "remove me from your list", "quit texting me", "leave me alone",
      "do not contact me again", "stop contacting me", "unsubscribe me please",
      "stop all", "no more texts please", "opt me out",
    ]) {
      expect(classifyInbound(t), t).toBe("opt_out");
    }
  });

  /**
   * "AN OPT-OUT IS NOT A DECLINE... A customer saying they will do the work
   * themselves, or that they are all set, has declined the SERVICE — close
   * warmly and stop collecting (A17)."
   *
   * Reading these as opt-outs would suppress a live lead permanently, which
   * is the expensive direction to get wrong.
   */
  it("does not suppress somebody who is merely declining the work", () => {
    for (const t of [
      "no thanks", "I'm all set", "we hired someone else",
      "not interested", "I'll do it myself", "we decided to go another way",
    ]) {
      expect(classifyInbound(t), t).toBe("normal");
    }
  });

  /** The verb after "stop" is enumerated precisely so these cannot match. */
  it("does not read an ordinary sentence containing stop as an opt-out", () => {
    for (const t of [
      "stop by tomorrow", "can you stop at the house first",
      "I want to paint the stop sign wall", "sounds good",
    ]) {
      expect(classifyInbound(t), t).toBe("normal");
    }
  });

  /**
   * "IT COUNTS EVEN WHEN THE CUSTOMER PACKS OTHER CONTENT INTO THE SAME
   * MESSAGE — the opt-out takes priority over anything else in that message."
   */
  it("counts even when packed in with other content", () => {
    for (const t of [
      "Thanks for the quote but please stop texting me",
      "Sounds good, also take me off your list",
      "Not interested, stop contacting me",
    ]) {
      expect(classifyInbound(t), t).toBe("opt_out");
    }
  });

  /** Different evidence if it is ever disputed, so recorded differently. */
  it("records which kind of evidence the opt-out rests on", () => {
    expect(optOutSource("STOP")).toBe("inbound_keyword");
    expect(optOutSource("stop")).toBe("inbound_keyword");
    expect(optOutSource("take me off your list")).toBe("inbound_phrase");
    expect(isPlainLanguageOptOut("take me off your list")).toBe(true);
    expect(isPlainLanguageOptOut("STOP")).toBe(false);
  });
});
