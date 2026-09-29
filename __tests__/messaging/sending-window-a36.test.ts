/**
 * A36 — the callable window, resolved against the CUSTOMER's clock.
 *
 * The bug these were written for: the gate read ws.time_zone for the sending
 * window, so at 9:30am Eastern it permitted a text to a California number at
 * 6:30 in the morning. That is under the federal 8am floor — a violation, not
 * just a miss against Kate's preference.
 *
 * Every case here is one instant expressed in UTC, so "the same clock tick"
 * means literally the same Date.
 */
import { describe, it, expect } from "vitest";
import { gatedSend, type GateWorkspace, type SendRequest } from "@/lib/messaging/gate";
import { LoggingTransport } from "@/lib/messaging/transport";
import { customerZone, stateForAreaCode, FALLBACK_ZONE } from "@/lib/messaging/customer-clock";
import { sendingWindow, nextWindowOpen, OFFICE_ZONE, officeIsOpen, recipientDayIsOver } from "@/lib/messaging/sending-window";
import type { E164 } from "@/lib/messaging/phone";

const NASSAU: GateWorkspace = {
  id: "ws-1", name: "NY LI Nassau Leads", phone_e164: "+15163448418",
  time_zone: "America/New_York", quiet_hours_start: 9, quiet_hours_end: 20,
  send_on_weekends: true,
};

/** 516 is Nassau County, New York. 619 is San Diego, California. */
const EASTERN = "+15165550147" as E164;
const PACIFIC = "+16195550147" as E164;

function deps() {
  const transport = new LoggingTransport();
  return {
    transport,
    isSuppressed: async () => false,
    hasEverSent: async () => true,
    sentToday: async () => 0,
  } as Parameters<typeof gatedSend>[1] & { transport: LoggingTransport };
}

/** The gate's answer, and a guarantee that a refusal touched no carrier. */
async function ask(to: E164, now: Date, over: Partial<SendRequest> = {}) {
  const d = deps();
  const r = await gatedSend(
    { workspace: NASSAU, to, body: "Quick question about your estimate.", agent: "probe", now, ...over },
    d
  );
  if (!r.ok) expect(d.transport.sent).toHaveLength(0);
  return r.ok ? "SENT" : r.reason;
}

/* ─────────────────────────────────────────────────────────────────────── */

describe("customerZone — whose clock", () => {
  it("reads the state off the area code", () => {
    expect(stateForAreaCode("+16195550147")).toBe("CA");
    expect(stateForAreaCode("+15165550147")).toBe("NY");
    expect(stateForAreaCode("+13035550147")).toBe("CO");
  });

  it("gives up rather than guessing on a number it cannot place", () => {
    // 999 is reserved for PPP's own test numbers.
    expect(stateForAreaCode("+19995550147")).toBeNull();
    expect(stateForAreaCode("not a phone")).toBeNull();
    expect(stateForAreaCode(null)).toBeNull();
  });

  it("falls back to the MOST RESTRICTIVE zone, never the workspace's", () => {
    const z = customerZone({ phone: "+19995550147" });
    expect(z.source).toBe("fallback");
    // Pacific wakes last, so holding to 9am there cannot be early for anybody
    // in PPP's territory. Falling back to the SENDER's clock is the bug.
    expect(z.timeZone).toBe(FALLBACK_ZONE);
    expect(z.timeZone).not.toBe(NASSAU.time_zone);
  });

  it("prefers the zip's state over the area code, because numbers port", () => {
    const z = customerZone({ zipState: "CA", phone: "+15165550147" });
    expect(z.source).toBe("zip");
    expect(z.timeZone).toBe("America/Los_Angeles");
  });
});

describe("A36 — Kate's own acceptance test", () => {
  // "Tested at 7:30 PM Eastern with a California lead and an Eastern lead: on
  //  the same clock tick, one gets the in-hours behaviour and the other gets
  //  the prefix."
  const TICK = new Date("2026-09-28T23:30:00Z"); // Monday, 7:30pm EDT / 4:30pm PDT

  it("refuses the Eastern lead, who is past their 7pm cut-off", async () => {
    expect(await ask(EASTERN, TICK)).toBe("quiet_hours");
  });

  it("allows the California lead on the SAME tick, at 4:30 in the afternoon", async () => {
    expect(await ask(PACIFIC, TICK)).toBe("SENT");
  });
});

