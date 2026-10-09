import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { workflowsFor } from "@/lib/messaging/enrol-core";
import { matchesAll, matchesAny } from "@/lib/messaging/rules";

/**
 * A DROPPED ERROR THAT SWITCHED THE EXIT RULES OFF.
 *
 * workflowsFor read the workflows and then their rule sets, and discarded the
 * error from both. An empty rule list matches NOTHING, which is deliberate and
 * right — matchesAll says why: an audience with no rules would otherwise enrol
 * every lead in the system.
 *
 * That makes a failed rules read safe for ENTRY. Nothing new enrols.
 *
 * It is not safe for EXIT. matchesAny on an empty list is false as well, which
 * reads as "nobody has met an exit condition", so a lead who has booked stays
 * enrolled and keeps being chased. exit-sweep.ts opens by naming exactly that
 * outcome as what it was built to stop — "the day-1 chase, the day-3 chase,
 * all of it, after somebody has already been to their house."
 *
 * So one transient failure silently restored the bug the feature removed, and
 * nothing anywhere said so. A throw is retried and alerts; this did neither.
 */
type Row = Record<string, unknown>;

function stub(opts: {
  workflows?: Row[]; workflowError?: string;
  rules?: Row[]; rulesError?: string;
}) {
  const client = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit", "range", "neq", "is"]) {
        chain[m] = () => chain;
      }
      chain.then = (res: (v: unknown) => unknown) => {
        if (table === "sms_workflows") {
          return Promise.resolve(opts.workflowError
            ? { data: null, error: { message: opts.workflowError } }
            : { data: opts.workflows ?? [], error: null }).then(res);
        }
        if (table === "sms_rules") {
          return Promise.resolve(opts.rulesError
            ? { data: null, error: { message: opts.rulesError } }
            : { data: opts.rules ?? [], error: null }).then(res);
        }
        return Promise.resolve({ data: [], error: null }).then(res);
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return client;
}

const WORKFLOW = {
  id: "wf-1", name: "Nassau nurture", campaign_id: "camp-1", workspace_id: "ws-1",
  entry_rules_id: "rs-entry", exit_rules_id: "rs-exit", is_active: true,
};
const RULES = [
  { rule_set_id: "rs-entry", field: "Status", operator: "is", values: ["Open"] },
  { rule_set_id: "rs-exit", field: "Status", operator: "is", values: ["Qualified"] },
];

describe("the premise: an empty rule set matches nothing", () => {
  const rec = { Id: "00Q1", Status: "Qualified" } as never;
  it("entry matches nothing, which is why a failed read is safe for entry", () => {
    expect(matchesAll([], rec, new Date())).toBe(false);
  });
  it("exit ALSO matches nothing, which is why it is not safe for exit", () => {
    expect(matchesAny([], rec, new Date())).toBe(false);
  });
});

describe("a failed rules read throws instead of returning no rules", () => {
  it("loads the rules when both reads succeed", async () => {
    const got = await workflowsFor(stub({ workflows: [WORKFLOW], rules: RULES }), "ws-1");
    expect(got).toHaveLength(1);
    expect(got[0].entryRules).toHaveLength(1);
    expect(got[0].exitRules, "the exit rules did not load").toHaveLength(1);
  });

  it("throws when the rules read fails, rather than reporting no exit rules", async () => {
    await expect(
      workflowsFor(stub({ workflows: [WORKFLOW], rulesError: "statement timeout" }), "ws-1")
    ).rejects.toThrow(/entry and exit rules/);
  });

  it("throws when the workflow read fails, rather than reporting no workflows", async () => {
    await expect(
      workflowsFor(stub({ workflowError: "connection reset" }), "ws-1")
    ).rejects.toThrow(/workflows/);
  });

  /**
   * And a workspace that genuinely has none is still an empty list, not an
   * error. "No workflows here" is a real answer and the commonest one — 33
   * workspaces, and the rollout is region by region.
   */
  it("returns an empty list when the workspace really has no workflows", async () => {
    expect(await workflowsFor(stub({ workflows: [] }), "ws-1")).toEqual([]);
  });

  /**
   * A workflow whose rule sets are genuinely empty is also not an error. The
   * seeded exit set can be blank before somebody fills it in, and that must
   * read as blank rather than throwing on every tick.
   */
  it("allows a workflow whose rule sets are legitimately empty", async () => {
    const got = await workflowsFor(stub({ workflows: [WORKFLOW], rules: [] }), "ws-1");
    expect(got[0].entryRules).toEqual([]);
    expect(got[0].exitRules).toEqual([]);
  });
});
