/**
 * THE WARM CRON MUST RUN MORE OFTEN THAN THE CACHE EXPIRES.
 *
 * Measured on production, 2026-10-15, from the runtime log of a real cold
 * start:
 *
 *   [SF] snapshot COLD START — no shared cache (61ms check)
 *   [SF] Pulled 62258 Transaction__c rows (last 730d)      ~11s
 *   [SF] Pulled 20230 work orders (last 365d)               ~6s
 *   [SF] snapshot COLD-COMPLETE in 24887ms
 *   [SF] snapshot written to SHARED cache (6.1MB gz)       +20s
 *
 * Twenty-five seconds to build, and the shared cache holds it for thirty
 * minutes. The cron that refills it was running ONCE A DAY, at 6am. So the
 * snapshot was warm for half an hour out of twenty-four, and the first
 * person to open Materials Ordering after any half-hour lull paid the full
 * cold build — which is what Karan saw: the page sat on skeletons for a
 * minute, then loaded instantly on reload.
 *
 * The caching here is good — a 200KB pre-derived materials bundle, 26h
 * serve-stale, background revalidate, promise-level dedupe. None of it
 * helps if nothing refills the cache between visits.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────
 *
 * warm interval < cache TTL. Break it and there is a guaranteed window
 * where a real person eats the cold build. That relationship lives across
 * two files that nothing connected, so this connects them: change the TTL
 * in queries.ts without the cron, or the cron without the TTL, and this
 * goes red with the arithmetic in the message.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Minutes between runs for the `* /N * * * *` shapes we use, else null. */
function intervalMinutes(expr: string): number | null {
  const [min, hour] = expr.trim().split(/\s+/);
  if (hour !== "*") return null; // daily or windowed — not a simple interval
  const everyN = /^\*\/(\d+)$/.exec(min);
  if (everyN) return Number(everyN[1]);
  if (min === "*") return 1;
  return null;
}

function warmSchedule(): string {
  const vercel = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string; schedule: string }> };
  const cron = vercel.crons.find((c) => c.path === "/api/cron/warm-snapshot");
  expect(cron, "the warm-snapshot cron is gone").toBeTruthy();
  return cron!.schedule;
}

function cacheTtlMinutes(): number {
  const src = read("lib/salesforce/queries.ts");
  const m = /const CACHE_TTL_MS = (\d+) \* (\d+) \* (\d+);/.exec(src);
  expect(m, "CACHE_TTL_MS is no longer a plain minutes expression — update this test").toBeTruthy();
  return Number(m![1]);
}

describe("the Salesforce snapshot stays warm", () => {
  it("refills the cache more often than it expires", () => {
    const interval = intervalMinutes(warmSchedule());
    const ttl = cacheTtlMinutes();
    expect(interval, `warm-snapshot schedule "${warmSchedule()}" is not a simple interval`).not.toBeNull();
    expect(
      interval!,
      `warm every ${interval} min against a ${ttl} min cache TTL leaves a ` +
        `${interval! - ttl} min window where somebody pays the 25s cold build`
    ).toBeLessThan(ttl);
  });

  it("leaves room for a missed run", () => {
    // One failed cron must not immediately expose the cold path.
    const interval = intervalMinutes(warmSchedule())!;
    const ttl = cacheTtlMinutes();
    expect(interval * 2, "a single missed warm uncovers the cold build").toBeLessThanOrEqual(ttl);
  });

  it("gives the job longer than the cold build takes", () => {
    // Measured ~45s end to end (24.9s build + 20s shared write). A warm that
    // times out leaves the cache empty — the state the cron exists to stop.
    const src = read("app/api/cron/warm-snapshot/route.ts");
    const m = /export const maxDuration = (\d+)/.exec(src);
    expect(m, "warm-snapshot declares no maxDuration").toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(120);
  });
});