describe("A36 — the violation this was written for", () => {
  const MORNING = new Date("2026-09-28T13:30:00Z"); // Monday, 9:30am EDT / 6:30am PDT

  it("does not text a California number at 6:30 in the morning", async () => {
    expect(await ask(PACIFIC, MORNING)).toBe("quiet_hours");
  });

  it("still sends to an Eastern number at 9:30am, so the fix is not a blanket refusal", async () => {
    expect(await ask(EASTERN, MORNING)).toBe("SENT");
  });

  it("holds a number it cannot place to the restrictive zone rather than the office's", async () => {
    // Same instant. The workspace's clock says 9:30am and would have allowed it.
    expect(await ask("+19995550147" as E164, MORNING)).toBe("quiet_hours");
  });
});

describe("A36 — Kate is stricter than federal, and that binds first", () => {
  it("refuses 8:30am Pacific, which is legal but before A36's 9am", async () => {
    expect(await ask(PACIFIC, new Date("2026-09-28T15:30:00Z"))).toBe("quiet_hours");
  });

  it("opens at 9:30am Pacific", async () => {
    expect(await ask(PACIFIC, new Date("2026-09-28T16:30:00Z"))).toBe("SENT");
  });
});

describe("A36 — answering somebody who just texted", () => {
  it("relaxes the CUSTOMER's window to the federal bound", async () => {
    // 7:30pm Eastern: past A36's 7pm, inside the federal 9pm.
    const tick = new Date("2026-09-28T23:30:00Z");
    expect(await ask(EASTERN, tick)).toBe("quiet_hours");
    expect(await ask(EASTERN, tick, { answersInbound: true })).toBe("SENT");
  });

  it("stands the office window down, because answering is not a callback", async () => {
    // 8:30pm Eastern, so PPP's office (9-8) is shut. A36 names itself the
    // "CALLBACK WINDOW to SET an appointment" — it governs contact PPP
    // starts. Karan's 2026-09-22 decision is that a reply to somebody who
    // texted first is not that. Open with Kate; see sending-window.ts.
    // A Pacific customer, so their OWN window is open (5:30pm) and the only
    // thing shut is the office. With an Eastern customer the refusal would
    // read office_closed for the wrong reason — their window shuts at 7pm.
    const tick = new Date("2026-09-29T00:30:00Z");
    expect(await ask(PACIFIC, tick)).toBe("office_closed");            // unsolicited: waits
    expect(await ask(PACIFIC, tick, { answersInbound: true })).toBe("SENT"); // an answer: goes
  });

  it("does not relax the federal bound either — 9:30pm Eastern is refused as quiet hours", async () => {
    // answersInbound widens the customer window to 8am-9pm, and 9:30pm is
    // outside it. The legal refusal, not the office one.
    expect(await ask(EASTERN, new Date("2026-09-29T01:30:00Z"), { answersInbound: true }))
      .toBe("quiet_hours");
  });

  it("and never answers at 2:30 in the morning", async () => {
    expect(await ask(EASTERN, new Date("2026-09-29T06:30:00Z"), { answersInbound: true }))
      .toBe("quiet_hours");
  });
});

describe("A36 — the weekend half day", () => {
  // Saturday 2026-10-03. 5:30pm EDT is 21:30 UTC.
  it("is open at 5:00pm Eastern on a Saturday", async () => {
    expect(await ask(EASTERN, new Date("2026-10-03T21:00:00Z"))).toBe("SENT");
  });

  it("is shut at 5:31pm Eastern on a Saturday, which an hours-only window would miss", async () => {
    expect(await ask(EASTERN, new Date("2026-10-03T21:31:00Z"))).toBe("office_closed");
  });

  it("is still open at 5:31pm on the Monday", async () => {
    expect(await ask(EASTERN, new Date("2026-10-05T21:31:00Z"))).toBe("SENT");
  });
});

