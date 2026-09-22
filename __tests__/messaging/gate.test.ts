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

describe("gatedSend — timezone is the workspace's, not the server's", () => {
  it("the same instant sends for San Diego and defers for Nassau", async () => {
    const at = utc("2026-07-16T02:30:00Z"); // 10:30pm EDT / 7:30pm PDT
    const sd: GateWorkspace = { ...NASSAU, name: "CA San Diego Leads", time_zone: "America/Los_Angeles", phone_e164: "+18587790696" };
    const east = await gatedSend(req({ now: at }), deps());
    const west = await gatedSend(req({ now: at, workspace: sd }), deps());
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
