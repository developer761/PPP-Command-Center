import { describe, it, expect } from "vitest";
import { gatedSend, type GateWorkspace, type SendRequest } from "@/lib/messaging/gate";
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
  const EMAIL = { channel: "email" as const, toEmail: "person@example.com" };

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
