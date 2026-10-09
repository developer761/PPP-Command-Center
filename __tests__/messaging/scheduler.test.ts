import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  runAction, runDueActions, classifyRefusal, backoffMs, MAX_ATTEMPTS,
  type DueAction, type SchedulerDeps,
} from "@/lib/messaging/scheduler";
import type { GateResult, GateWorkspace } from "@/lib/messaging/gate";
import type { E164 } from "@/lib/messaging/phone";
import { CarrierUnsubscribedError } from "@/lib/messaging/transports/twilio";

const WS: GateWorkspace = {
  id: "ws", name: "NY LI Nassau Leads", phone_e164: "+15163448418",
  time_zone: "America/New_York", quiet_hours_start: 9, quiet_hours_end: 20,
  send_on_weekends: true,
};
const NOW = new Date("2026-07-15T18:00:00Z");
const action = (over: Partial<DueAction> = {}): DueAction =>
  ({ id: "a1", conversation_id: "c1", campaign_step_id: "s1", action: "send_step", attempts: 1, ...over });

type Spy = SchedulerDeps & {
  calls: { markSent: number; markDone: number; reschedule: number; cancel: number; fail: number };
  last: Record<string, unknown>;
};

function deps(over: Partial<SchedulerDeps> = {}): Spy {
  const calls = { markSent: 0, markDone: 0, reschedule: 0, cancel: 0, fail: 0 };
  const d: Spy = {
    calls,
    last: {},
    now: NOW,
    claimDue: async () => [action()],
    resolve: async () => ({
      workspace: WS, to: "+15165550147" as E164, body: "hi",
      agent: "lead_nurture", conversationState: "ai_active",
    }),
    send: async (): Promise<GateResult> => ({ ok: true, providerId: "p1", body: "x" }),
    markSent: async () => { calls.markSent++; },
    markDone: async () => { calls.markDone++; },
    reschedule: async (_a: DueAction, at: Date, reason: string) => { calls.reschedule++; d.last = { at, reason }; },
    cancel: async (_a: DueAction, reason: string) => { calls.cancel++; d.last = { reason }; },
    fail: async (_a: DueAction, reason: string) => { calls.fail++; d.last = { reason }; },
    ...over,
  };
  return d;
}

describe("classifyRefusal — a refusal is not one thing", () => {
  it("suppression is permanent", () => {
    expect(classifyRefusal({ ok: false, reason: "suppressed" })).toBe("cancel");
  });
  it("clock-based refusals are deferrals", () => {
    for (const reason of ["quiet_hours", "weekend", "daily_cap"] as const) {
      expect(classifyRefusal({ ok: false, reason })).toBe("reschedule");
    }
  });
  it("configuration problems need a human, not a retry", () => {
    for (const reason of ["no_workspace_number", "empty_body"] as const) {
      expect(classifyRefusal({ ok: false, reason })).toBe("fail");
    }
  });
});

describe("a resolved row that should no longer send", () => {
  /**
   * Kate, 2026-09-23: "There's a campaign before a customer replies, then
   * there's a campaign if they don't reply." The outreach sequence is the
   * first one, and nothing stopped it: the exit rules watch Salesforce only,
   * so somebody mid-conversation still got "just following up on your
   * estimate request" on day 1 and again on day 3.
   */
  it("is cancelled, with its own reason rather than a borrowed one", async () => {
    const because = "the customer replied, so the outreach sequence stops here";
    const d = deps({ resolve: async () => ({ cancelBecause: because }) });
    const out = await runAction(action(), d);
    expect(out.kind).toBe("cancelled");
    expect(d.calls.cancel).toBe(1);
    // A cancelled row nobody can explain is how a sequence gets switched back
    // on by the next person to look at it.
    expect(d.last.reason).toBe(because);
    expect(d.calls.markSent).toBe(0);
  });

  it("still says 'no longer exists' when resolve genuinely finds nothing", async () => {
    const d = deps({ resolve: async () => null });
    const out = await runAction(action(), d);
    expect(out.kind).toBe("cancelled");
    expect(d.last.reason).toContain("no longer exists");
  });

  it("sends normally when resolve returns a real context", async () => {
    // Proves the branch above is a branch, not the only path.
    const d = deps();
    const out = await runAction(action(), d);
    expect(out.kind).toBe("sent");
    expect(d.calls.cancel).toBe(0);
  });
});

describe("runAction — dispositions", () => {
  it("sends and records on success", async () => {
    const d = deps();
    const out = await runAction(action(), d);
    expect(out.kind).toBe("sent");
    expect(d.calls.markSent).toBe(1);
  });

  it("CANCELS an opt-out — never reschedules it", async () => {
    const d = deps({ send: async () => ({ ok: false, reason: "suppressed" }) });
    const out = await runAction(action(), d);
    expect(out.kind).toBe("cancelled");
    expect(d.calls.cancel).toBe(1);
    // The bug this guards: a retry loop chasing someone who said STOP.
    expect(d.calls.reschedule).toBe(0);
  });

  it("reschedules quiet hours to the time the gate supplied", async () => {
    const at = new Date("2026-07-16T13:00:00Z");
    const d = deps({ send: async () => ({ ok: false, reason: "quiet_hours", retryAt: at }) });
    const out = await runAction(action(), d);
    expect(out.kind).toBe("rescheduled");
    expect((d.last.at as Date).getTime()).toBe(at.getTime());
  });

  it("falls back to an hour if the gate defers without saying when", async () => {
    // Dropping the message would be worse than guessing.
    const d = deps({ send: async () => ({ ok: false, reason: "daily_cap" }) });
    const out = await runAction(action(), d);
    expect(out.kind).toBe("rescheduled");
    expect((d.last.at as Date).getTime()).toBe(NOW.getTime() + 3600_000);
  });

  it("FAILS a workspace with no number rather than queueing it forever", async () => {
    const d = deps({ send: async () => ({ ok: false, reason: "no_workspace_number" }) });
    const out = await runAction(action(), d);
    expect(out.kind).toBe("failed");
    expect(d.calls.reschedule).toBe(0);
  });
});

