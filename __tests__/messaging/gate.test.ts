import { describe, it, expect } from "vitest";
import { gatedSend, MAX_SMS_CHARS, type GateWorkspace, type SendRequest } from "@/lib/messaging/gate";
import { classifyRefusal } from "@/lib/messaging/scheduler";
import { LoggingTransport } from "@/lib/messaging/transport";
import type { E164 } from "@/lib/messaging/phone";

const NASSAU: GateWorkspace = {
  id: "ws-1", name: "NY LI Nassau Leads", phone_e164: "+15163448418",
  time_zone: "America/New_York", quiet_hours_start: 9, quiet_hours_end: 20,
  send_on_weekends: true,
};
const CUSTOMER = "+15165550147" as E164;
const utc = (iso: string) => new Date(iso);
/** Wednesday 2pm EDT — comfortably inside every window. */
const GOOD = utc("2026-07-15T18:00:00Z");

function deps(over: Partial<Parameters<typeof gatedSend>[1]> = {}) {
  const transport = new LoggingTransport();
  return {
    transport,
    isSuppressed: async () => false,
    sentToday: async () => 0,
    ...over,
  } as Parameters<typeof gatedSend>[1] & { transport: LoggingTransport };
}
const req = (over: Partial<SendRequest> = {}): SendRequest =>
  ({ workspace: NASSAU, to: CUSTOMER, body: "Hello from PPP", agent: "lead_nurture", now: GOOD, ...over });

describe("gatedSend — the happy path", () => {
  it("sends from the workspace's own number", async () => {
    const d = deps();
    const r = await gatedSend(req(), d);
    expect(r.ok).toBe(true);
    expect(d.transport.sent).toHaveLength(1);
    // The customer must see the local area code they can reply to.
    expect(d.transport.sent[0].from).toBe("+15163448418");
    expect(d.transport.sent[0].to).toBe(CUSTOMER);
  });
});

describe("gatedSend — refusals never touch the transport", () => {
  // The single most important property in this file: every refusal path must
  // leave the carrier untouched. A rule that computes the right answer and
  // sends anyway is worse than no rule.
  const cases: Array<[string, Partial<SendRequest>, Partial<Parameters<typeof gatedSend>[1]>, string]> = [
    ["opted out",            {},                                      { isSuppressed: async () => true }, "suppressed"],
    ["an email step with no address", { channel: "email" as const },      {},                                 "no_email_address"],
    ["10:30pm local",        { now: utc("2026-07-16T02:30:00Z") },     {},                                 "quiet_hours"],
    ["7am local",            { now: utc("2026-07-15T11:00:00Z") },     {},                                 "quiet_hours"],
    ["already had 3 today",  {},                                      { sentToday: async () => 3 },       "daily_cap"],
    ["workspace has no number", { workspace: { ...NASSAU, phone_e164: null } }, {},                        "no_workspace_number"],
    ["empty body",           { body: "   " },                          {},                                 "empty_body"],
  ];

  for (const [label, r, d, reason] of cases) {
    it(`refuses when ${label} — and sends nothing`, async () => {
      const dd = deps(d);
      const res = await gatedSend(req(r), dd);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe(reason);
      expect(dd.transport.sent).toHaveLength(0);
    });
  }
});

describe("gatedSend — suppression is absolute", () => {
  it("beats quiet hours: an opt-out is never merely 'not yet'", async () => {
    const d = deps({ isSuppressed: async () => true });
    // 10:30pm AND opted out. The reason must be the permanent one.
    const res = await gatedSend(req({ now: utc("2026-07-16T02:30:00Z") }), d);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("suppressed");
      expect(res.retryAt).toBeUndefined(); // there is no better time
    }
  });

  it("beats the daily cap too", async () => {
    const d = deps({ isSuppressed: async () => true, sentToday: async () => 99 });
    const res = await gatedSend(req(), d);
    if (!res.ok) expect(res.reason).toBe("suppressed");
  });
});

describe("gatedSend — deferrals say when, so nothing is silently dropped", () => {
  it("quiet hours returns a retryAt inside the window", async () => {
    const res = await gatedSend(req({ now: utc("2026-07-16T02:30:00Z") }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retryAt).toBeInstanceOf(Date);
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(res.retryAt!)) % 24;
      expect(hour).toBe(9);
    }
  });

  it("the daily cap retries TOMORROW, not later today", async () => {
    const res = await gatedSend(req(), deps({ sentToday: async () => 3 }));
    if (!res.ok) {
      expect(res.retryAt!.getTime()).toBeGreaterThan(GOOD.getTime());
      // The cap exists to stop a fourth message today.
      const day = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "numeric" }).format(d);
      expect(day(res.retryAt!)).not.toBe(day(GOOD));
    }
  });
});

