import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A notification fan-out is not left to finish after the response is sent.
 *
 * Karan 2026-09-17: "work on notifications."
 *
 * Every fan-out in Commercial is deliberately fire-and-forget, so a server
 * action returns as soon as the database write lands and the bell row, the
 * Slack post and the email happen "later". Written as `void (async () => {…})()`
 * that is correct on a long-lived Node server and WRONG on Vercel, which
 * freezes the instance the moment the response is sent. Anything still awaiting
 * is discarded: no error, no log, no row — the notification simply never
 * happened, intermittently, depending on how fast the response went out.
 *
 * This is the most likely explanation for "notifications don't always fire",
 * and it is invisible in development, invisible in the test suite, and
 * invisible in code review, because every one of those runs it to completion.
 *
 * `afterResponse()` registers the work with the platform so it is kept alive.
 * This test is the only thing standing between that and the next person
 * reaching for `void` again, because nothing else here can tell the difference.
 */

const ROOTS = ["lib/commercial", "lib/notifications"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(join(process.cwd(), r))).map((p) =>
  p.replace(process.cwd() + "/", "")
);

describe("notification fan-out", () => {
  it("never detaches a notification insert with a bare `void`", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // Two shapes, and the SECOND is the one that mattered — most of the
      // original defect was `void (async () => { … await insert… })()`, not a
      // bare `void insert…(`. A first version of this check only looked for the
      // latter and passed while the real pattern sat untouched two files away.
      for (const m of src.matchAll(/\bvoid\s+(insertCommercial\w+|postCommercialSlack)\s*\(/g)) {
        offenders.push(`${f}: void ${m[1]}(`);
      }
      for (const m of src.matchAll(/\bvoid\s*\(\s*async/g)) {
        // A detached async IIFE anywhere in the notification path.
        offenders.push(`${f}: void (async … )()  [detached IIFE]`);
        void m;
      }
    }
    expect(
      offenders,
      `these are dropped when the instance freezes — wrap in afterResponse():\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("measured something — the fan-outs are still where this looks", () => {
    // Without this the assertion above passes trivially the day these move or
    // get renamed, and the check silently stops covering anything.
    const all = files
      .map((f) => readFileSync(join(process.cwd(), f), "utf8"))
      .join("\n");
    expect(all.split("insertCommercial").length - 1).toBeGreaterThan(20);
    expect(files.length).toBeGreaterThan(30);
  });

  it("routes the deferred work through afterResponse", () => {
    const used = files.filter((f) =>
      readFileSync(join(process.cwd(), f), "utf8").includes("afterResponse(")
    );
    // The seven fan-out sites the audit found, plus the helper itself.
    expect(used.length).toBeGreaterThanOrEqual(7);
  });

  it("afterResponse still works outside a request, where after() throws", () => {
    // The migration scripts, the cron entry points and this suite all call these
    // same functions with no request scope. If the fallback is ever removed,
    // every script that touches a notification throws instead of sending one.
    const src = readFileSync(
      join(process.cwd(), "lib/notifications/after-response.ts"),
      "utf8"
    );
    expect(src).toContain("after(run)");
    expect(src).toMatch(/catch\s*\{[\s\S]*void run\(\)/);
    // And a failure is logged rather than becoming an unhandled rejection with
    // no context — the entire point being that nothing disappears quietly.
    expect(src).toContain("console.warn");
  });
});
