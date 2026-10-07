import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { gatedSend, type GateWorkspace, type SendRequest } from "@/lib/messaging/gate";
import { LoggingTransport } from "@/lib/messaging/transport";
import type { E164 } from "@/lib/messaging/phone";

/**
 * HELP HAS TO GO OUT. CARRIERS TEST IT.
 *
 * record-inbound queues the CTIA-required HELP reply through the ordinary
 * reply queue, deliberately, so it passes the same gate as everything else —
 * "the suppression check, the cap and the hours all still apply".
 *
 * Two of those are PPP's own policy rather than a legal bound, and both could
 * eat it in silence:
 *
 *   the daily cap        somebody who has had three messages today and then
 *                        texts HELP got nothing, and the reply became a draft
 *   the empty-list rail  refuses every send while sms_opt_outs is empty, so
 *                        until the list was imported EVERY HELP reply became
 *                        a draft in a queue nobody was reading
 *
 * And two cancels in the scheduler dropped it before it was sent at all: a
 * person claiming the thread, and the customer texting again. Both are good
 * reasons to drop Emily's ANSWER and bad reasons to drop HELP, which is a
 * fixed string about how to stop and where to get help — just as true after
 * somebody takes the conversation over.
 */
const NASSAU: GateWorkspace = {
  id: "ws-1", name: "NY LI Nassau Leads", phone_e164: "+15163448418",
  time_zone: "America/New_York", quiet_hours_start: 9, quiet_hours_end: 20,
  send_on_weekends: true,
};
const CUSTOMER = "+15165550147" as E164;
/** Wednesday 2pm EDT. */
const NOW = new Date("2026-07-15T18:00:00Z");

function deps(over: Partial<Parameters<typeof gatedSend>[1]> = {}) {
  const transport = new LoggingTransport();
  return {
    transport,
    isSuppressed: async () => false,
    sentToday: async () => 0,
    ...over,
  } as Parameters<typeof gatedSend>[1] & { transport: LoggingTransport };
}
const help = (over: Partial<SendRequest> = {}): SendRequest => ({
  workspace: NASSAU, to: CUSTOMER,
  body: "Reply STOP to unsubscribe. Msg&data rates may apply.",
  agent: "agent_autosend", now: NOW, answersInbound: true, required: true, ...over,
});

describe("the required reply survives PPP's own rails", () => {
  it("goes out when the customer has already had their three for today", () => {
    const d = deps({ sentToday: async () => 99 });
    return gatedSend(help(), d).then((r) => {
      expect(r.ok, r.ok ? "" : r.reason).toBe(true);
      expect(d.transport.sent).toHaveLength(1);
    });
  });

  it("goes out while the suppression list is still empty", async () => {
    const d = deps({ suppressionListLoaded: async () => false });
    const r = await gatedSend(help(), d);
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
  });

  it("an ordinary reply is still stopped by both", async () => {
    // The carve-out is for the required reply and nothing else.
    const capped = await gatedSend(help({ required: false }), deps({ sentToday: async () => 99 }));
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.reason).toBe("daily_cap");

    const railed = await gatedSend(
      help({ required: false }),
      deps({ suppressionListLoaded: async () => false })
    );
    expect(railed.ok).toBe(false);
    if (!railed.ok) expect(railed.reason).toBe("suppression_list_empty");
  });

  it("is still refused for somebody who opted out, and says so loudly", async () => {
    // Deliberately NOT carved out: suppression is the one absolute rule here,
    // and a hole in it is a decision for Kate rather than a flag. The refusal
    // is reported so the gap is visible instead of silent.
    const d = deps({ isSuppressed: async () => true });
    const r = await gatedSend(help(), d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("suppressed");
    expect(d.transport.sent).toHaveLength(0);
    expect(readFileSync("lib/messaging/gate.ts", "utf8"))
      .toMatch(/required_reply_refused_suppressed/);
  });
});

/**
 * The scheduler's two cancels, asserted on the source: both run before any
 * transport is involved, so there is no send to observe — the thing that
 * matters is that the HELP reply is exempt from each.
 *
 * MATCHED ON THE CONSTANT, NOT THE STRING IT HOLDS. The first version of these
 * three asserted the literal "help_response" at each site. That is the
 * spelling, not the rule: lifting the five copies into one exported constant —
 * which is strictly better, because a typo in any copy is a silent CTIA
 * failure — turned all three red while every exemption they guard was intact.
 * A literal in an assertion pins the implementation it happened to find.
 */
describe("the required reply is not cancelled before it is sent", () => {
  /** The constant, or the string, so neither spelling of the same rule fails. */
  const INTENT = /(?:HELP_INTENT|"help_response")/.source;

  it("a person claiming the thread does not drop it", () => {
    const src = readFileSync("lib/messaging/scheduler.ts", "utf8");
    expect(src).toMatch(new RegExp(`const required = a\\.reply_intent === ${INTENT}`));
    expect(src).toMatch(/if \(!required && ctx\.conversationState === "human_active"\)/);
  });

  it("the customer texting again does not drop it", () => {
    const src = readFileSync("lib/messaging/scheduler-db.ts", "utf8");
    // Both staleness paths: the one that cancels older held replies...
    expect(src).toMatch(new RegExp(`reply_intent !== ${INTENT}\\)\\s*\\n?\\s*\\.map\\(\\(h\\) => h\\.id\\)`));
    // ...and the one inside sendHeldReply.
    expect(src).toMatch(new RegExp(`latest\\.id !== a\\.answers_message_id && a\\.reply_intent !== ${INTENT}`));
  });

  it("and the send marks it required, or none of the above matters", () => {
    const src = readFileSync("lib/messaging/scheduler-db.ts", "utf8");
    expect(src).toMatch(new RegExp(`required: a\\.reply_intent === ${INTENT}`));
  });

  /**
   * AND THE CONSTANT HAS ONE DEFINITION.
   *
   * The reason to lift it was that five places compare against it to decide
   * whether a send is cap-exempt and whether it may be cancelled. A second
   * declaration anywhere would put that back — two spellings that agree today
   * and need not tomorrow.
   */
  it("is declared exactly once", () => {
    const files = ["compliance", "scheduler", "scheduler-db", "record-inbound"]
      .map((f) => readFileSync(`lib/messaging/${f}.ts`, "utf8"));
    const declarations = files.flatMap((src) =>
      [...src.matchAll(/(?:const|let)\s+HELP_INTENT\s*=/g)]
    );
    expect(declarations).toHaveLength(1);
  });
});