describe("runAction — the race the trigger cannot cover", () => {
  it("does not send when the conversation ended AFTER the row was claimed", async () => {
    // The cancel-on-end trigger catches pending and claimed rows, but a
    // conversation can end in the gap between claim and send. This is the only
    // door it cannot cover, and it is the Monday-books-Friday-chased bug.
    const send = vi.fn();
    const d = deps({
      resolve: async () => ({ workspace: WS, to: "+15165550147" as E164, body: "still interested?", agent: "lead_nurture", conversationState: "ended" }),
      send: send as unknown as SchedulerDeps["send"],
    });
    const out = await runAction(action(), d);
    expect(out.kind).toBe("cancelled");
    expect(send).not.toHaveBeenCalled();
    expect(d.calls.cancel).toBe(1);
  });

  it("cancels when the conversation no longer exists", async () => {
    const d = deps({ resolve: async () => null });
    expect((await runAction(action(), d)).kind).toBe("cancelled");
  });
});

describe("runAction — carrier failures retry, but not forever", () => {
  it("reschedules with backoff when the transport throws", async () => {
    const d = deps({ send: async () => { throw new Error("carrier 503"); } });
    const out = await runAction(action({ attempts: 2 }), d);
    expect(out.kind).toBe("rescheduled");
    expect(d.last.reason).toBe("carrier 503");
    expect((d.last.at as Date).getTime()).toBe(NOW.getTime() + backoffMs(2));
  });

  it("gives up at MAX_ATTEMPTS instead of hammering", async () => {
    const d = deps({ send: async () => { throw new Error("carrier down"); } });
    const out = await runAction(action({ attempts: MAX_ATTEMPTS }), d);
    expect(out.kind).toBe("failed");
    expect(d.calls.reschedule).toBe(0);
  });

  it("refuses a row already past MAX_ATTEMPTS without even resolving it", async () => {
    const resolve = vi.fn();
    const d = deps({ resolve: resolve as unknown as SchedulerDeps["resolve"] });
    const out = await runAction(action({ attempts: MAX_ATTEMPTS + 1 }), d);
    expect(out.kind).toBe("failed");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("backoff climbs then caps", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(4 * 60_000);
    expect(backoffMs(20)).toBe(16 * 60_000); // capped
  });
});

describe("runDueActions — one bad row must not stop the tick", () => {
  it("keeps going when a single action throws", async () => {
    let n = 0;
    const d = deps({
      claimDue: async () => [action({ id: "a1" }), action({ id: "a2" }), action({ id: "a3" })],
      resolve: async () => { n++; if (n === 2) throw new Error("boom"); return { workspace: WS, to: "+15165550147" as E164, body: "hi", agent: "x", conversationState: "ai_active" }; },
    });
    const s = await runDueActions(d);
    expect(s.claimed).toBe(3);
    expect(s.sent).toBe(2);   // the other two still went
    expect(s.failed).toBe(1);
  });

  it("an empty queue is distinguishable from a broken one", async () => {
    // A tick that processed nothing and a tick that failed everything must not
    // look alike to whatever is watching.
    const quiet = await runDueActions(deps({ claimDue: async () => [] }));
    expect(quiet).toEqual({ claimed: 0, sent: 0, drafted: 0, held: 0, rescheduled: 0, cancelled: 0, failed: 0, skipped: 0 });
    const broken = await runDueActions(deps({ send: async () => ({ ok: false, reason: "no_workspace_number" }) }));
    expect(broken.claimed).toBe(1);
    expect(broken.failed).toBe(1);
  });
});

/**
 * An agent turn produces a REPLY, not a campaign step. While autosend is off
 * that reply goes to a person, so it must never reach the carrier on this path
 * — the gate runs when the human presses send.
 */
describe("agent turns are drafted, not sent", () => {
  const agentAction = { id: "a1", conversation_id: "c1", campaign_step_id: null, action: "agent_turn", attempts: 0 };

  it("writes a draft and never calls send", async () => {
    let sendCalled = false;
    const d = deps({
      claimDue: async () => [agentAction],
      send: async () => { sendCalled = true; return { ok: true, providerId: "p", body: "x" }; },
      draftReply: async () => ({ kind: "drafted" as const }),
    });
    const out = await runDueActions(d);
    expect(out.drafted).toBe(1);
    expect(out.sent).toBe(0);
    // The whole point: no carrier is involved in producing a draft.
    expect(sendCalled).toBe(false);
  });

  it("cancels rather than sending when the worker cannot run agent turns", async () => {
    let sendCalled = false;
    const d = deps({
      claimDue: async () => [agentAction],
      send: async () => { sendCalled = true; return { ok: true, providerId: "p", body: "x" }; },
      draftReply: undefined,
    });
    const out = await runDueActions(d);
    expect(out.cancelled).toBe(1);
    expect(sendCalled).toBe(false);
  });

  it("cancels when there is nothing worth drafting", async () => {
    const out = await runDueActions(deps({
      claimDue: async () => [agentAction],
      draftReply: async () => ({ kind: "skipped" as const, reason: "conversation has ended" }),
    }));
    expect(out.cancelled).toBe(1);
    expect(out.drafted).toBe(0);
  });

  it("retries a draft that threw, rather than losing the turn", async () => {
    const out = await runDueActions(deps({
      claimDue: async () => [agentAction],
      draftReply: async () => { throw new Error("model timed out"); },
    }));
    expect(out.rescheduled).toBe(1);
  });

  it("still sends a campaign step normally", async () => {
    const out = await runDueActions(deps({ draftReply: async () => ({ kind: "drafted" as const }) }));
    expect(out.sent).toBe(1);
    expect(out.drafted).toBe(0);
  });
});

/**
 * Autosend is the highest-consequence switch in the system: it is the
 * difference between a bot that proposes and a bot that texts customers on its
 * own. Until it was wired it changed only the LABEL on a draft, so turning it
 * on produced a queue that still needed working and said it did not.
 */
describe("autosend, once a workspace has earned it", () => {
  const agentAction = { id: "a1", conversation_id: "c1", campaign_step_id: null, action: "agent_turn", attempts: 0 };

  it("counts an autosent reply as sent, not drafted", async () => {
    const out = await runDueActions(deps({
      claimDue: async () => [agentAction],
      draftReply: async () => ({ kind: "sent" as const, providerId: "p1", body: "hello" }),
    }));
    expect(out.sent).toBe(1);
    expect(out.drafted).toBe(0);
  });

  it("records what was actually sent, not an empty body", async () => {
    let recorded: string | null = null;
    await runDueActions(deps({
      claimDue: async () => [agentAction],
      draftReply: async () => ({ kind: "sent" as const, providerId: "p1", body: "hello there" }),
      markSent: async (_a, _p, body) => { recorded = body; },
    }));
    expect(recorded).toBe("hello there");
  });

  it("still drafts when the reply came back drafted", async () => {
    const out = await runDueActions(deps({
      claimDue: async () => [agentAction],
      draftReply: async () => ({ kind: "drafted" as const }),
    }));
    expect(out.drafted).toBe(1);
    expect(out.sent).toBe(0);
  });

  // The bug this replaced: a drafted turn was closed with markSent(a,
  // "drafted", ""), writing an empty outbound message. That told the gate we
  // had already texted the customer, so Emily's real first reply lost its
  // opt-out line, and it counted toward their daily cap.
  it("closes a drafted turn without recording a message", async () => {
    const d = deps({ claimDue: async () => [agentAction], draftReply: async () => ({ kind: "drafted" as const }) });
    await runDueActions(d);
    expect(d.calls.markSent).toBe(0);
    expect(d.calls.markDone).toBe(1);
  });
});

/**
 * Karan, 2026-09-15: Emily answers 30 to 90 seconds after the customer's text.
 * The turn writes the reply early and holds it; a send_reply row delivers it.
 */
describe("a reply held until its moment", () => {
  const agentAction = { id: "a1", conversation_id: "c1", campaign_step_id: null, action: "agent_turn", attempts: 0 };
  const heldAction = {
    id: "h1", conversation_id: "c1", campaign_step_id: null, action: "send_reply", attempts: 1,
    reply_body: "Thanks! What is the street address?", answers_message_id: "m1",
    reply_due_at: NOW.toISOString(),
  };

  it("a turn that holds its reply sends nothing and records nothing yet", async () => {
    let sendCalled = false;
    const at = new Date(NOW.getTime() + 60_000);
    const d = deps({
      claimDue: async () => [agentAction],
      send: async () => { sendCalled = true; return { ok: true, providerId: "p", body: "x" }; },
      draftReply: async () => ({ kind: "held" as const, at }),
    });
    const out = await runDueActions(d);
    expect(out.held).toBe(1);
    expect(out.sent).toBe(0);
    expect(sendCalled).toBe(false);
    expect(d.calls.markSent).toBe(0);
    expect(d.calls.markDone).toBe(1);
  });

  it("delivers the held reply and records exactly what went out", async () => {
    let recorded: string | null = null;
    const out = await runDueActions(deps({
      claimDue: async () => [heldAction],
      sendHeldReply: async () => ({ kind: "sent" as const, providerId: "p9", body: "Thanks! What is the street address?" }),
      markSent: async (_a, _p, body) => { recorded = body; },
    }));
    expect(out.sent).toBe(1);
    expect(recorded).toBe("Thanks! What is the street address?");
  });

  it("drops it, never sends late, when a person took the conversation over", async () => {
    let called = false;
    const d = deps({
      claimDue: async () => [heldAction],
      resolve: async () => ({ workspace: WS, to: "+15165550147" as E164, body: "", agent: "x", conversationState: "human_active" }),
      sendHeldReply: async () => { called = true; return { kind: "sent" as const, providerId: "p", body: "x" }; },
    });
    const out = await runDueActions(d);
    expect(called).toBe(false);
    expect(out.cancelled).toBe(1);
    expect(d.calls.reschedule).toBe(0);
  });

  it("cancels a stale reply the customer has already moved past", async () => {
    const d = deps({
      claimDue: async () => [heldAction],
      sendHeldReply: async () => ({ kind: "skipped" as const, reason: "the customer texted again before it was due" }),
    });
    const out = await runDueActions(d);
    expect(out.cancelled).toBe(1);
    expect(String(d.last.reason)).toContain("texted again");
  });

  it("a refused held reply becomes a draft, closed without a fake message", async () => {
    const d = deps({ claimDue: async () => [heldAction], sendHeldReply: async () => ({ kind: "drafted" as const }) });
    const out = await runDueActions(d);
    expect(out.drafted).toBe(1);
    expect(d.calls.markSent).toBe(0);
    expect(d.calls.markDone).toBe(1);
  });

  it("retries a held send that threw, rather than losing the reply", async () => {
    const out = await runDueActions(deps({
      claimDue: async () => [heldAction],
      sendHeldReply: async () => { throw new Error("carrier timeout"); },
    }));
    expect(out.rescheduled).toBe(1);
  });
});

describe("a person has taken the conversation over", () => {
  it("a campaign step waits rather than landing mid-conversation", async () => {
    // This is the one path that reaches the carrier. A nurture chase arriving
    // while somebody handles a complaint is the failure handing over prevents.
    const d = deps({
      resolve: async () => ({
        workspace: WS, to: "+15165550147" as E164, body: "hi",
        agent: "lead_nurture", conversationState: "human_active",
      }),
    });
    const out = await runAction(action(), d);
    expect(out.kind).toBe("rescheduled");
    expect(d.calls.cancel).toBe(0);
    expect(d.calls.markSent).toBe(0);
    expect(String(d.last.reason)).toMatch(/person has taken/i);
  });

  /**
   * AND THE DEFERRAL HAS AN END, which it did not until 2026-10-06.
   *
   * Found in production, not here: four pending actions were deferring on this
   * branch, created 2026-09-26 and still cycling ten days and roughly 240
   * reschedules later. That was every pending action in the queue. No single
   * deferral was wrong; nothing ever ended one.
   *
   * At launch scale every conversation a person touches would leave its
   * remaining steps rescheduling hourly for ever, each costing a claim, a read
   * and a write, none ever completing.
   */
  it("gives up once a person has held it past the horizon", async () => {
    const d = deps({
      resolve: async () => ({
        workspace: WS, to: "+15165550147" as E164, body: "hi",
        agent: "lead_nurture", conversationState: "human_active",
        takeoverAt: new Date(NOW.getTime() - 15 * 24 * 3600_000).toISOString(),
      }),
    });
    const out = await runAction(action(), d);
    expect(out.kind).toBe("cancelled");
    expect(d.calls.reschedule).toBe(0);
    expect(d.calls.markSent).toBe(0);
    expect(String(d.last.reason)).toMatch(/over two weeks/i);
  });

  it("still waits while the hold is recent", async () => {
    const d = deps({
      resolve: async () => ({
        workspace: WS, to: "+15165550147" as E164, body: "hi",
        agent: "lead_nurture", conversationState: "human_active",
        takeoverAt: new Date(NOW.getTime() - 2 * 24 * 3600_000).toISOString(),
      }),
    });
    expect((await runAction(action(), d)).kind).toBe("rescheduled");
  });

  /** A missing timestamp must never be read as "held for ever". */
  it("keeps deferring when there is no takeover time recorded", async () => {
    const d = deps({
      resolve: async () => ({
        workspace: WS, to: "+15165550147" as E164, body: "hi",
        agent: "lead_nurture", conversationState: "human_active",
        takeoverAt: null,
      }),
    });
    expect((await runAction(action(), d)).kind).toBe("rescheduled");
  });

  it("it is deferred, not dropped — they may hand it straight back", async () => {
    const d = deps({
      resolve: async () => ({
        workspace: WS, to: "+15165550147" as E164, body: "hi",
        agent: "lead_nurture", conversationState: "human_active",
      }),
    });
    const out = await runAction(action(), d);
    expect(out.kind).toBe("rescheduled");
    if (out.kind !== "rescheduled") throw new Error("expected a reschedule");
    expect(out.at.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("an ordinary conversation still sends — the guard is not catching everything", async () => {
    // Control. Without this the two assertions above pass if runAction has
    // simply stopped sending anything at all.
    const d = deps();
    const out = await runAction(action(), d);
    expect(out.kind).toBe("sent");
    expect(d.calls.markSent).toBe(1);
  });

  it("an ended conversation is still cancelled, not deferred", async () => {
    const d = deps({
      resolve: async () => ({
        workspace: WS, to: "+15165550147" as E164, body: "hi",
        agent: "lead_nurture", conversationState: "ended",
      }),
    });
    const out = await runAction(action(), d);
    expect(out.kind).toBe("cancelled");
  });
});

/** An email step was recorded in the thread as a text. */
describe("what went out is recorded on the channel it went out on", () => {
  it("records an email step as email", async () => {
    let channel: string | undefined;
    await runDueActions(deps({
      resolve: async () => ({
        workspace: WS, to: "+15165550147" as E164, body: "hi", agent: "campaign",
        conversationState: "ai_active", channel: "email", toEmail: "c@example.com",
        fromEmail: "hello@precisionpaintingplus.net", subject: "Your estimate",
      }),
      markSent: async (_a, _p, _b, ch) => { channel = ch; },
    }));
    expect(channel).toBe("email");
  });

  it("records a text step as sms", async () => {
    let channel: string | undefined;
    await runDueActions(deps({ markSent: async (_a, _p, _b, ch) => { channel = ch; } }));
    expect(channel).toBe("sms");
  });
});

/**
 * A DEFERRAL IS NOT AN ATTEMPT.
 *
 * `attempts` increments when a row is claimed and nothing reset it, so every
 * deferral spent one of the five tries a row gets. With the opt-out list not
 * yet imported the gate defers EVERY send, so an opener was refused hourly and
 * permanently failed about five hours later — instead of waiting for the
 * import, which is the whole thing classifyRefusal promises.
 */
describe("being told to wait does not use up the tries", () => {
  const rescheduleSpy = () => {
    const seen: Array<{ why: string; attempts: number }> = [];
    const d = deps({
      reschedule: async (a: DueAction, _at: Date, _r: string, why: "error" | "deferral") => {
        seen.push({ why, attempts: a.attempts });
      },
    });
    return { d, seen };
  };

  it("calls quiet hours a deferral", async () => {
    const { d, seen } = rescheduleSpy();
    await runAction(action(), { ...d, send: async () => ({ ok: false, reason: "quiet_hours" }) });
    expect(seen[0].why).toBe("deferral");
  });

  it("calls an unimported opt-out list a deferral — the one that is live today", async () => {
    const { d, seen } = rescheduleSpy();
    await runAction(action(), { ...d, send: async () => ({ ok: false, reason: "suppression_list_empty" }) });
    expect(seen[0].why).toBe("deferral");
  });

  it("calls a person holding the conversation a deferral", async () => {
    const { d, seen } = rescheduleSpy();
    await runAction(action(), {
      ...d,
      resolve: async () => ({
        workspace: WS, to: "+15165550147" as E164, body: "hi",
        agent: "lead_nurture", conversationState: "human_active",
      }),
    });
    expect(seen[0].why).toBe("deferral");
  });

  it("calls a carrier that threw an error, because something IS broken", async () => {
    const { d, seen } = rescheduleSpy();
    await runAction(action(), { ...d, send: async () => { throw new Error("socket hang up"); } });
    expect(seen[0].why).toBe("error");
  });

  it("a row deferred at the cap is still deferred, not failed", async () => {
    // The shape that killed messages: attempts is already at the ceiling
    // BECAUSE of deferrals, and the next deferral failed it permanently.
    const { d, seen } = rescheduleSpy();
    const out = await runAction(action({ attempts: MAX_ATTEMPTS }), {
      ...d, send: async () => ({ ok: false, reason: "suppression_list_empty" }),
    });
    expect(out.kind).toBe("rescheduled");
    expect(seen[0].why).toBe("deferral");
    expect(d.calls.fail).toBe(0);
  });
});

/**
 * An Anthropic outage must not answer the customer with silence.
 */
describe("a model that could not be reached is retried, not cancelled", () => {
  const turn = () => action({ action: "agent_turn", campaign_step_id: null });

  it("reschedules when the agent dep throws, and never cancels", async () => {
    const d = deps({ draftReply: async () => { throw new Error("Rate limited — try again shortly."); } });
    const out = await runAction(turn(), d);
    expect(out.kind).toBe("rescheduled");
    // The bug: cancel is terminal, so the customer was never answered and
    // nothing reported it — a cancel is not counted as a failure.
    expect(d.calls.cancel).toBe(0);
    expect(d.calls.reschedule).toBe(1);
  });

  it("spends an attempt on it, so a genuinely broken turn still stops", async () => {
    const seen: string[] = [];
    const d = deps({
      draftReply: async () => { throw new Error("boom"); },
      reschedule: async (_a: DueAction, _at: Date, _r: string, why: "error" | "deferral") => { seen.push(why); },
    });
    await runAction(turn(), d);
    expect(seen[0]).toBe("error");
  });

  it("gives up honestly at the cap — failed, not cancelled", async () => {
    const d = deps({ draftReply: async () => { throw new Error("still down"); } });
    const out = await runAction(action({ action: "agent_turn", campaign_step_id: null, attempts: MAX_ATTEMPTS }), d);
    expect(out.kind).toBe("failed");
    expect(d.calls.fail).toBe(1);
  });

  it("still cancels when the agent's own validator refused the reply", async () => {
    // Semantic, not transient: the same input will be refused next minute too.
    const d = deps({ draftReply: async () => ({ kind: "skipped" as const, reason: "banned phrase: guarantee" }) });
    const out = await runAction(turn(), d);
    expect(out.kind).toBe("cancelled");
    expect(d.calls.cancel).toBe(1);
  });
});

/**
 * A REASON THAT CLEARS BY ITSELF IS NOT A REASON TO GIVE UP.
 *
 * Every skip from draftReply used to be cancelled, and several of those skips
 * describe a passing state. Confirmed in production 2026-10-06: of the three
 * A44 cadences that have ever run, NONE can complete.
 *
 *   conversation 022606b8…  step 1 done
 *                           step 2 cancelled "a reply is already
 *                           step 3 cancelled  waiting for review"
 *
 * The damage outlives the cadence. It cannot be re-queued — stalled-db counts
 * non-cancelled rows and step 1 is done — and resumeCallingIfSpent needs three
 * DONE steps before the call centre is told it may dial again. The lead is
 * neither chased nor called, which is the exact dead end A44 and A45 exist to
 * close, produced by the machinery built to close it.
 */
describe("a stall follow-up blocked by something temporary", () => {
  const stall = (over: Partial<DueAction> = {}): DueAction => ({
    id: "s1", conversation_id: "c1", campaign_step_id: null,
    action: "stall_followup", attempts: 0, stall_step: 2, ...over,
  });

  it.each([
    "a reply is already waiting for review",
    "a person has taken this conversation over",
    "handed to a person: question_left_unanswered: …",
  ])("defers rather than cancelling: %s", async (reason) => {
    const d = deps({
      claimDue: async () => [stall()],
      draftReply: async () => ({ kind: "skipped" as const, reason, retryable: true }),
    });
    const out = await runDueActions(d);
    expect(out.cancelled).toBe(0);
    expect(d.calls.reschedule).toBe(1);
  });

  /**
   * The attempt is given BACK. attempts increments on claim, so a deferral
   * that spent one would fail the row after five quiet hours — the bug the
   * `why` parameter exists to prevent. The default spy does not record `why`,
   * so this one captures it.
   */
  it("spends no attempt on such a deferral", async () => {
    let why: string | undefined;
    const d = deps({
      claimDue: async () => [stall()],
      draftReply: async () => ({
        kind: "skipped" as const, reason: "a reply is already waiting for review", retryable: true,
      }),
      reschedule: async (_a: DueAction, _at: Date, _r: string, w: "error" | "deferral") => { why = w; },
    });
    await runDueActions(d);
    expect(why).toBe("deferral");
  });

  /**
   * AND A REASON THAT IS TRUE FOR EVER STILL CANCELS. Without this the fix
   * would just be the unbounded-deferral bug wearing a different hat.
   */
  it.each([
    "conversation has ended",
    "conversation no longer exists",
    "somebody has already answered the customer",
    "handed to a person after 20 replies (max_turns is 20)",
  ])("still cancels: %s", async (reason) => {
    const d = deps({
      claimDue: async () => [stall()],
      draftReply: async () => ({ kind: "skipped" as const, reason }),
    });
    const out = await runDueActions(d);
    expect(out.cancelled).toBe(1);
    expect(d.calls.reschedule).toBe(0);
  });
});

/**
 * A TICK THAT RUNS OUT OF TIME MUST NOT FAIL MESSAGES NOBODY TRIED.
 *
 * `sms_claim_due_actions` increments `attempts` on the CLAIM, and
 * `sms_reclaim_stale_actions` returns an abandoned row to pending without
 * giving it back. So a tick that claims 50 slow rows and dies at 300s costs
 * every unreached row an attempt, and six such ticks fail a message that was
 * never once attempted.
 *
 * Refunding on reclaim would be the obvious fix and is wrong — the migration
 * says why: a row that crashed AFTER the carrier accepted is indistinguishable
 * from one the tick never reached, and refunding both lets the first retry for
 * ever. A duplicate text is worse than a late one. So the tick stops starting
 * work it cannot finish instead.
 */
describe("the tick stops before it runs out of time", () => {
  it("does not start rows it has no time to finish", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => action({ id: `t${i}` }));
    let started = 0;
    // Each action eats a quarter of the budget, so it gets through four and
    // then stops rather than being killed mid-way through the tenth.
    const d = deps({
      claimDue: async () => rows,
      resolve: async () => { started++; await new Promise((r) => setTimeout(r, 60)); return null; },
    });
    const out = await runDueActions(d, 10, 150);   // 150ms of budget
    expect(out.claimed).toBe(10);
    expect(started).toBeLessThan(10);
    // Everything claimed is accounted for, so the summary never under-reports.
    const seen = out.sent + out.drafted + out.held + out.rescheduled
      + out.cancelled + out.failed + out.skipped;
    expect(seen).toBe(10);
  }, 20_000);

  it("processes the whole batch when there is time", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => action({ id: `q${i}` }));
    const d = deps({ claimDue: async () => rows, resolve: async () => null });
    const out = await runDueActions(d, 5);
    expect(out.claimed).toBe(5);
    expect(out.cancelled + out.skipped).toBe(5);
  });
});

