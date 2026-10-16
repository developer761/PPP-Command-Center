import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type Call, type Answer } from "../helpers/fake-supabase";

/**
 * `commercial_proposals.total_cents` is the contract number the AIA ladder,
 * invoicing, the customer PDF's TOTAL and the tax base all read.
 * `recomputeProposalTotal` returned `void` and read none of its queries: a
 * failed line read summed to $0 and was WRITTEN as the contract; a failed
 * proposal read dropped the override; a failed write left a stale total — and
 * every line edit said "saved".
 */

let respond: (c: Call) => Answer | undefined = () => undefined;
const calls: Call[] = [];

vi.mock("@/lib/commercial/db", () => ({
  commercialDb: () => fakeSupabase((c) => respond(c), calls).client,
}));
vi.mock("@/lib/commercial/audit-log", () => ({
  logInsert: vi.fn(async () => {}),
  logDelete: vi.fn(async () => {}),
  logUpdate: vi.fn(async () => {}),
}));
vi.mock("@/lib/notifications/after-response", () => ({ afterResponse: vi.fn() }));

type Script = { lines?: Answer; prop?: Answer; write?: Answer; override?: number | null };

function script(s: Script) {
  respond = (c) => {
    if (c.table === "commercial_proposal_line_items") {
      if (c.op === "select") {
        if (c.single) return { data: { id: "li1", proposal_id: "p1" } };
        return s.lines ?? { data: [{ quantity: 2, unit_price_cents: 50_000, is_alternate: false }] };
      }
      if (c.op === "delete") return { data: null };
    }
    if (c.table === "commercial_proposals") {
      if (c.op === "select")
        return s.prop ?? { data: { status: "draft", deleted_at: null, opportunity_id: null, final_price_override_cents: s.override ?? null } };
      if (c.op === "update") return s.write ?? { data: [{ id: "p1" }] };
    }
    return undefined;
  };
}

const totalWrites = () => calls.filter((c) => c.table === "commercial_proposals" && c.op === "update");

async function recompute() {
  const { recomputeProposalTotal } = await import("@/lib/commercial/proposals/db");
  return recomputeProposalTotal("p1", "u1");
}

describe("recomputeProposalTotal", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("writes the line sum and says what it wrote", async () => {
    script({});
    expect(await recompute()).toEqual({ ok: true, total_cents: 100_000 });
    expect((totalWrites()[0].payload as { total_cents: number }).total_cents).toBe(100_000);
  });

  it("writes the override when one is set", async () => {
    script({ override: 90_000 });
    expect(await recompute()).toEqual({ ok: true, total_cents: 90_000 });
  });

  it("writes NOTHING when the lines can't be read — never $0", async () => {
    script({ lines: { data: null, error: { message: "timeout" } } });
    const r = await recompute();
    expect(r.ok).toBe(false);
    expect(totalWrites()).toHaveLength(0);
  });

  it("writes nothing when the proposal (and so its override) can't be read", async () => {
    script({ prop: { data: null, error: { message: "timeout" } } });
    const r = await recompute();
    expect(r.ok).toBe(false);
    expect(totalWrites()).toHaveLength(0);
  });

  it("reports a failed write", async () => {
    script({ write: { data: null, error: { message: "boom" } } });
    expect((await recompute()).ok).toBe(false);
  });

  it("reports a write that matched no row", async () => {
    script({ write: { data: [] } });
    expect((await recompute()).ok).toBe(false);
  });
});

describe("a line-item edit whose re-total failed", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("says the line was removed but the total didn't move", async () => {
    script({ write: { data: null, error: { message: "boom" } } });
    const { deleteLineItem } = await import("@/lib/commercial/proposals/db");
    const r = await deleteLineItem("li1", "u1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/line was removed, but the proposal total couldn't be updated/);
  });
});
