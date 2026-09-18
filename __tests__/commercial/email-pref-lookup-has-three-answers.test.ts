import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "Opted out" and "we could not tell" are different answers.
 *
 * `getEnabledNotifyEmail` destructured the query's `error` away and its catch
 * returned null, so a blip on `commercial_user_email_prefs` was
 * indistinguishable from a deliberate opt-out — and nothing logged. Four people
 * are opted in today (Brendan, Stephanie, Katie, developer@), so that silently
 * downgraded real users to bell-only for the duration of any wobble, with no
 * trace anywhere.
 *
 * The fix is NOT to fall back to the profile address on failure. One of the
 * five rows is an explicit `enabled = false`; emailing anyway on an unreadable
 * table would send unsolicited mail to the one person who asked not to receive
 * it. A missed notification is recoverable — that is not. So the email is
 * skipped, the failure is logged, and the BELL still lands.
 *
 * This is a source-shape test. The suite is deliberately DB-free, so it cannot
 * induce a real query error; what it can do is stop the three-way answer from
 * being collapsed back into two, which is the whole defect.
 */

const prefs = readFileSync(join(process.cwd(), "lib/notifications/email-prefs.ts"), "utf8");
const events = readFileSync(join(process.cwd(), "lib/notifications/commercial-events.ts"), "utf8");

describe("getEnabledNotifyEmail", () => {
  it("returns whether the lookup failed, not just an address", () => {
    expect(prefs).toContain("lookupFailed");
    expect(prefs).toMatch(/Promise<\{\s*email: string \| null;\s*lookupFailed: boolean;?\s*\}>/);
  });

  it("inspects the query error instead of discarding it", () => {
    // THE REGRESSION: `const { data } = await sb…` with no `error`.
    expect(prefs).toMatch(/const \{ data, error \} = await sb/);
    expect(prefs).toMatch(/if \(error\)[\s\S]{0,200}lookupFailed: true/);
  });

  it("treats a genuine opt-out as a decision, not a failure", () => {
    // No row / disabled / no address must be `lookupFailed: false`, or every
    // user without a preference looks like an outage.
    expect(prefs).toMatch(/!row \|\| row\.enabled === false \|\| !row\.email\)\s*return \{ email: null, lookupFailed: false \}/);
  });

  it("says something when it cannot tell", () => {
    // Silence is what made this survive.
    expect(prefs).toContain("console.warn");
  });
});

describe("the dispatcher's use of it", () => {
  it("does not fall back to the profile address when the preference is unreadable", () => {
    // `alwaysEmail` exists so an approver is never left with only a bell — it
    // applies to someone with NO preference, not to someone whose preference we
    // failed to read. Dropping that condition is how an opt-out gets mailed.
    expect(events).toMatch(/input\.alwaysEmail && !pref\.lookupFailed/);
  });

  it("logs the skip rather than swallowing it", () => {
    expect(events).toMatch(/pref\.lookupFailed[\s\S]{0,300}console\.warn/);
    expect(events).toContain("NOT treated as an opt-out");
  });

  it("still writes the bell when the email is skipped", () => {
    // The bell row is inserted after this block unconditionally — a failed
    // email preference must never cost the notification itself.
    const i = events.indexOf("pref.lookupFailed");
    const j = events.indexOf('.from("notifications").insert(');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(-1);
    // The insert happens earlier in the function than the email block, so the
    // bell is already written by the time any of this runs.
    expect(j).toBeLessThan(i);
  });
});