describe("nextWindowOpen — the retry time answers the same rule", () => {
  it("lands on an instant the window actually calls open", () => {
    for (const [zone, now] of [
      ["America/Los_Angeles", "2026-09-28T13:30:00Z"],  // 6:30am PT, shut
      ["America/New_York", "2026-09-29T06:30:00Z"],     // 2:30am ET, shut
      ["America/New_York", "2026-10-03T21:31:00Z"],     // Sat 5:31pm ET, shut
      ["America/Denver", "2026-09-28T23:59:00Z"],       // 5:59pm MT, already OPEN
      ["America/Chicago", "2026-10-04T22:00:00Z"],      // Sun 5pm CT, office shut
    ] as const) {
      const input = { now: new Date(now), customerZone: zone, officeZone: OFFICE_ZONE };
      const closed = !sendingWindow(input).open;
      const at = nextWindowOpen(input);
      expect(at, `${zone} @ ${now}`).not.toBeNull();
      // The property that matters: the scheduler and the predicate agree. A
      // retry time the window itself calls shut is how a scheduler and its
      // rule drift apart, which has happened four times in this codebase.
      expect(sendingWindow({ ...input, now: at! }).open, `${zone} @ ${now} -> ${at?.toISOString()}`).toBe(true);
      // An already-open window returns now; a shut one must actually advance.
      if (closed) expect(at!.getTime(), `${zone} @ ${now}`).toBeGreaterThan(new Date(now).getTime());
      else expect(at!.getTime()).toBe(new Date(now).getTime());
    }
  });

  it("returns null rather than throwing when no window can ever open", () => {
    // A workspace configured to a window that cannot intersect the office's.
    const at = nextWindowOpen({
      now: new Date("2026-09-28T13:30:00Z"),
      customerZone: "America/Los_Angeles",
      officeZone: OFFICE_ZONE,
      officeHours: { startHour: 8, endHour: 9 },   // shut before Pacific wakes
    });
    expect(at).toBeNull();
  });
});

/**
 * IS PPP OPEN, AS OPPOSED TO "COULD WE HAVE SENT PROACTIVELY".
 *
 * Found in the persona hunt. A46's out-of-hours line promises to "pass them
 * along ONCE WE OPEN" — a claim about the OFFICE. The scheduler resolved it
 * from `!sendingWindow(...).open`, which is false when EITHER window is shut,
 * so it also fired when it was merely too early on the CUSTOMER's clock.
 *
 * The two come apart for one hour a day for anybody west of Eastern, and never
 * for an Eastern customer — which is why reading the code did not show it.
 */
describe("the office window, with the customer's clock out of it", () => {
  // A Tuesday. 8:30 AM in Los Angeles is 11:30 AM Eastern.
  const laEarlyMorning = new Date("2026-09-29T15:30:00Z");

  it("says the office is OPEN at 11:30 AM Eastern", () => {
    expect(officeIsOpen({ now: laEarlyMorning, officeZone: "America/New_York" })).toBe(true);
  });

  it("while the send window is shut for that same customer — 8:30 AM their time", () => {
    // Both are correct. The customer may not be texted yet; the office is open.
    // Conflating them is what put "once we open" in front of a Los Angeles
    // customer at half past eight in the morning.
    expect(sendingWindow({
      now: laEarlyMorning, customerZone: "America/Los_Angeles", officeZone: "America/New_York",
    }).open).toBe(false);
  });

  it("and an Eastern customer at 8:30 AM is out of hours on BOTH — which is why this hid", () => {
    const nyEarlyMorning = new Date("2026-09-29T12:30:00Z");
    expect(officeIsOpen({ now: nyEarlyMorning, officeZone: "America/New_York" })).toBe(false);
    expect(sendingWindow({
      now: nyEarlyMorning, customerZone: "America/New_York", officeZone: "America/New_York",
    }).open).toBe(false);
  });

  it("is shut in the evening, when 'once we open' is the true thing to say", () => {
    // 7:30 PM in Los Angeles is 10:30 PM Eastern, past the 8 PM close.
    expect(officeIsOpen({ now: new Date("2026-09-30T02:30:00Z"), officeZone: "America/New_York" })).toBe(false);
  });

  it("honours a workspace that has narrowed its own hours, never widened them", () => {
    // 9:30 AM Eastern, inside A36's 9-8 but outside a workspace's 10-5.
    const at930 = new Date("2026-09-29T13:30:00Z");
    expect(officeIsOpen({ now: at930, officeZone: "America/New_York" })).toBe(true);
    expect(officeIsOpen({
      now: at930, officeZone: "America/New_York", officeHours: { startHour: 10, endHour: 17 },
    })).toBe(false);
    // And a workspace claiming 6am-11pm cannot open earlier than A36 allows.
    expect(officeIsOpen({
      now: new Date("2026-09-29T11:30:00Z"), officeZone: "America/New_York",
      officeHours: { startHour: 6, endHour: 23 },
    })).toBe(false);
  });

  it("closes at 5:30 PM on a Saturday, like the weekend window", () => {
    // Saturday 2026-10-03. 5:45 PM Eastern.
    expect(officeIsOpen({ now: new Date("2026-10-03T21:45:00Z"), officeZone: "America/New_York" })).toBe(false);
    expect(officeIsOpen({ now: new Date("2026-10-03T21:00:00Z"), officeZone: "America/New_York" })).toBe(true);
  });
});

