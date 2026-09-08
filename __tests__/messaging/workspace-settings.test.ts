import { describe, it, expect, vi, beforeEach } from "vitest";

const writes: Record<string, unknown>[] = [];
// The access check is asserted structurally in server-action-auth.test.ts and
// as a policy in the messagingAccessDenied cases there. These tests are about
// what the action does ONCE the caller is allowed in, so the guard is stubbed
// rather than reimplemented — a test that had to build a request scope to
// check a validation rule would stop being run.
vi.mock("@/lib/messaging/auth", () => ({
  assertMessagingAccess: async () => "test-user",
  messagingAccessDenied: () => false,
}));

vi.mock("@/lib/messaging/db", () => {
  const api = {
    from: () => api, update: (p: Record<string, unknown>) => { writes.push(p); return api; },
    eq: async () => ({ error: null }),
  };
  return { messagingDb: () => api };
});

const { saveWorkspaceHours } = await import("@/lib/messaging/workspace-settings");
beforeEach(() => { writes.length = 0; });

const base = { workspaceId: "w1" };

describe("workspace hours", () => {
  it("refuses an hour outside 0-23", async () => {
    const res = await saveWorkspaceHours({ ...base, quietStart: 9, quietEnd: 25 });
    expect(res.ok).toBe(false);
  });

  it("refuses a window that ends before it starts", async () => {
    const res = await saveWorkspaceHours({ ...base, quietStart: 20, quietEnd: 9 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/before/);
  });

  it("refuses half a window", async () => {
    const res = await saveWorkspaceHours({ ...base, quietStart: 9, quietEnd: "" });
    expect(res.ok).toBe(false);
  });

  it("refuses a timezone the runtime does not know", async () => {
    const res = await saveWorkspaceHours({ ...base, timeZone: "America/Nowhere" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not a timezone/);
  });

  it("accepts a real timezone", async () => {
    const res = await saveWorkspaceHours({ ...base, timeZone: "America/Los_Angeles" });
    expect(res.ok).toBe(true);
    expect(writes[0].time_zone).toBe("America/Los_Angeles");
  });

  /**
   * The important one. A wider window can be SAVED, and is reported as
   * narrower than it looks, because the clamp runs at send time — which is
   * also what protects a row edited directly in the database.
   */
  it("says so when the window is wider than the law allows", async () => {
    const res = await saveWorkspaceHours({ ...base, quietStart: 6, quietEnd: 23 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.clamped).toBe(true);
  });

  it("does not claim clamping for a window inside the bound", async () => {
    const res = await saveWorkspaceHours({ ...base, quietStart: 9, quietEnd: 20 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.clamped).toBe(false);
  });

  it("stores an empty auto-reply as null rather than an empty message", async () => {
    await saveWorkspaceHours({ ...base, afterHoursMessage: "   " });
    expect(writes[0].after_hours_message).toBeNull();
  });
});
