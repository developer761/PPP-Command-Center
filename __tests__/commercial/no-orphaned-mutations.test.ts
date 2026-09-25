import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * No commercial mutation may exist that nothing can invoke.
 *
 * ── WHAT HAPPENED ──────────────────────────────────────────────────────────
 *
 * Walking the crew screens as an admin on 2026-09-24, all five said "Almost
 * there — ask an admin to connect it in Settings → Access". The control was
 * not on that page. `linkEmployeeToUser` had been written in August, complete
 * with a duplicate-link guard, an inactive-employee guard and an audit trail
 * on both the row that gains the link and the row that loses it — and never
 * called. That made "Restrict to crew" a trap: it confined a login to five
 * screens, all five resolved the person through a column nothing in the
 * product could set, and the only way out was a hand-written UPDATE. The
 * database agreed — 24 employees, zero linked.
 *
 * Sweeping for the class found two more, both silent:
 *
 *   updateDebrief         a win/loss debrief went read-only the moment it was
 *                         saved, so a competitor named wrong stayed wrong
 *                         unless somebody reopened and re-closed the deal —
 *                         the exact defect the function's own docblock
 *                         described itself as fixing.
 *   removePurchaseReceipt a receipt filed against the wrong purchase could
 *                         only be REPLACED, so correcting one meant attaching
 *                         a different wrong receipt.
 *
 * And one read of the same shape: `clearedCarryoverRows`, documented as "the
 * copied lines that have been ticked off — shown so they can be put back",
 * was never rendered, so Remove silently dropped an open receivable off
 * Mary's AR sheet with no undo and no list of what had gone.
 *
 * ── WHY A TEST, AND WHY THIS SHAPE ─────────────────────────────────────────
 *
 * Nothing else can see this. An exported function with no callers is
 * perfectly well-typed, so `tsc` is silent. The unit suite is worse than
 * silent: you can test the function to death, watch every assertion pass, and
 * conclude the feature works while no human being can reach it.
 *
 * So this asserts on the SEAM — is there a caller — and never on the
 * function's contents, which in all four cases were correct from the start.
 *
 * Proven to fail: run against the tree before those fixes, the scan named
 * `linkEmployeeToUser`, `updateDebrief`, `removePurchaseReceipt` and
 * `clearedCarryoverRows`; `git grep linkEmployeeToUser HEAD -- app components`
 * returned nothing at all.
 */

const ROOT = process.cwd();

/**
 * A verb prefix followed by a capital — `setCrewRole`, `removePurchaseReceipt`.
 * Requiring the capital keeps out `settle`, `addend`, `marketing`.
 */
const MUTATION_NAME =
  /^(create|update|delete|remove|add|set|link|unlink|insert|save|post|send|mark|assign|archive|restore|apply|record|clear|toggle|approve|reject|void|issue|generate|import|migrate)[A-Z]/;

/**
 * Deliberate exceptions. Each one must say why it is unreachable and stay
 * unreachable on purpose — the point of writing it down is that adding to this
 * list is a decision somebody makes, not a thing that happens quietly.
 */
const ALLOWED_UNCALLED: ReadonlyArray<{ fn: string; why: string }> = [];

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Comments are stripped before matching. Several tests here have gone green on
 * their own docblocks; a file that merely EXPLAINS why a function exists must
 * not count as calling it. That is not hypothetical — the debrief docblock
 * described the bug in detail while nothing called the fix.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("every commercial mutation is reachable", () => {
  const libFiles = sourceFiles(join(ROOT, "lib/commercial"));
  const universe = [
    ...sourceFiles(join(ROOT, "app")),
    ...sourceFiles(join(ROOT, "components")),
    ...sourceFiles(join(ROOT, "lib")),
    ...sourceFiles(join(ROOT, "scripts")),
  ].map((f) => ({ f, src: stripComments(readFileSync(f, "utf8")) }));

  it("actually measured something", () => {
    // A zero-file scan passes every assertion below vacuously — the failure
    // mode that turned an earlier audit here into a fake all-clear.
    expect(libFiles.length).toBeGreaterThan(150);
    expect(universe.length).toBeGreaterThan(500);
  });

  it("has no exported mutation that nothing calls", () => {
    const allowed = new Set(ALLOWED_UNCALLED.map((a) => a.fn));
    const orphans: string[] = [];

    for (const lf of libFiles) {
      const src = stripComments(readFileSync(lf, "utf8"));
      const decl = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g;
      let m: RegExpExecArray | null;
      while ((m = decl.exec(src))) {
        const fn = m[1];
        if (!MUTATION_NAME.test(fn) || allowed.has(fn)) continue;
        const word = new RegExp(`\\b${fn}\\b`, "g");
        let uses = 0;
        for (const x of universe) {
          const hits = x.src.match(word);
          if (!hits) continue;
          // Its own declaration is not a use of itself.
          uses += x.f === lf ? hits.length - 1 : hits.length;
        }
        if (uses <= 0) orphans.push(`${lf.replace(`${ROOT}/`, "")} :: ${fn}`);
      }
    }

    expect(
      orphans,
      "These mutations exist and nothing can invoke them. Either wire each to a " +
        "surface a person can reach, delete it, or add it to ALLOWED_UNCALLED " +
        "with the reason it is deliberately unreachable.",
    ).toEqual([]);
  });
});
