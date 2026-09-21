import { describe, it, expect } from "vitest";
import { gatedSend } from "@/lib/messaging/gate";
import { LoggingTransport } from "@/lib/messaging/transport";
import type { E164 } from "@/lib/messaging/phone";
import fs from "node:fs";

/**
 * PPP's numbers are already inside AWS, in the account that hosts them today
 * rather than PPP's own. AWS End User Messaging does not accept numbers ported
 * in from outside AWS, so the path is a cross-account share — and AWS says a
 * shared number "can only be used with the AWS End User Messaging SMS API" and
 * "You must use the full Amazon Resource Name (ARN) of the shared resource".
 *
 * SendTextMessage is already what this system calls. The only question is what
 * goes in OriginationIdentity.
 */
const MIDDAY = new Date("2026-07-15T16:00:00Z"); // noon in New York
const ARN = "arn:aws:sms-voice:us-east-1:111122223333:phone-number/phone-abc123";

const ws = (over: Record<string, unknown> = {}) => ({
  id: "w", name: "NY LI Nassau Leads", phone_e164: "+15163448418" as E164,
  time_zone: "America/New_York", quiet_hours_start: 9, quiet_hours_end: 20,
  send_on_weekends: true, ...over,
});
const deps = {
  isSuppressed: async () => false, sentToday: async () => 0, hasEverSent: async () => true,
  suppressionListLoaded: async () => true,
};
const body = "This is Precision Painting Plus. Reply STOP to opt out.";

describe("what AWS is told to send from", () => {
  it("sends from the number when this account owns it", async () => {
    const t = new LoggingTransport();
    await gatedSend({ workspace: ws(), to: "+15165551234" as E164, body, agent: "campaign", now: MIDDAY }, { ...deps, transport: t });
    expect(t.sent[0].from).toBe("+15163448418");
  });

  it("sends from the ARN when the number is shared from another AWS account", async () => {
    const t = new LoggingTransport();
    await gatedSend(
      { workspace: ws({ origination_identity: ARN }), to: "+15165551234" as E164, body, agent: "campaign", now: MIDDAY },
      { ...deps, transport: t },
    );
    expect(t.sent[0].from).toBe(ARN);
  });

  it("falls back to the number when the field is blank rather than sending from nothing", async () => {
    const t = new LoggingTransport();
    await gatedSend(
      { workspace: ws({ origination_identity: "   " }), to: "+15165551234" as E164, body, agent: "campaign", now: MIDDAY },
      { ...deps, transport: t },
    );
    expect(t.sent[0].from).toBe("+15163448418");
  });

  it("still refuses a workspace with no number at all", async () => {
    const res = await gatedSend(
      { workspace: ws({ phone_e164: null }), to: "+15165551234" as E164, body, agent: "campaign", now: MIDDAY },
      { ...deps, transport: new LoggingTransport() },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no_workspace_number");
  });

  it("the database accepts an ARN and a phone-number id, and refuses a typo", () => {
    const sql = fs.readFileSync("supabase/migrations/20260921132428_origination_identity.sql", "utf8");
    const check = /origination_identity ~ '([^']+)'/g;
    const patterns = [...sql.matchAll(check)].map((m) => new RegExp(m[1]));
    expect(patterns.length).toBe(2);
    expect(patterns.some((p) => p.test(ARN))).toBe(true);
    expect(patterns.some((p) => p.test("phone-abc123"))).toBe(true);
    for (const wrong of ["+15163448418", "arn:aws:sns:us-east-1:111122223333:topic", "phone number 1"]) {
      expect(patterns.some((p) => p.test(wrong)), wrong).toBe(false);
    }
  });
});