/**
 * A CARRIER-LEVEL OPT-OUT IS NOT A TRANSIENT ERROR.
 *
 * Twilio keeps its own suppression list and enforces it before we do. Code
 * 21610 means the person is on it and NOT in sms_opt_outs — the two lists
 * have drifted. twilio.ts said exactly that in a comment, "not a transient
 * error, and retrying it will fail forever", and then threw a plain Error,
 * which this scheduler read as transient: five retries, then failed, and the
 * number never written down. Every other workspace went on trying them.
 */
describe("the carrier says they are unsubscribed", () => {
  const boom = () => {
    throw new CarrierUnsubscribedError("+15165550147", "Twilio 400: on Twilio's own opt-out list");
  };

  it("cancels instead of retrying", async () => {
    const d = deps({ claimDue: async () => [action()], send: async () => boom() });
    const out = await runDueActions(d);
    expect(out.cancelled).toBe(1);
    expect(d.calls.reschedule).toBe(0);
    expect(d.calls.fail).toBe(0);
  });

  it("writes the number to our own list, so the next workspace is stopped by the gate", async () => {
    let suppressed: string | null = null;
    const d = deps({
      claimDue: async () => [action()],
      send: async () => boom(),
      onCarrierSuppressed: async (_a, to) => { suppressed = to; },
    });
    await runDueActions(d);
    expect(suppressed).toBe("+15165550147");
  });

  /** Recording is best effort — failing to write it must not resurrect a retry. */
  it("still cancels when the suppression cannot be recorded", async () => {
    const d = deps({
      claimDue: async () => [action()],
      send: async () => boom(),
      onCarrierSuppressed: async () => { throw new Error("database down"); },
    });
    const out = await runDueActions(d);
    expect(out.cancelled).toBe(1);
    expect(d.calls.reschedule).toBe(0);
  });

  /** An ordinary carrier failure is still transient. */
  it("still retries a plain carrier error", async () => {
    const d = deps({
      claimDue: async () => [action()],
      send: async () => { throw new Error("Twilio 503: service unavailable"); },
    });
    const out = await runDueActions(d);
    expect(out.rescheduled).toBe(1);
    expect(d.calls.cancel).toBe(0);
  });
});

