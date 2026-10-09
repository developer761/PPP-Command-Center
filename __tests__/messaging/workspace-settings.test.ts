import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { COPYABLE_SETTINGS, SETTING_LABELS } from "@/lib/messaging/settings-copy";

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
   * THIS USED TO ASSERT THE OPPOSITE, AND THE OPPOSITE NEVER WORKED.
   *
   * It said a wider window could be saved and reported back as narrower, with
   * the clamp doing the work at send time. But migration 178 puts
   * CHECK (quiet_hours_start BETWEEN 8 AND 20) on the column, under the
   * heading "a campaign author must not be able to configure their way past
   * these" — so 6am reached Postgres and came back as
   * sms_sub_accounts_quiet_hours_start_check.
   *
   * The test passed because it stubs the database. That is the shape worth
   * remembering: a test can only disagree with a constraint it never meets.
   */
  it("refuses an hour the column will not store, in words", async () => {
    const res = await saveWorkspaceHours({ ...base, quietStart: 6, quietEnd: 23 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/8 AM/);
  });

  it("refuses an end past the federal ceiling", async () => {
    const res = await saveWorkspaceHours({ ...base, quietStart: 9, quietEnd: 23 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/9 PM/);
  });

  it("refuses clearing the window, which the column cannot hold", async () => {
    // The old branch said "set both or neither". Neither is NOT NULL.
    const res = await saveWorkspaceHours({ ...base, quietStart: "", quietEnd: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cannot be left blank/i);
  });

  it("saves a window inside the bound", async () => {
    const res = await saveWorkspaceHours({ ...base, quietStart: 9, quietEnd: 20 });
    expect(res.ok).toBe(true);
  });

  it("stores an empty auto-reply as null rather than an empty message", async () => {
    await saveWorkspaceHours({ ...base, afterHoursMessage: "   " });
    expect(writes[0].after_hours_message).toBeNull();
  });
});

/**
 * A SETTING THE GATE ENFORCES THAT NOTHING COULD SET.
 *
 * send_on_holidays shipped on 2026-10-07 read by the gate in nine places and
 * written in none. It was absent from COPYABLE_SETTINGS and from NEVER_COPIED,
 * from the settings page's select list, from the hours form and from the patch
 * builder — so it sat at its column default of false on all thirty-three
 * workspaces, permanently, and PPP could not decide to work July 4th.
 *
 * send_on_weekends, added months earlier, had every one of those. The two are
 * twins and only one was wired.
 *
 * Asserted on the whole chain rather than one hop, because the hop that was
 * missing is the one a unit test of either end would not have noticed.
 */
describe("the holiday setting can actually be set", () => {
  const hop = (path: string) => readFileSync(path, "utf8");

  it("the patch builder writes the column", () => {
    const src = hop("lib/messaging/workspace-settings.ts");
    expect(src).toMatch(/input\.sendOnHolidays !== undefined/);
    expect(src).toMatch(/patch\.send_on_holidays = input\.sendOnHolidays/);
  });

  it("the save action accepts it", () => {
    expect(hop("lib/messaging/workspace-settings.ts")).toMatch(/sendOnHolidays\?: boolean/);
  });

  it("the form has a control and passes it to the action", () => {
    const src = hop("components/messaging/workspace-hours-form.tsx");
    expect(src, "no state for the toggle").toMatch(/useState\(!!row\.send_on_holidays\)/);
    expect(src, "no visible control").toMatch(/Send on public holidays/);
    expect(src, "the control is not passed to the action").toMatch(/sendOnHolidays:\s*holidays/);
  });

  it("the page reads the column, or the form renders it as off whatever it is", () => {
    expect(hop("app/messaging/settings/page.tsx")).toMatch(/send_on_holidays/);
  });

  /**
   * And it is classified for copying. The settings-copy module's premise is
   * that a column the gate reads is either copyable or named as regional with
   * a reason; this one was in neither list, which is precisely the drift that
   * file exists to prevent.
   */
  it("is classified as copyable company policy, like its weekend twin", () => {
    expect([...COPYABLE_SETTINGS]).toContain("send_on_holidays");
    expect(SETTING_LABELS.send_on_holidays).toBeTruthy();
  });
});
