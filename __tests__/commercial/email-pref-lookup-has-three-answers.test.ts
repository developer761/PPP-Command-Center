import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

/**
 * FOUR answers, not three — and the fourth one was being mailed.
 *
 * This file used to assert three: an address, "no preference", and "we could
 * not tell". That distinction was real and worth keeping; the problem is that
 * "no preference" and "they turned it OFF" were the same answer, and the
 * dispatcher's `alwaysEmail` fallback then mailed the profile address for both.
 *
 * So for the three alwaysEmail kinds — approval_requested, approval_decided and
 * proposal-signed-for-approvers — the one person in this table with
 * `enabled = false` received approval mail anyway. She is an active admin and a
 * proposal approver, so it was not a rare path.
 *
 * The old version of this file could not have caught it: every assertion was a
 * regex over the source, and one of them pinned the buggy line
 * (`!row || row.enabled === false || !row.email`) as if it were correct, which
 * made the bug load-bearing for a green suite. The tests below RUN the function
 * against a mocked table instead, so they assert what it answers rather than
 * how it is written.
 */

let row: { email?: string; enabled?: boolean } | null = null;
let queryError: string | null = null;
let shouldThrow = false;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (shouldThrow) throw new Error("socket hang up");
            return queryError
              ? { data: null, error: { message: queryError } }
              : { data: row, error: null };
          },
        }),
      }),
    }),
  }),
}));

beforeEach(() => {
  row = null;
  queryError = null;
  shouldThrow = false;
  vi.resetModules();
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY ??= "test-key";
});

const load = async () => (await import("@/lib/notifications/email-prefs")).getEnabledNotifyEmail;

describe("getEnabledNotifyEmail answers four distinct questions", () => {
  it("an opted-in address comes back", async () => {
    row = { email: "brendan@tomcopainting.com", enabled: true };
    expect(await (await load())("u1")).toEqual({
      email: "brendan@tomcopainting.com",
      lookupFailed: false,
      optedOut: false,
    });
  });

  it("🔴 an explicit opt-out is flagged as such, NOT as an absent preference", async () => {
    // The whole bug. `optedOut` has to be visible to the caller, because
    // `email: null` alone is what `alwaysEmail` overrides.
    row = { email: "k.sutton@precisionpaintingplus.net", enabled: false };
    expect(await (await load())("u2")).toEqual({
      email: null,
      lookupFailed: false,
      optedOut: true,
    });
  });

  it("no row at all means no preference expressed — alwaysEmail may still fill it", async () => {
    row = null;
    expect(await (await load())("u3")).toEqual({
      email: null,
      lookupFailed: false,
      optedOut: false,
    });
  });

  it("a row with no address is not an opt-out", async () => {
    row = { enabled: true };
    expect(await (await load())("u4")).toEqual({
      email: null,
      lookupFailed: false,
      optedOut: false,
    });
  });

  it("a query error is 'we could not tell', and never an opt-out", async () => {
    queryError = "connection reset";
    expect(await (await load())("u5")).toEqual({
      email: null,
      lookupFailed: true,
      optedOut: false,
    });
  });

  it("a thrown query is also 'we could not tell'", async () => {
    shouldThrow = true;
    expect(await (await load())("u6")).toEqual({
      email: null,
      lookupFailed: true,
      optedOut: false,
    });
  });
});

/**
 * The dispatcher's use of it. Still source-shape — driving `notifyCommercial`
 * needs the whole bell/Slack/profile chain — but each assertion now pins the
 * DECISION rather than an incidental line, and the opt-out one would have
 * failed before the fix.
 */
const events = stripComments(readFileSync(join(process.cwd(), "lib/notifications/commercial-events.ts"), "utf8"));
const prefs = stripComments(readFileSync(join(process.cwd(), "lib/notifications/email-prefs.ts"), "utf8"));

describe("the dispatcher honours all four", () => {
  it("an opt-out beats alwaysEmail", () => {
    // THE REGRESSION: `pref.email ?? (alwaysEmail && !lookupFailed ? p.email …)`
    // with no optedOut term reaches the profile address for someone who opted out.
    expect(events).toMatch(/pref\.optedOut\s*\?\s*null/);
  });

  it("still does not fall back to the profile address when the preference is unreadable", () => {
    expect(events).toMatch(/input\.alwaysEmail && !pref\.lookupFailed/);
  });

  it("logs both skips rather than swallowing them", () => {
    expect(events).toContain("NOT treated as an opt-out");
    expect(events).toContain("turned email notifications OFF");
  });

  it("inspects the query error instead of discarding it", () => {
    expect(prefs).toMatch(/const \{ data, error \} = await sb/);
  });

  it("still writes the bell when the email is skipped", () => {
    // A preference problem must never cost the notification itself.
    const i = events.indexOf("pref.lookupFailed");
    const j = events.indexOf('.from("notifications").insert(');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    expect(j).toBeLessThan(i);
  });
});
