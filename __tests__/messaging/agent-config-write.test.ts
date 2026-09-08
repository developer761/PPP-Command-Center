import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The write path for the agent's rules.
 *
 * Karan asked whether the rules can be edited whenever he wants and take
 * effect instantly. They can — config is read per turn — which makes the
 * validation here the only thing standing between a typo and every workspace
 * inheriting it.
 */
const state: { rows: Record<string, unknown>[] } = { rows: [] };

// The access check is asserted structurally in server-action-auth.test.ts and
// as a policy in the messagingAccessDenied cases there. These tests are about
// what the action does ONCE the caller is allowed in, so the guard is stubbed
// rather than reimplemented — a test that had to build a request scope to
// check a validation rule would stop being run.
vi.mock("@/lib/messaging/auth", () => ({
  assertMessagingAccess: async () => "test-user",
  messagingAccessDenied: () => false,
}));

vi.mock("@/lib/messaging/db", () => ({
  messagingDb: () => {
    const api = {
      from: () => api,
      select: () => api,
      eq: () => api,
      is: () => api,
      order: () => api,
      maybeSingle: async () => ({ data: state.rows[0] ?? null }),
      update: (patch: Record<string, unknown>) => { state.rows.push({ __update: patch }); return api; },
      insert: (row: Record<string, unknown>) => { state.rows.push({ __insert: row }); return api; },
      delete: () => { state.rows.push({ __delete: true }); return api; },
      then: (r: (v: { error: null }) => unknown) => r({ error: null }),
    };
    return api;
  },
}));

const { saveAgentConfig } = await import("@/lib/messaging/agent-config-write");

beforeEach(() => { state.rows = []; });

describe("editing the agent's rules", () => {
  it("refuses a confidence threshold outside 0 to 1", async () => {
    const res = await saveAgentConfig({
      where: { scope: "global" }, track: "new_lead",
      values: { confidence_threshold: 1.5 },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/between 0 and 1/);
  });

  it("refuses a fractional max turns", async () => {
    const res = await saveAgentConfig({
      where: { scope: "global" }, track: "new_lead", values: { max_turns: 12.5 },
    });
    expect(res.ok).toBe(false);
  });

  it("refuses to leave the global default without a name", async () => {
    const res = await saveAgentConfig({
      where: { scope: "global" }, track: "new_lead", values: { persona_name: "   " },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cannot be blank|needs a name/i);
  });

  it("lets a STATE clear a field, because it has somewhere to inherit from", async () => {
    const res = await saveAgentConfig({
      where: { scope: "state", stateCode: "NY" }, track: "new_lead",
      values: { office_location: "" },
    });
    expect(res.ok).toBe(true);
    const written = state.rows.find((r) => "__insert" in r || "__update" in r);
    const patch = (written as { __insert?: Record<string, unknown>; __update?: Record<string, unknown> });
    // Cleared means inherit — NULL, never the empty string.
    expect((patch.__insert ?? patch.__update)!.office_location).toBeNull();
  });

  it("writes nothing at all when given nothing", async () => {
    const res = await saveAgentConfig({ where: { scope: "global" }, track: "new_lead", values: {} });
    expect(res.ok).toBe(false);
    expect(state.rows.some((r) => "__insert" in r || "__update" in r)).toBe(false);
  });

  it("ignores a field that is not on the editable list", async () => {
    await saveAgentConfig({
      where: { scope: "global" }, track: "new_lead",
      // autosend is deliberately not editable: switching a workspace to send
      // by itself is earned after a clean run, not typed into a form.
      values: { persona_name: "Emily", autosend: true } as never,
    });
    const written = state.rows.find((r) => "__insert" in r || "__update" in r) as
      { __insert?: Record<string, unknown>; __update?: Record<string, unknown> };
    const patch = (written.__insert ?? written.__update)!;
    expect(patch).not.toHaveProperty("autosend");
    expect(patch.persona_name).toBe("Emily");
  });
});
