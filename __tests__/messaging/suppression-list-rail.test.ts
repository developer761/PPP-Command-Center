import { describe, it, expect } from "vitest";
import { gatedSend } from "@/lib/messaging/gate";
import { classifyRefusal } from "@/lib/messaging/scheduler";
import { refusalText } from "@/lib/messaging/drafts";
import { LoggingTransport } from "@/lib/messaging/transport";
import type { E164 } from "@/lib/messaging/phone";

/**
 * The rail that matters while the numbers are being ported.
 *
 * sms_opt_outs is empty: Kate's Hatch export has not been imported. An empty
 * list answers "not suppressed" for everybody, including the people who told
 * Hatch to stop months ago — and live sending plus an active workflow are two
 * toggles apart during a cutover.
 */
const MIDDAY = new Date("2026-07-15T16:00:00Z"); // noon in New York

const ws = {
  id: "w", name: "NY LI Nassau Leads", phone_e164: "+15163448418" as E164,
  time_zone: "America/New_York", quiet_hours_start: 9, quiet_hours_end: 20,
  send_on_weekends: true,
};
const TO = "+15165551234" as E164;
const req = { workspace: ws, to: TO, body: "Hello from PPP. Reply STOP to opt out.", agent: "campaign", now: MIDDAY };
const base = {
  isSuppressed: async () => false,
  sentToday: async () => 0,
  hasEverSent: async () => true,
};

describe("nothing goes out while the opt-out list is empty", () => {
  it("refuses, before the suppression check can answer for everybody", async () => {
    const t = new LoggingTransport();
    const res = await gatedSend(req, { ...base, suppressionListLoaded: async () => false, transport: t });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("suppression_list_empty");
    // The point: no carrier was reached.
    expect(t.sent).toHaveLength(0);
  });

  it("sends normally once a list exists", async () => {
    const t = new LoggingTransport();
    const res = await gatedSend(req, { ...base, suppressionListLoaded: async () => true, transport: t });
    expect(res.ok).toBe(true);
    expect(t.sent).toHaveLength(1);
  });

  it("does not block a caller that cannot answer the question", async () => {
    // Every existing caller and the simulator: the rail is opt-in, so adding
    // it cannot quietly stop something that was working.
    const res = await gatedSend(req, { ...base, transport: new LoggingTransport() });
    expect(res.ok).toBe(true);
  });

  it("is held, not failed, so the queue drains itself once the list lands", () => {
    expect(classifyRefusal({ ok: false, reason: "suppression_list_empty" })).toBe("reschedule");
  });

  it("says why, in words a person can act on", () => {
    expect(refusalText("suppression_list_empty")).toMatch(/opt-out list/i);
    expect(refusalText("suppression_list_empty")).toMatch(/import/i);
  });

  it("still refuses somebody on the list when a list exists", async () => {
    const res = await gatedSend(req, {
      ...base, suppressionListLoaded: async () => true, isSuppressed: async () => true,
      transport: new LoggingTransport(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("suppressed");
  });
});
