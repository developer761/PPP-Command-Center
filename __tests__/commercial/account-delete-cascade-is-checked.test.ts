import { describe, it, expect, vi, beforeEach } from "vitest";
import { fakeSupabase, type Call, type Answer } from "../helpers/fake-supabase";

/**
 * Deleting an account soft-deleted the ACCOUNT first and then ran its deals
 * through `softDeleteCommercialOpportunity(...).catch(() => undefined)`. That
 * function RETURNS `{ ok:false }` — it does not throw — so the catch caught
 * nothing, and the account reported deleted with live deals and their invoices
 * still under it. Now the deals go first and the account only if all did.
 */

let respond: (c: Call) => Answer | undefined = () => undefined;
const calls: Call[] = [];
const deleteDeal = vi.fn<(id: string) => Promise<{ ok: true } | { ok: false; error: string }>>(async () => ({ ok: true }));

vi.mock("@/lib/commercial/db", () => ({
  commercialDb: () => fakeSupabase((c) => respond(c), calls).client,
}));
vi.mock("@/lib/commercial/audit-log", () => ({
  logInsert: vi.fn(async () => {}),
  logDelete: vi.fn(async () => {}),
  logUpdate: vi.fn(async () => {}),
}));
vi.mock("@/lib/commercial/opportunities/mutations", () => ({
  softDeleteCommercialOpportunity: (id: string) => deleteDeal(id),
}));
vi.mock("@/lib/commercial/field-ops/jobs", () => ({ cascadeDeleteJobsForOwner: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications/retire", () => ({ retireNotificationsFor: vi.fn(async () => {}) }));

const DEALS = [
  { id: "d1", title: "Lobby repaint" },
  { id: "d2", title: "Garage stripes" },
];

function script(opts: { stillLive: string[]; invoices?: Answer; deals?: Answer }) {
  let dealReads = 0;
  respond = (c) => {
    if (c.table === "commercial_accounts") {
      if (c.op === "select") return { data: { id: "acc-1", deleted_at: null } };
      if (c.op === "update") return { data: [{ id: "acc-1" }] };
    }
    if (c.table === "commercial_invoices") return opts.invoices ?? { data: [] };
    if (c.table === "commercial_opportunities") {
      dealReads += 1;
      if (dealReads === 1) return opts.deals ?? { data: DEALS };
      return { data: opts.stillLive.map((id) => ({ id })) };
    }
    return undefined;
  };
}

const accountWrites = () => calls.filter((c) => c.table === "commercial_accounts" && c.op === "update");

async function del() {
  const { softDeleteCommercialAccount } = await import("@/lib/commercial/accounts/mutations");
  return softDeleteCommercialAccount("acc-1", "u1");
}

describe("deleting an account", () => {
  beforeEach(() => {
    calls.length = 0;
    deleteDeal.mockReset().mockResolvedValue({ ok: true });
  });

  it("deletes the account once every deal under it is gone", async () => {
    script({ stillLive: [] });
    expect((await del()).ok).toBe(true);
    expect(deleteDeal).toHaveBeenCalledTimes(2);
    expect(accountWrites()).toHaveLength(1);
  });

  it("refuses — and says which deal — when a deal delete RETURNS a failure", async () => {
    deleteDeal.mockImplementation(async (id: string) =>
      id === "d2" ? { ok: false, error: "1 invoice has recorded payments" } : { ok: true },
    );
    script({ stillLive: ["d2"] });
    const r = await del();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/account was NOT deleted/);
      expect(r.error).toMatch(/Garage stripes/);
      expect(r.error).toMatch(/1 other deal was deleted/);
    }
    expect(accountWrites()).toHaveLength(0);
  });

  it("refuses when a deal delete throws", async () => {
    deleteDeal.mockRejectedValue(new Error("socket hang up"));
    script({ stillLive: ["d1", "d2"] });
    const r = await del();
    expect(r.ok).toBe(false);
    expect(accountWrites()).toHaveLength(0);
  });

  it("changes nothing when the deals can't be read", async () => {
    script({ stillLive: [], deals: { data: null, error: { message: "timeout" } } });
    const r = await del();
    expect(r.ok).toBe(false);
    expect(deleteDeal).not.toHaveBeenCalled();
    expect(accountWrites()).toHaveLength(0);
  });

  it("does not treat a failed invoice read as 'no paid invoices'", async () => {
    script({ stillLive: [], invoices: { data: null, error: { message: "timeout" } } });
    const r = await del();
    expect(r.ok).toBe(false);
    expect(deleteDeal).not.toHaveBeenCalled();
  });
});