/**
 * "TRUE NOW AND NOT FOREVER" WAS TAKEN ON TRUST, AND FOR ONE REASON IT WAS
 * FOREVER.
 *
 * The deferral above is right, and the comment beside it claimed the
 * human_active horizon still ends anything a person keeps. It does not end
 * this one: that horizon is measured from ctx.takeoverAt, and a draft nobody
 * ever opened has no takeover. Nothing ages a pending draft out either —
 * `superseded` is a state no code in lib/ or app/ writes — and a "deferral"
 * reschedule refunds the attempt, so MAX_ATTEMPTS is never reached.
 *
 * So a stall follow-up behind an abandoned draft deferred hourly with no
 * bound at all: the same production rows that branch was written to rescue,
 * stuck in a different state.
 */
describe("a deferral that would never end is ended", () => {
  const stuck = (over: Partial<DueAction> = {}): DueAction => ({
    id: "s9", conversation_id: "c9", campaign_step_id: null,
    action: "stall_followup", attempts: 0, stall_step: 3, ...over,
  });
  const blocked = (blockedSince: string | null) => ({
    kind: "skipped" as const,
    reason: "a reply is already waiting for review",
    retryable: true,
    blockedSince,
  });
  const daysBefore = (n: number) =>
    new Date(NOW.getTime() - n * 24 * 3600_000).toISOString();

  it("still defers while the wait is recent", async () => {
    const d = deps({ claimDue: async () => [stuck()], draftReply: async () => blocked(daysBefore(3)) });
    await runDueActions(d);
    expect(d.calls.reschedule).toBe(1);
    expect(d.calls.fail).toBe(0);
  });

  it("stops deferring once the draft has sat for over two weeks", async () => {
    const d = deps({ claimDue: async () => [stuck()], draftReply: async () => blocked(daysBefore(15)) });
    await runDueActions(d);
    expect(d.calls.reschedule).toBe(0);
    expect(d.calls.fail).toBe(1);
  });

  /**
   * FAILED, NOT CANCELLED, and that is the whole point of the choice.
   * Cancelling is what produced the original dead end — stalled-db will not
   * re-queue a cadence whose steps are cancelled, and a cancelled step does
   * not count towards a spent one either, so the lead was neither chased nor
   * called. A failed step DOES count, so the cadence completes and
   * resumeCallingIfSpent hands the lead back to the call centre, which is the
   * right answer for a thread the bot cannot advance and nobody is reviewing.
   */
  it("fails rather than cancelling, so the lead reaches the call centre", async () => {
    const d = deps({ claimDue: async () => [stuck()], draftReply: async () => blocked(daysBefore(30)) });
    await runDueActions(d);
    expect(d.calls.cancel).toBe(0);
    expect(d.calls.fail).toBe(1);
    expect(d.last.reason).toMatch(/over two weeks/);
  });

  /**
   * A missing timestamp must not be read as "infinitely old" — that would
   * fail every deferral the moment a caller forgot the field. Unknown means
   * keep waiting, which is what the behaviour was before this existed.
   */
  it("keeps deferring when nothing says when the wait began", async () => {
    const d = deps({ claimDue: async () => [stuck()], draftReply: async () => blocked(null) });
    await runDueActions(d);
    expect(d.calls.reschedule).toBe(1);
    expect(d.calls.fail).toBe(0);
  });

  it("is not thrown off by an unparseable timestamp", async () => {
    const d = deps({ claimDue: async () => [stuck()], draftReply: async () => blocked("not a date") });
    await runDueActions(d);
    expect(d.calls.reschedule).toBe(1);
    expect(d.calls.fail).toBe(0);
  });
});