/**
 * THE DEFERRAL HAS TO BE A MOMENT THAT WILL ACTUALLY BE ACCEPTED.
 *
 * The count was a rolling 24 hours and the retry was the next calendar day, so
 * a message stopped on Monday evening was promised Tuesday 9am and arrived to
 * find the same three messages still inside the rolling window. Refused again,
 * promised Wednesday. Every message the cap caught after about 9am landed a day
 * later than the refusal said, and nothing anywhere recorded that it had.
 *
 * So these do not assert the shape of retryAt. They take the gate at its word:
 * run it again AT the moment it promised, with the same message log, and
 * require it to send.
 */
describe("gatedSend — the daily cap's retryAt is a promise it keeps", () => {
  /** A log of outbound sends, counted the way the real dep counts them. */
  const capDeps = (sentAt: Date[], over: Partial<Parameters<typeof gatedSend>[1]> = {}) =>
    deps({
      sentToday: async (_to, since: Date) =>
        sentAt.filter((d) => d.getTime() >= since.getTime()).length,
      ...over,
    });

  const et = (d: Date) => new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", dateStyle: "short", timeStyle: "short",
  }).format(d);

  it("sends at the moment it promised, after an evening cap", async () => {
    // Monday 5:00, 5:30 and 6:00pm ET. Inside CUSTOMER_OUTBOUND, which closes
    // at 7pm on the customer's clock — so this is the cap refusing, not the
    // window, which is the whole point of the fixture.
    const log = [
      utc("2026-07-13T21:00:00Z"), utc("2026-07-13T21:30:00Z"), utc("2026-07-13T22:00:00Z"),
    ];
    const now = utc("2026-07-13T22:05:00Z"); // 6:05pm ET, same Monday
    const first = await gatedSend(req({ now }), capDeps(log));
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.reason).toBe("daily_cap");
    expect(first.retryAt).toBeInstanceOf(Date);

    const again = await gatedSend(req({ now: first.retryAt! }), capDeps(log));
    expect(
      again.ok,
      `refused again at the moment it promised (${et(first.retryAt!)}): ${again.ok ? "" : again.reason}`
    ).toBe(true);
  });

  it("keeps that promise whatever time of day the cap is hit", async () => {
    // Every hour of the Tuesday that a PPP-initiated message can go out at
    // all — CUSTOMER_OUTBOUND is 9am-7pm on the customer's clock — with three
    // sends in the hour before each one.
    for (let h = 10; h < 19; h++) {
      const now = new Date(Date.UTC(2026, 6, 14, h + 4, 0, 0)); // h:00 ET
      const log = [-60, -45, -30].map((m) => new Date(now.getTime() + m * 60_000));
      const first = await gatedSend(req({ now }), capDeps(log));
      if (first.ok) continue; // not capped at this hour; nothing to promise
      expect(first.reason, `${et(now)}`).toBe("daily_cap");
      const again = await gatedSend(req({ now: first.retryAt! }), capDeps(log));
      expect(again.ok, `capped at ${et(now)}, promised ${et(first.retryAt!)}, refused there`).toBe(true);
    }
  });

  it("starts the count at the recipient's midnight, not 24 hours back", async () => {
    // Three last night, 8:00, 8:30 and 9:00pm ET on the Monday.
    const log = [
      utc("2026-07-14T00:00:00Z"), utc("2026-07-14T00:30:00Z"), utc("2026-07-14T01:00:00Z"),
    ];
    // Tuesday 10am ET — inside 24 hours of all three, but a new day.
    const res = await gatedSend(req({ now: utc("2026-07-14T14:00:00Z") }), capDeps(log));
    expect(res.ok, res.ok ? "" : `refused as ${res.reason}`).toBe(true);
  });

  it("still counts what has gone out earlier the same day", async () => {
    const log = [
      utc("2026-07-14T13:00:00Z"), utc("2026-07-14T13:30:00Z"), utc("2026-07-14T14:00:00Z"),
    ];
    const res = await gatedSend(req({ now: utc("2026-07-14T15:00:00Z") }), capDeps(log));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("daily_cap");
  });

  it("puts the boundary at local midnight on the day the clocks change", async () => {
    // US DST ended 2026-11-01 at 2am. Subtracting the local clock time would
    // put "the start of today" an hour out — on the wrong side of midnight —
    // and last night's messages would count against this morning's.
    const log = [
      utc("2026-11-01T00:00:00Z"), utc("2026-11-01T00:30:00Z"), utc("2026-11-01T01:00:00Z"),
    ]; // Saturday 8:00, 8:30, 9:00pm ET
    // Sunday 10am ET, which is 15:00 UTC now the offset is -5.
    const res = await gatedSend(req({ now: utc("2026-11-01T15:00:00Z") }), capDeps(log));
    expect(res.ok, res.ok ? "" : `refused as ${res.reason}`).toBe(true);
  });
});

