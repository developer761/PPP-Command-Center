import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resumeCallingIfSpent } from "@/lib/messaging/stalled-db";
import { FOLLOW_UP_COUNT } from "@/lib/messaging/stalled";

/**
 * A FOLLOW-UP THAT WENT OUT AND COULD NOT BE CLOSED LOST THE LEAD ENTIRELY.
 *
 * A45's resume hands a lead back to the call centre at the end of A44's
 * cadence, and only where the customer was never reached. Whether the cadence
 * is spent was counted as `state = 'done'` rows alone.
 *
 * `failed` is terminal — nothing re-sends it — so one failed step left the
 * count permanently short of FOLLOW_UP_COUNT, resumeAfterCadence returned
 * null, and the lead was neither texted again nor handed back. It fell out of
 * both systems in silence.
 *
 * And the commonest route to `failed` is not a failure to send at all.
 * markSent marks the row failed when the carrier ACCEPTED the message and the
 * close write would not go through — deliberately, because a row left
 * `claimed` is reclaimed and sent up to five times. On that path the customer
 * DID receive the third follow-up and the lead still disappeared.
 *
 * The stub applies the filters to fixture rows rather than returning a fixed
 * count, so what is tested is which rows the query actually counts.
 */
type Row = { state: string; action: string; conversation_id: string; run_at: string };

function stub(rows: Row[], inbounds: string[] = []) {
  const client = {
    from: (table: string) => {
      const filters: { col: string; vals: string[] }[] = [];
      let gte: string | null = null;
      const chain: Record<string, unknown> = {};
      const apply = () => rows.filter((r) =>
        filters.every(({ col, vals }) => vals.includes(String((r as unknown as Record<string, unknown>)[col])))
      );
      for (const m of ["select", "order", "limit", "is", "not", "neq"]) {
        chain[m] = () => chain;
      }
      chain.eq = (col: string, val: string) => { filters.push({ col, vals: [String(val)] }); return chain; };
      chain.in = (col: string, vals: string[]) => { filters.push({ col, vals: vals.map(String) }); return chain; };
      chain.gte = (_col: string, val: string) => { gte = val; return chain; };
      chain.then = (res: (v: unknown) => unknown) => {
        if (table === "sms_messages") {
          const n = inbounds.filter((at) => !gte || at >= gte).length;
          return Promise.resolve({ data: null, error: null, count: n }).then(res);
        }
        if (table === "sms_scheduled_actions") {
          const hit = apply();
          // The run_at lookup asks for data; the count asks for a count. Both
          // are answered, and the caller uses whichever it asked for.
          return Promise.resolve({ data: hit.map((r) => ({ run_at: r.run_at })), error: null, count: hit.length }).then(res);
        }
        return Promise.resolve({ data: null, error: null, count: 0 }).then(res);
      };
      return {
        select: (...a: unknown[]) => (chain.select as (...x: unknown[]) => unknown)(...a),
        insert: () => chain,
        update: () => chain,
      };
    },
  } as unknown as SupabaseClient;
  return client;
}

const step = (state: string, run_at: string): Row =>
  ({ state, action: "stall_followup", conversation_id: "conv-1", run_at });

const input = { conversationId: "conv-1", leadId: "lead-1" };

describe("a cadence is spent when no step will be tried again", () => {
  it("resumes calling when all three follow-ups are done", async () => {
    const rows = [step("done", "2026-10-01T14:00:00Z"), step("done", "2026-10-03T14:00:00Z"), step("done", "2026-10-06T14:00:00Z")];
    expect(rows).toHaveLength(FOLLOW_UP_COUNT);
    expect(await resumeCallingIfSpent(stub(rows), input)).toBe(true);
  });

  /** The bug: the third one sent, its close failed, and the lead vanished. */
  it("resumes calling when the last follow-up sent but could not be closed", async () => {
    const rows = [step("done", "2026-10-01T14:00:00Z"), step("done", "2026-10-03T14:00:00Z"), step("failed", "2026-10-06T14:00:00Z")];
    expect(await resumeCallingIfSpent(stub(rows), input)).toBe(true);
  });

  it("resumes calling even when every step failed, because none will be retried", async () => {
    const rows = [step("failed", "2026-10-01T14:00:00Z"), step("failed", "2026-10-03T14:00:00Z"), step("failed", "2026-10-06T14:00:00Z")];
    expect(await resumeCallingIfSpent(stub(rows), input)).toBe(true);
  });

  it("does not resume while a step is still pending", async () => {
    const rows = [step("done", "2026-10-01T14:00:00Z"), step("done", "2026-10-03T14:00:00Z"), step("pending", "2026-10-06T14:00:00Z")];
    expect(await resumeCallingIfSpent(stub(rows), input)).toBe(false);
  });

  /**
   * `cancelled` is the opposite of never being reached — something superseded
   * that step, which on this table means the customer wrote or a person took
   * the thread over. So it must NOT count towards a spent cadence.
   */
  it("does not count a cancelled step as spent", async () => {
    const rows = [step("done", "2026-10-01T14:00:00Z"), step("done", "2026-10-03T14:00:00Z"), step("cancelled", "2026-10-06T14:00:00Z")];
    expect(await resumeCallingIfSpent(stub(rows), input)).toBe(false);
  });

  /** And the other half of A45's condition is untouched: a reply stops it. */
  it("does not resume when the customer answered one of them", async () => {
    const rows = [step("done", "2026-10-01T14:00:00Z"), step("done", "2026-10-03T14:00:00Z"), step("failed", "2026-10-06T14:00:00Z")];
    expect(await resumeCallingIfSpent(stub(rows, ["2026-10-04T09:00:00Z"]), input)).toBe(false);
  });
});
