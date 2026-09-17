import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A safety net that runs on every page load only touches what is broken.
 *
 * Karan 2026-09-17: "idk why it takes like 5 seconds to toggle."
 *
 * This was it. `ensureJobsForSentWorkOrders` calls `ensureJobForWorkOrder` once
 * per sent work order, sequentially, and ran on every load of the Calendar, the
 * Status board and the Jobs page. Measured on the live book: 93 sent work
 * orders, 93 of which already had a job, ZERO needing anything — **5,186ms to
 * do nothing**, paid again on every month/week toggle, every arrow, and every
 * save that revalidates the page. After filtering first: 66ms.
 *
 * Its own docstring said "cheap + idempotent". The second half was true, which
 * is why nobody looked at the first.
 *
 * The suite is deliberately DB-free so it cannot time the real thing; this pins
 * the SHAPE instead — the gap is computed before the loop, so the loop walks
 * the missing ones rather than all of them.
 */

const src = readFileSync(join(process.cwd(), "lib/commercial/field-ops/jobs.ts"), "utf8");

/** The body of one exported function, up to the next top-level export. */
function bodyOf(name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  expect(start, `${name} not found — this test is measuring nothing`).toBeGreaterThan(-1);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe("ensureJobsForSentWorkOrders", () => {
  const body = bodyOf("ensureJobsForSentWorkOrders");

  it("works out what is missing before it loops", () => {
    // THE REGRESSION: `for (const w of wos)` — every sent work order, one round
    // trip each, regardless of whether anything was wrong.
    expect(body).toMatch(/const missing = /);
    expect(body).toMatch(/for \(const w of missing\)/);
    expect(body).not.toMatch(/for \(const w of \(wos \?\? \[\]\)/);
  });

  it("reads the two tables it needs in parallel, not in sequence", () => {
    expect(body).toContain("Promise.all");
  });

  it("does not revive a job somebody deliberately deleted", () => {
    // The gap is computed from ALL jobs carrying a work_order_id, including
    // soft-deleted ones. Filtering those out here would make every page load
    // re-create a twin that was removed on purpose — a delete that undoes
    // itself, forever, and the loop would stop being empty.
    expect(body).not.toMatch(/\.is\("deleted_at", null\)/);
    expect(body).toMatch(/\.not\("work_order_id", "is", null\)/);
  });

  it("still fixes a work order that genuinely has no twin", () => {
    // The net is narrowed, not removed.
    expect(body).toContain("ensureJobForWorkOrder");
    expect(body).toMatch(/created\+\+|created \+= 1/);
  });
});
