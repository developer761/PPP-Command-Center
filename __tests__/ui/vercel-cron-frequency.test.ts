import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Vercel's Hobby plan caps cron frequency at ONCE PER DAY. A more frequent
 * schedule is rejected at deploy time, and the deploy fails — so `main` moves
 * on while the live site does not.
 *
 * This has now happened twice on this repo:
 *   2026-07-10  warm-snapshot on "0 * / 6 * * *" blocked every push for weeks;
 *               Karan was looking at a pre-Phase-A sidebar while main was 20
 *               commits ahead (commit 73660a33).
 *   2026-09-09  messaging-tick re-added on "* * * * *" (commit f6b9344d),
 *               failing the very next deploy.
 *
 * The fix in July was a commit message. A commit message does not stop it
 * happening again, so this is a test.
 *
 * If PPP moves to Vercel Pro, DELETE this file rather than loosening it — a
 * relaxed assertion that still looks like a guard is worse than none.
 */
const cron = JSON.parse(readFileSync(join(__dirname, "..", "..", "vercel.json"), "utf8")) as {
  crons?: Array<{ path: string; schedule: string }>;
};

/** How many times a day this expression fires. */
function runsPerDay(schedule: string): number {
  const [min, hour] = schedule.trim().split(/\s+/);
  const count = (field: string, range: number) => {
    if (field === "*") return range;
    if (field.startsWith("*/")) return Math.ceil(range / Number(field.slice(2)));
    return field.split(",").length;
  };
  return count(min, 60) * count(hour, 24);
}

describe("every cron is within the Hobby once-a-day cap", () => {
  it("the probe recognises the two schedules that broke it", () => {
    // Prove the check can fail before trusting it.
    expect(runsPerDay("* * * * *")).toBeGreaterThan(1);   // 2026-09-09
    expect(runsPerDay("0 */6 * * *")).toBeGreaterThan(1); // 2026-07-10
    expect(runsPerDay("0 6 * * *")).toBe(1);
  });

  it.each((cron.crons ?? []).map((c) => [c.path, c.schedule]))(
    "%s runs at most once a day",
    (path, schedule) => {
      expect(
        runsPerDay(schedule),
        `${path} is "${schedule}" — Hobby rejects this and the deploy fails silently`
      ).toBeLessThanOrEqual(1);
    }
  );

  it("there IS at least one cron, so the check is not vacuous", () => {
    expect((cron.crons ?? []).length).toBeGreaterThan(0);
  });
});