/**
 * THE BUDGET WAS SPENT BEFORE IT STARTED COUNTING.
 *
 * runDueActions exists to stop claiming work the lambda has no time to
 * finish, because `sms_claim_due_actions` increments attempts on the CLAIM and
 * `sms_reclaim_stale_actions` never gives them back — six abandoned ticks
 * produce "gave up after 6 attempts" about a send nobody tried.
 *
 * It measured from its own first line. By then the tick route has made four
 * Salesforce round trips: the lead poll, the exit sweep, the service-zip
 * refresh and the opt-out writeback. None counted. So a slow Salesforce day
 * could spend 90 seconds, hand over, and this would budget a further 240
 * against a maxDuration of 300 — killed mid-tick, every claimed row abandoned,
 * and the three sweeps after it never run. The failure the budget was written
 * to prevent, produced by the budget.
 */
describe("the tick budget is spent against the lambda, not against itself", () => {
  const tiny = (over: Partial<DueAction> = {}): DueAction => ({
    id: "b1", conversation_id: "c1", campaign_step_id: null,
    action: "stall_followup", attempts: 0, stall_step: 1, ...over,
  });

  it("works through the queue when there is budget left", async () => {
    let claimCalls = 0;
    const d = deps({
      claimDue: async () => { claimCalls++; return [tiny()]; },
      draftReply: async () => ({ kind: "skipped" as const, reason: "conversation has ended" }),
    });
    const out = await runDueActions(d, 50, 240_000, Date.now());
    expect(claimCalls).toBe(1);
    expect(out.outOfTimeBeforeClaiming).toBeFalsy();
  });

  /**
   * THE HALF THAT COST ATTEMPTS. The per-row check only runs after claimDue
   * has already taken up to fifty rows, and the claim is what increments
   * attempts — so a tick arriving with no budget burned an attempt on fifty
   * messages it never looked at, every minute, until they failed.
   */
  it("claims NOTHING when the lambda has already spent the budget", async () => {
    let claimCalls = 0;
    const d = deps({ claimDue: async () => { claimCalls++; return [tiny()]; } });
    // The lambda started four minutes and one second ago.
    const out = await runDueActions(d, 50, 240_000, Date.now() - 240_001);
    expect(claimCalls, "rows were claimed with no time to run them").toBe(0);
    expect(out.claimed).toBe(0);
    expect(out.outOfTimeBeforeClaiming).toBe(true);
  });

  /**
   * And it is reported as its own thing. A tick with nothing due is healthy; a
   * tick that never reached the queue means the work in front of it is eating
   * the lambda, and the two need opposite responses.
   */
  it("distinguishes out-of-time from a quiet queue", async () => {
    const quiet = await runDueActions(deps({ claimDue: async () => [] }), 50, 240_000, Date.now());
    expect(quiet.claimed).toBe(0);
    expect(quiet.outOfTimeBeforeClaiming).toBeFalsy();
  });

  it("the tick route measures from the start of the request", () => {
    const src = readFileSync("app/api/cron/messaging-tick/route.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // Taken before any Salesforce work, and handed to runDueActions.
    expect(src).toMatch(/const lambdaStartedAt = Date\.now\(\)/);
    expect(src, "runDueActions is not told when the lambda started")
      .toMatch(/runDueActions\([\s\S]{0,120}lambdaStartedAt/);
    /**
     * And taken before the Salesforce work, not after it — otherwise the
     * prelude still costs nothing and the change is decoration.
     *
     * Against the first CALL, `await getSalesforceClient`, rather than the
     * bare name: the first occurrence of that is the import at the top of the
     * file, which is before everything, so the first version of this
     * assertion passed on a fact about import order.
     */
    expect(src.indexOf("lambdaStartedAt = Date.now()"))
      .toBeLessThan(src.indexOf("await getSalesforceClient"));
  });
});

/**
 * A CADENCE IS A SEQUENCE, AND run_at HAD STOPPED GUARANTEEING IT.
 *
 * sms_claim_due_actions orders only by run_at, and every deferral pushes ONE
 * row forward an hour — so two steps deferring at different moments drift
 * apart. Both live cadences in production were inverted when this was found:
 *
 *   conversation 90d11ce5   step 2 at 17:32, step 3 at 17:07
 *   conversation f55e914b   step 2 at 17:32, step 3 at 17:08
 *
 * Step 3 twenty five minutes ahead of step 2. The follow-ups escalate, so the
 * customer reads them backwards — and onCadenceSpent fires on the LAST step,
 * so the lead would be handed back to the call centre and THEN texted again.
 */
describe("a follow-up waits for the earlier steps of its own cadence", () => {
  const step = (n: number): DueAction => ({
    id: `st${n}`, conversation_id: "c-cad", campaign_step_id: null,
    action: "stall_followup", attempts: 0, stall_step: n,
  });

  it("defers when an earlier step is still pending", async () => {
    const d = deps({
      claimDue: async () => [step(3)],
      earlierStepPending: async () => true,
      draftReply: async () => ({ kind: "sent" as const, providerId: "p9", body: "x" }),
    });
    const out = await runDueActions(d);
    expect(d.calls.reschedule, "step 3 went out ahead of step 2").toBe(1);
    expect(d.calls.markSent).toBe(0);
    expect(out.sent).toBe(0);
  });

  it("runs when nothing earlier is outstanding", async () => {
    const d = deps({
      claimDue: async () => [step(3)],
      earlierStepPending: async () => false,
      draftReply: async () => ({ kind: "sent" as const, providerId: "p9", body: "x" }),
    });
    await runDueActions(d);
    expect(d.calls.markSent).toBe(1);
    expect(d.calls.reschedule).toBe(0);
  });

  /**
   * AND THE HAND-BACK MUST NOT FIRE EARLY. onCadenceSpent runs on the last
   * step; firing it while an earlier text is still queued tells the phone team
   * the cadence is finished and then sends another message.
   */
  it("does not hand the lead back while an earlier step is queued", async () => {
    let handedBack = 0;
    const d = deps({
      claimDue: async () => [step(3)],
      earlierStepPending: async () => true,
      draftReply: async () => ({ kind: "sent" as const, providerId: "p9", body: "x" }),
      onCadenceSpent: async () => { handedBack++; },
    });
    await runDueActions(d);
    expect(handedBack, "told the call centre the cadence was spent too early").toBe(0);
  });

  /** A step with no number cannot be ordered, so it is left alone. */
  it("leaves an unnumbered action alone", async () => {
    const d = deps({
      claimDue: async () => [{ ...step(1), stall_step: null }],
      earlierStepPending: async () => true,
      draftReply: async () => ({ kind: "sent" as const, providerId: "p9", body: "x" }),
    });
    await runDueActions(d);
    expect(d.calls.markSent).toBe(1);
  });

  /** A worker that cannot answer the question behaves exactly as before. */
  it("is unchanged when the dep is absent", async () => {
    const d = deps({
      claimDue: async () => [step(3)],
      draftReply: async () => ({ kind: "sent" as const, providerId: "p9", body: "x" }),
    });
    await runDueActions(d);
    expect(d.calls.markSent).toBe(1);
  });
});
