import { describe, it, expect, vi } from "vitest";
import { fakeSupabase, type Call, type Answer } from "../helpers/fake-supabase";

/**
 * The deal page read retainage with `.catch(() => 0)` and AIA applications
 * with `.catch(() => [])`. A failed read therefore said "no retainage held"
 * — so the next-step card offered "Mark it completed" on a job with money
 * still out — and "no AIA billing", so the Invoices tab offered "Create the
 * first invoice" on a job already billed six figures through AIA. Worse, the
 * plain AIA reads answered `[]` on an error WITHOUT throwing, so neither catch
 * was ever reached. Unknown must stay unknown, all the way to the screen.
 */

let respond: (c: Call) => Answer | undefined = () => undefined;
vi.mock("@/lib/commercial/db", () => ({
  commercialDb: () => fakeSupabase((c) => respond(c)).client,
}));

describe("money-clear on a won job", () => {
  it("is unknown — not clear — when the retainage read failed", async () => {
    const { moneyClearFrom } = await import("@/lib/commercial/opportunities/attention");
    expect(moneyClearFrom(0, null)).toBeNull();
  });

  it("is still 'money out' on an open balance, whatever retainage says", async () => {
    const { moneyClearFrom } = await import("@/lib/commercial/opportunities/attention");
    expect(moneyClearFrom(5_000, null)).toBe(false);
    expect(moneyClearFrom(5_000, 0)).toBe(false);
  });

  it("is clear only when both are known to be zero", async () => {
    const { moneyClearFrom } = await import("@/lib/commercial/opportunities/attention");
    expect(moneyClearFrom(0, 0)).toBe(true);
    expect(moneyClearFrom(0, 950_00)).toBe(false);
  });

  it("never offers 'Mark it completed' while the money is unknown", async () => {
    const { nextStep } = await import("@/lib/commercial/opportunities/attention");
    const step = nextStep({
      oppId: "opp-1",
      status: "billing",
      subStatus: null,
      proposalCount: 1,
      sentProposalCount: 1,
      approvedNotSentCount: 0,
      closeoutComplete: true,
      moneyClear: null,
    });
    expect(step?.label).not.toBe("Mark it completed");
    expect(step?.why).toMatch(/couldn't be loaded/);
  });
});

describe("strict AIA reads", () => {
  it("throw on a failed read instead of answering 'no applications'", async () => {
    respond = () => ({ data: null, error: { message: "timeout" } });
    const { listAiaApplications } = await import("@/lib/commercial/aia/db");
    await expect(listAiaApplications("opp-1", { strict: true })).rejects.toThrow(/couldn't be read/);
    // The default stays tolerant for the many callers that render an empty list.
    await expect(listAiaApplications("opp-1")).resolves.toEqual([]);
  });

  it("make retainage throw when the certificate's lines can't be read", async () => {
    // Applications read fine; the line items do not. Non-strict, this came
    // back as "no lines" and so $0 retainage held.
    respond = (c) => {
      if (c.table === "commercial_aia_applications")
        return { data: [{ id: "a1", opportunity_id: "opp-1", application_number: 1, status: "submitted", retainage_pct: 10, original_contract_cents: 100_000 }] };
      return { data: null, error: { message: "timeout" } };
    };
    const { retainageHeldForOpportunity } = await import("@/lib/commercial/aia/db");
    await expect(retainageHeldForOpportunity("opp-1", { strict: true })).rejects.toThrow();
    await expect(retainageHeldForOpportunity("opp-1")).resolves.toBe(0);
  });
});