describe("gatedSend — timezone is the CUSTOMER's, not the workspace's", () => {
  // THIS TEST USED TO ASSERT THE BUG.
  //
  // It sent to CUSTOMER — a 516 number, which is Nassau County, New York —
  // from a San Diego workspace at 10:30pm Eastern, and expected ok. It passed
  // because the gate read the WORKSPACE's clock, saw 7:30pm in California and
  // allowed it. The person holding that handset was in New York at half past
  // ten at night, past the federal 9pm ceiling.
  //
  // Its old name was "the workspace's, not the server's" — true, and a step
  // up from the server's clock, but still the wrong clock. See
  // customer-clock.ts and sending-window.ts.
  const sd: GateWorkspace = { ...NASSAU, name: "CA San Diego Leads", time_zone: "America/Los_Angeles", phone_e164: "+18587790696" };
  const SAN_DIEGO_CUSTOMER = "+16195550147" as E164;

  it("refuses a New York customer at 10:30pm even when the workspace is in California", async () => {
    const at = utc("2026-07-16T02:30:00Z"); // 10:30pm EDT / 7:30pm PDT
    const r = await gatedSend(req({ now: at, workspace: sd }), deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("quiet_hours");
  });

  it("the same instant defers for a Nassau customer and sends for a San Diego one", async () => {
    // One instant: 9:30pm in New York, 6:30pm in San Diego. Same workspace,
    // same clock tick, two customers, two answers.
    const at = utc("2026-07-16T01:30:00Z");
    const east = await gatedSend(req({ now: at, workspace: sd }), deps());
    const west = await gatedSend(req({ now: at, workspace: sd, to: SAN_DIEGO_CUSTOMER }), deps());
    expect(east.ok).toBe(false);
    expect(west.ok).toBe(true);
  });
});

describe("gatedSend — weekend policy is PPP's, not the law's", () => {
  const SAT = utc("2026-07-18T18:00:00Z"); // Saturday 2pm EDT
  it("sends on Saturday when the workspace allows it", async () => {
    const res = await gatedSend(req({ now: SAT }), deps());
    expect(res.ok).toBe(true);
  });
  it("defers to a weekday when it does not", async () => {
    const ws = { ...NASSAU, send_on_weekends: false };
    const res = await gatedSend(req({ now: SAT, workspace: ws }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("weekend");
      const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(res.retryAt!);
      expect(["Sat", "Sun"]).not.toContain(wd);
    }
  });
});

describe("gatedSend — no agent gets an exemption", () => {
  it("refuses every agent identically", async () => {
    for (const agent of ["lead_nurture", "followup", "coordination", "reviews", "booking"]) {
      const d = deps({ isSuppressed: async () => true });
      const res = await gatedSend(req({ agent }), d);
      expect(res.ok).toBe(false);
      expect(d.transport.sent).toHaveLength(0);
    }
  });
});

describe("gatedSend — email is a separate suppression list", () => {
  // fromEmail is required now. An email with nowhere to come FROM is refused
  // rather than sent from whatever the provider defaults to, and these tests
  // are about SUPPRESSION, so they supply one.
  const EMAIL = {
    channel: "email" as const,
    toEmail: "person@example.com",
    fromEmail: "hello@precisionpaintingplus.net",
    subject: "Your free estimate",
  };

  it("sends an email step when the address is not suppressed", async () => {
    const d = deps();
    const r = await gatedSend(req(EMAIL), d);
    expect(r.ok).toBe(true);
  });

  it("refuses an email step to an address that unsubscribed", async () => {
    // 92 of the 213 failed Hatch opt-outs arrived over email. A phone-keyed
    // list alone would have kept emailing every one of them.
    const d = deps({ isSuppressed: async (_t, channel) => channel === "email" });
    const r = await gatedSend(req(EMAIL), d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("suppressed");
    expect(d.transport.sent).toHaveLength(0);
  });

  it("an SMS opt-out does not silently block the email half, or vice versa", async () => {
    // They are different lists under different law — TCPA and CAN-SPAM. The
    // gate must ask about the channel it is actually using, not assume.
    const smsOnly = deps({ isSuppressed: async (_t, channel) => channel === "sms" });
    expect((await gatedSend(req(EMAIL), smsOnly)).ok).toBe(true);
    expect((await gatedSend(req(), smsOnly)).ok).toBe(false);
  });

  it("passes BOTH identifiers so the port can pick the right one", async () => {
    let seen: { phone: string | null; email: string | null } | null = null;
    const d = deps({ isSuppressed: async (t) => { seen = t as never; return false; } });
    await gatedSend(req(EMAIL), d);
    expect(seen).toEqual({ phone: CUSTOMER, email: "person@example.com" });
  });

  it("refuses an email step with nowhere to send it", async () => {
    const d = deps();
    const r = await gatedSend(req({ channel: "email" }), d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_email_address");
    expect(d.transport.sent).toHaveLength(0);
  });
});

/**
 * A TEXT NOBODY MEANT TO SEND.
 *
 * Nothing capped the agent's output. runAgentTurn allows max_tokens: 700 —
 * roughly 2,800 characters, about eighteen texts, billed as eighteen and
 * arriving on a handset as a wall. For the answer_question intent the model's
 * own prose IS the entire message, so no template held it down either.
 */
describe("the runaway message rail", () => {
  const long = (n: number) => "a".repeat(n);

  it("lets a normal reply through", async () => {
    const res = await gatedSend(
      req({ body: "Sounds good, what is the address?" }),
      deps()
    );
    expect(res.ok).toBe(true);
  });

  it("lets a long-but-real campaign opener through", async () => {
    // PPP's actual opener is around 280 characters. A rail that refused this
    // would be enforcing taste, which is the editor's job and the tone rules'.
    const res = await gatedSend(
      req({ body: long(480) }),
      deps()
    );
    expect(res.ok).toBe(true);
  });

  it("refuses the full 700-token runaway", async () => {
    const res = await gatedSend(
      req({ body: long(2800) }),
      deps()
    );
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("too_long");
  });

  it("refuses at the boundary and not one character before it", async () => {
    const at = await gatedSend(req({ body: long(MAX_SMS_CHARS) }), deps());
    expect(at.ok).toBe(true);
    const over = await gatedSend(req({ body: long(MAX_SMS_CHARS + 1) }), deps());
    expect(over.ok).toBe(false);
  });

  it("does not cap an email, which is meant to be longer than a text", async () => {
    const res = await gatedSend(
      req({
        body: long(2800), channel: "email", toEmail: "someone@example.com",
        fromEmail: "ppp@example.com", subject: "Your free estimate",
      }),
      deps()
    );
    // Refused for some other reason or sent, but never for length.
    expect(res.ok === false && res.reason).not.toBe("too_long");
  });

  it("is a failure, not a retry — the body is the same length in an hour", () => {
    expect(classifyRefusal({ ok: false, reason: "too_long" })).toBe("fail");
  });
});

/**
 * THE ONLY CONCESSION IN THE GATE.
 *
 * `answersInbound` lets a reply to a message the customer just sent go out
 * within the FEDERAL window (8am-9pm) rather than the workspace's own narrower
 * hours. The workspace hours exist so PPP does not START conversations at odd
 * times; somebody who texted at 8:30pm has started one, and answering them is
 * not soliciting them. Karan chose this over replying at any hour, 2026-09-22.
 *
 * Deliberately NOT keyed on `agent` — no caller earns an exemption by being
 * itself, which is why that field is recorded and never read.
 */
describe("answering somebody who texted after hours", () => {
  /** New York local hours, as UTC. EDT in July is UTC-4. */
  const ny = (h: number, m = 0) => new Date(Date.UTC(2026, 6, 15, h + 4, m));

  it("is refused at 8:30pm without the flag — the workspace shut at 8", async () => {
    const r = await gatedSend(req({ now: ny(20, 30) }), deps());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("quiet_hours");
  });

  it("is allowed at 8:30pm when it answers an inbound", async () => {
    const r = await gatedSend(req({ now: ny(20, 30), answersInbound: true }), deps());
    expect(r.ok).toBe(true);
  });

  it("is allowed at 8am, before the office opens", async () => {
    expect((await gatedSend(req({ now: ny(8, 5), answersInbound: true }), deps())).ok).toBe(true);
  });

  it("IS STILL REFUSED AT 2AM — the federal bound is not relaxed", async () => {
    // The whole point of choosing the federal window over "any hour".
    const r = await gatedSend(req({ now: ny(2), answersInbound: true }), deps());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("quiet_hours");
  });

  it("is still refused at 9pm exactly, where the federal window closes", async () => {
    expect((await gatedSend(req({ now: ny(21), answersInbound: true }), deps())).ok).toBe(false);
  });

  it("does NOT relax suppression", async () => {
    // A person who said STOP is never answered, at any hour, for any reason.
    const r = await gatedSend(
      req({ now: ny(20, 30), answersInbound: true }),
      deps({ isSuppressed: async () => true })
    );
    expect(r.ok === false && r.reason).toBe("suppressed");
  });

  it("does NOT relax the daily cap", async () => {
    const r = await gatedSend(
      req({ now: ny(20, 30), answersInbound: true }),
      deps({ sentToday: async () => 99 })
    );
    expect(r.ok === false && r.reason).toBe("daily_cap");
  });

  it("does NOT relax the empty-opt-out-list rail", async () => {
    const r = await gatedSend(
      req({ now: ny(20, 30), answersInbound: true }),
      deps({ suppressionListLoaded: async () => false })
    );
    expect(r.ok === false && r.reason).toBe("suppression_list_empty");
  });

  it("gives no exemption to any agent name on its own", async () => {
    // The flag is the concession, not the caller. An agent claiming to be an
    // auto-reply gets nothing without it.
    const r = await gatedSend(req({ now: ny(20, 30), agent: "after_hours" }), deps());
    expect(r.ok).toBe(false);
  });
})

/**
 * HOLIDAYS — migration 179's stated policy, finally enforced.
 *
 * `send_on_holidays` has been a column on workspaces and campaigns since that
 * migration — "Holidays default OFF: a painting estimate chase on Thanksgiving
 * morning reads badly even where it is legal" — false on all 33 workspaces,
 * with no calendar and no check anywhere. The data said one thing and this
 * function would have sent on Christmas morning. Found 2026-10-06 auditing for
 * settings that are saved and never read.
 *
 * Also Kate's condition on the event-park cadence, 2026-10-05: "as long as we
 * have a mechanism that keeps customers from being messaged on specific
 * holidays AND the msg would send the following open day." Both halves are
 * tested, because a bare refusal would meet only the first.
 */
describe("gatedSend — holidays", () => {
  /** Christmas Day 2026 is a Friday, 2pm EST. */
  const XMAS = utc("2026-12-25T19:00:00Z");
  /** Thanksgiving 2026, Thursday 26 November, 2pm EST. */
  const THANKS = utc("2026-11-26T19:00:00Z");
  const dayIn = (d: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(d);

  it("refuses on Christmas Day when the workspace has not opted in", async () => {
    const res = await gatedSend(req({ now: XMAS }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("holiday");
  });

  it("sends on a holiday when the workspace explicitly allows it", async () => {
    const ws = { ...NASSAU, send_on_holidays: true };
    const res = await gatedSend(req({ now: XMAS, workspace: ws }), deps());
    expect(res.ok).toBe(true);
  });

  /** Absent must read as OFF — the column default and the stated policy. */
  it("treats an absent setting as off rather than on", async () => {
    const ws = { ...NASSAU };
    delete (ws as { send_on_holidays?: unknown }).send_on_holidays;
    const res = await gatedSend(req({ now: XMAS, workspace: ws }), deps());
    expect(res.ok).toBe(false);
  });

  /**
   * THE SECOND HALF OF KATE'S ANSWER. Christmas Eve must not defer onto
   * Christmas Day, which is what a naive "try tomorrow" would do — the two are
   * consecutive holidays, and 2026 then runs them into a weekend.
   */
  it("steps over a run of holidays rather than onto the next one", async () => {
    const eve = utc("2026-12-24T19:00:00Z");
    const res = await gatedSend(req({ now: eve, workspace: { ...NASSAU, send_on_weekends: false } }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // 24th Thu (hol), 25th Fri (hol), 26th Sat, 27th Sun -> Monday 28th.
      expect(dayIn(res.retryAt!)).toMatch(/Mon, Dec 28/);
    }
  });

  it("steps over Thanksgiving, the Friday after it, and the weekend", async () => {
    const res = await gatedSend(req({ now: THANKS, workspace: { ...NASSAU, send_on_weekends: false } }), deps());
    expect(res.ok).toBe(false);
    // Thu 26 (hol), Fri 27 (hol), Sat 28, Sun 29 -> Monday 30 November.
    if (!res.ok) expect(dayIn(res.retryAt!)).toMatch(/Mon, Nov 30/);
  });

  /** A workspace that works weekends still skips the holidays themselves. */
  it("lands on the Saturday when the workspace sends at weekends", async () => {
    const res = await gatedSend(req({ now: THANKS, workspace: { ...NASSAU, send_on_weekends: true } }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(dayIn(res.retryAt!)).toMatch(/Sat, Nov 28/);
  });

  it("is deferred by the scheduler, never cancelled", async () => {
    const res = await gatedSend(req({ now: XMAS }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(classifyRefusal(res)).toBe("reschedule");
  });

  it("leaves an ordinary working day alone", async () => {
    // Presidents' Day: federal, and a normal day for a contractor.
    const res = await gatedSend(req({ now: utc("2026-02-16T19:00:00Z") }), deps());
    expect(res.ok).toBe(true);
  });
});

/**
 * ANSWERING SOMEBODY IS NOT INITIATING CONTACT, and the holiday rule briefly
 * forgot it.
 *
 * The holiday check shipped on 2026-10-06 unconditional, so it refused ANY
 * outbound on a holiday — including replies to a customer who had just texted
 * us. The worst of those is HELP: record-inbound queues the legally-required
 * reply as a send_reply precisely so it passes this gate, the gate refused it
 * as "holiday", and it became a draft in a review queue on a day nobody is
 * reviewing. CTIA requires that reply.
 *
 * Kate's answer was about not MESSAGING customers on holidays — a chase, a
 * nudge, a campaign step. Nobody meant "do not answer somebody who writes to
 * you on Christmas Eve".
 *
 * The weekend rule had the same shape and is latent only because every
 * workspace currently sends at weekends.
 */
describe("gatedSend — a reply is answered whatever day it is", () => {
  const XMAS = utc("2026-12-25T19:00:00Z");   // Friday 2pm EST
  const SAT2 = utc("2026-07-18T18:00:00Z");   // Saturday 2pm EDT

  it("answers an inbound on Christmas Day", async () => {
    const res = await gatedSend(req({ now: XMAS, answersInbound: true }), deps());
    expect(res.ok).toBe(true);
  });

  it("still refuses something PPP started on Christmas Day", async () => {
    const res = await gatedSend(req({ now: XMAS }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("holiday");
  });

  it("answers an inbound at the weekend when the workspace does not work them", async () => {
    const ws = { ...NASSAU, send_on_weekends: false };
    const res = await gatedSend(req({ now: SAT2, workspace: ws, answersInbound: true }), deps());
    expect(res.ok).toBe(true);
  });

  it("still refuses something PPP started at that weekend", async () => {
    const ws = { ...NASSAU, send_on_weekends: false };
    const res = await gatedSend(req({ now: SAT2, workspace: ws }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("weekend");
  });

  /** Both at once: a Saturday that is also a holiday, answering an inbound. */
  it("answers an inbound on a holiday that falls at a weekend", async () => {
    // 4 July 2026 is a Saturday.
    const ws = { ...NASSAU, send_on_weekends: false };
    const res = await gatedSend(
      req({ now: utc("2026-07-04T18:00:00Z"), workspace: ws, answersInbound: true }), deps());
    expect(res.ok).toBe(true);
  });

  /** The legal bound is NOT relaxed by any of this. */
  it("still refuses a reply at 2am, holiday or not", async () => {
    const res = await gatedSend(
      req({ now: utc("2026-12-25T07:00:00Z"), answersInbound: true }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("quiet_hours");
  });

  /** And suppression still wins over everything. */
  it("still refuses a reply to somebody who opted out", async () => {
    const res = await gatedSend(
      req({ now: XMAS, answersInbound: true }), deps({ isSuppressed: async () => true }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("suppressed");
  });
});

describe("answersInbound has a shelf life, and it is the customer's day", () => {
  /**
   * 8:45 PM Eastern — past PPP's own 8 PM, inside the federal 9 PM. So the
   * only thing deciding whether this message is legal is whether it really is
   * a reply, which is exactly the claim a review queue cannot keep true.
   */
  const LATE = utc("2026-12-24T01:45:00Z"); // 8:45 PM EST on Wed 23 Dec
  const sameDay = "2026-12-23T19:00:00Z";   // 2 PM EST, the same local day
  const daysAgo = "2026-12-21T19:00:00Z";   // 2 PM EST, two local days earlier

  it("sends when the customer wrote earlier the same day", async () => {
    const d = deps();
    const r = await gatedSend(
      req({ now: LATE, answersInbound: true, answersInboundAt: sameDay }), d
    );
    expect(r.ok).toBe(true);
  });

  it("refuses when the message it claims to answer is from a previous day", async () => {
    const d = deps();
    const r = await gatedSend(
      req({ now: LATE, answersInbound: true, answersInboundAt: daysAgo }), d
    );
    // PPP's own 9-8 window applies, because this is PPP starting something.
    expect(r).toMatchObject({ ok: false, reason: "quiet_hours" });
    expect(d.transport.sent).toHaveLength(0);
  });

  it("still waives the holiday rule for a reply sent the same day", async () => {
    // Christmas Day, 2 PM EST. Holidays off, and a same-day reply goes.
    const xmas = utc("2026-12-25T19:00:00Z");
    const d = deps();
    const r = await gatedSend(req({
      workspace: { ...NASSAU, send_on_holidays: false },
      now: xmas, answersInbound: true, answersInboundAt: "2026-12-25T18:00:00Z",
    }), d);
    expect(r.ok).toBe(true);
  });

  it("does NOT waive the holiday rule for a claim from a previous day", async () => {
    const xmas = utc("2026-12-25T19:00:00Z");
    const d = deps();
    const r = await gatedSend(req({
      workspace: { ...NASSAU, send_on_holidays: false },
      now: xmas, answersInbound: true, answersInboundAt: "2026-12-23T19:00:00Z",
    }), d);
    expect(r).toMatchObject({ ok: false, reason: "holiday" });
  });

  it("treats an absent time as fresh, because the callers without one have no queue", async () => {
    const d = deps();
    const r = await gatedSend(req({ now: LATE, answersInbound: true }), d);
    expect(r.ok).toBe(true);
  });

  /**
   * The boundary is the CUSTOMER's midnight, not the workspace's. A 213 number
   * is Los Angeles: 8:45 PM in New York is 5:45 PM there, and 2 PM Eastern the
   * previous calendar day is 11 AM Pacific — still the day before for both, so
   * the interesting case is the one that straddles. 00:30 UTC on the 24th is
   * 4:30 PM Pacific on the 23rd and 7:30 PM Eastern on the 23rd; an inbound at
   * 07:30 UTC on the 23rd is 11:30 PM Pacific on the TWENTY-SECOND and 2:30 AM
   * Eastern on the 23rd. Eastern would call that the same day. Pacific does
   * not, and Pacific is where the customer is.
   */
  it("measures the day on the customer's clock, not the workspace's", async () => {
    const la = "+12135550147" as E164;
    const d = deps();
    const r = await gatedSend(req({
      to: la, now: utc("2026-12-24T00:30:00Z"),
      answersInbound: true, answersInboundAt: "2026-12-23T07:30:00Z",
    }), d);
    // Not a reply on the customer's day, so PPP's narrower window applies —
    // and 4:30 PM Pacific is inside it, so this still sends. What matters is
    // that the FLAG was dropped; the holiday case above proves the effect.
    expect(r.ok).toBe(true);
    const dayStart = await import("@/lib/messaging/gate")
      .then((m) => m.startOfDayIn(utc("2026-12-24T00:30:00Z"), "America/Los_Angeles"));
    expect(new Date("2026-12-23T07:30:00Z").getTime()).toBeLessThan(dayStart.getTime());
  });
});
