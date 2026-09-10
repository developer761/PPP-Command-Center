import { describe, it, expect } from "vitest";
import { gatedSend } from "@/lib/messaging/gate";
import { LoggingTransport } from "@/lib/messaging/transport";
import { classifyRefusal } from "@/lib/messaging/scheduler";
import { emailChoice } from "@/lib/messaging/transport-config";
import type { E164 } from "@/lib/messaging/phone";

const ws = {
  id: "w", name: "NY LI Nassau Leads", phone_e164: "+15163448418" as E164,
  time_zone: "America/New_York", quiet_hours_start: 0, quiet_hours_end: 24,
  send_on_weekends: true,
};
const TO = "+15165551234" as E164;
const deps = (o: Record<string, unknown> = {}) => ({
  isSuppressed: async () => false, sentToday: async () => 0, hasEverSent: async () => true, ...o,
});

const emailReq = (o: Record<string, unknown> = {}) => ({
  workspace: ws, to: TO, channel: "email" as const,
  toEmail: "customer@example.com", fromEmail: "hello@precisionpaintingplus.net",
  subject: "Your free estimate", body: "Hello,\n\nThanks for reaching out.", agent: "campaign",
  ...o,
});

/**
 * Step 2 of PPP's seeded sequence is an email. It used to fall through to
 * transport.send, which takes a phone number — so it would have been blasted
 * at a handset, subject line and paragraph breaks and all.
 */
describe("an email step goes out as an email", () => {
  it("sends through the email path, not the SMS one", async () => {
    const t = new LoggingTransport();
    const res = await gatedSend(emailReq(), { ...deps(), transport: t });
    expect(res.ok).toBe(true);
    expect(t.emails).toHaveLength(1);
    expect(t.sent).toHaveLength(0);
    expect(t.emails[0].subject).toBe("Your free estimate");
  });

  it("keeps the paragraph breaks an email is supposed to have", async () => {
    const t = new LoggingTransport();
    await gatedSend(emailReq(), { ...deps(), transport: t });
    expect(t.emails[0].body).toContain("\n\n");
  });

  it("refuses when there is nobody to send it to", async () => {
    const res = await gatedSend(emailReq({ toEmail: null }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_email_address");
  });

  /** No workspace has a reply_to_email configured, so this is a real case. */
  it("refuses when there is nowhere for it to come FROM", async () => {
    const res = await gatedSend(emailReq({ fromEmail: null }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_sender_address");
  });

  it("refuses rather than downgrading when the transport cannot do email", async () => {
    // Sending an email as a text is worse than not sending it.
    const smsOnly = { send: async () => ({ providerId: "p" }) };
    const res = await gatedSend(emailReq(), { ...deps(), transport: smsOnly });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("channel_not_supported");
  });

  it("still checks the opt-out list, on the email identifier", async () => {
    const seen: string[] = [];
    const res = await gatedSend(emailReq(), {
      ...deps({ isSuppressed: async (t: { email: string | null }) => { seen.push(t.email ?? ""); return true; } }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("suppressed");
    expect(seen).toContain("customer@example.com");
  });

  it("does not add the SMS opt-out line to an email", async () => {
    const t = new LoggingTransport();
    await gatedSend(emailReq(), { ...deps({ hasEverSent: async () => false }), transport: t });
    expect(t.emails[0].body).not.toContain("Reply STOP");
  });

  it("still refuses an email carrying an unfilled blank", async () => {
    const res = await gatedSend(emailReq({ body: "Call {{workspace_phone}}" }), deps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("unresolved_merge_field");
  });

  it("gives an email a subject when the step forgot one", async () => {
    const t = new LoggingTransport();
    await gatedSend(emailReq({ subject: "  " }), { ...deps(), transport: t });
    expect(t.emails[0].subject.length).toBeGreaterThan(0);
  });

  it("treats both new refusals as something to surface, not retry", () => {
    expect(classifyRefusal({ ok: false, reason: "no_sender_address" })).toBe("fail");
    expect(classifyRefusal({ ok: false, reason: "channel_not_supported" })).toBe("fail");
  });
});

/**
 * Turning on texting must not silently start emailing people as well —
 * different channel, different volume, different opt-outs.
 */
describe("email has its own switch", () => {
  it("is off with nothing configured", () => {
    expect(emailChoice({} as unknown as NodeJS.ProcessEnv).live).toBe(false);
  });

  it("is off when SMS is on but email was never turned on", () => {
    const env = { SMS_LIVE_SENDING: "true", RESEND_API_KEY: "k", RESEND_FROM_ADDRESS: "a@b.com" } as unknown as NodeJS.ProcessEnv;
    expect(emailChoice(env).live).toBe(false);
  });

  it("is off when switched on but with no sending address", () => {
    const env = { EMAIL_LIVE_SENDING: "true", RESEND_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;
    expect(emailChoice(env).live).toBe(false);
    expect(emailChoice(env).why).toMatch(/sending address/);
  });

  it("is on only when the switch and both settings are there", () => {
    const env = {
      EMAIL_LIVE_SENDING: "true", RESEND_API_KEY: "k", RESEND_FROM_ADDRESS: "a@b.com",
    } as unknown as NodeJS.ProcessEnv;
    expect(emailChoice(env).live).toBe(true);
  });
});
