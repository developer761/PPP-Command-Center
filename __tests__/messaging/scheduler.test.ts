import { describe, it, expect, vi } from "vitest";
import {
  runAction, runDueActions, classifyRefusal, backoffMs, MAX_ATTEMPTS,
  type DueAction, type SchedulerDeps,
} from "@/lib/messaging/scheduler";
import type { GateResult, GateWorkspace } from "@/lib/messaging/gate";
import type { E164 } from "@/lib/messaging/phone";

const WS: GateWorkspace = {
  id: "ws", name: "NY LI Nassau Leads", phone_e164: "+15163448418",
  time_zone: "America/New_York", quiet_hours_start: 9, quiet_hours_end: 20,
  send_on_weekends: true,
};
const NOW = new Date("2026-07-15T18:00:00Z");
const action = (over: Partial<DueAction> = {}): DueAction =>
  ({ id: "a1", conversation_id: "c1", campaign_step_id: "s1", action: "send_step", attempts: 1, ...over });

type Spy = SchedulerDeps & {
  calls: { markSent: number; reschedule: number; cancel: number; fail: number };
  last: Record<string, unknown>;
};

function deps(over: Partial<SchedulerDeps> = {}): Spy {
  const calls = { markSent: 0, reschedule: 0, cancel: 0, fail: 0 };
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
    expect(quiet).toEqual({ claimed: 0, sent: 0, drafted: 0, rescheduled: 0, cancelled: 0, failed: 0, skipped: 0 });
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
});