/**
 * ── KATE'S ACCEPTANCE TEST, FOR THE DISCLOSURE AND NOT THE GATE ─────────
 *
 * The spec states it as a single line: "Tested at 7:30 PM Eastern with a
 * California lead and an Eastern lead: on the same clock tick, one gets the
 * in-hours behaviour and the other gets the prefix."
 *
 * There WAS a test for that tick — against `sendingWindow`, the send gate.
 * It passed, and the disclosure was still wrong, because the disclosure read
 * a different function: a global `officeIsOpen` with no customer in it. At
 * 7:30 PM the office is open until 8, so the Eastern lead got no prefix even
 * though A36 says nothing more reaches them until tomorrow.
 *
 * That is the spec's "a single flag gets two of the six states wrong every
 * evening", and it is why this asserts the DISCLOSURE input rather than the
 * gate.
 */
describe("7:30 PM Eastern, two customers, one clock tick", () => {
  // Wednesday 2026-09-30, 19:30 America/New_York.
  const TICK = new Date("2026-09-30T23:30:00Z");
  const shutToThem = (customerZone: string) =>
    !officeIsOpen({ now: TICK, officeZone: "America/New_York" })
    || recipientDayIsOver({ now: TICK, customerZone });

  it("gives the Eastern lead the out-of-hours prefix", () => {
    // 7:30 PM their time. A36: after 7 PM ET nothing more reaches an Eastern
    // client until the next day.
    expect(shutToThem("America/New_York")).toBe(true);
  });

  it("gives the California lead in-hours behaviour on the same tick", () => {
    // 4:30 PM their time, and the office is open until 8 Eastern.
    expect(shutToThem("America/Los_Angeles")).toBe(false);
  });
});

/**
 * The other half, and the reason this is not simply `!sendingWindow().open`.
 *
 * Too EARLY on the customer's clock is not "we are closed": the office is
 * open and their details go on somebody's desk now. An LA customer texting at
 * 8:30 AM was told we would pass them along "once we open" — at 11:30 AM
 * Eastern, with the office open — daily, in approved compliance copy.
 */
describe("too early is not the same as too late", () => {
  it("does not call it out of hours when the customer's day has not begun", () => {
    // 8:30 AM Los Angeles = 11:30 AM Eastern. Office open.
    const early = new Date("2026-09-30T15:30:00Z");
    expect(recipientDayIsOver({ now: early, customerZone: "America/Los_Angeles" })).toBe(false);
    expect(officeIsOpen({ now: early, officeZone: "America/New_York" })).toBe(true);
  });

  it("does call it out of hours once their evening has arrived", () => {
    // 7:30 PM Los Angeles.
    const late = new Date("2026-10-01T02:30:00Z");
    expect(recipientDayIsOver({ now: late, customerZone: "America/Los_Angeles" })).toBe(true);
  });

  it("does not claim a day ended when the zone is unusable", () => {
    // Not knowing where they are is not evidence their day is over; the
    // office check beside it still applies.
    expect(recipientDayIsOver({ now: TICK_UNUSED, customerZone: "Not/AZone" })).toBe(false);
  });
});
const TICK_UNUSED = new Date("2026-09-30T23:30:00Z");
