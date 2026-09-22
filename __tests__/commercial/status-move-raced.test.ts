import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";
import { statusMoveRaced, STATUS_MOVE_RACED_MESSAGE } from "@/lib/commercial/opportunities/status";

/**
 * A status change that changed nothing was reported as success.
 *
 * The forward-only guard rides on the UPDATE itself, so when the deal has
 * already moved, zero rows match and `changeOpportunityStatus` returns
 * `{ ok: true, skipped: "guard" }` — a successful no-op, which is the right
 * answer for the automatic callers and the wrong one for every path with a
 * person at the end of it. Nobody read the flag. The user was told the deal
 * moved, and on a Won flip the placeholder "won" note was posted and the
 * browser sent to the debrief page for a deal still sitting in its old column.
 */
describe("statusMoveRaced", () => {
  it("is true only for the zero-rows no-op", () => {
    expect(statusMoveRaced({ ok: true, skipped: "guard" })).toBe(true);
    expect(statusMoveRaced({ ok: true })).toBe(false);
    expect(statusMoveRaced({ ok: false, error: "nope" })).toBe(false);
  });

  it("the message tells the reader what to do about it", () => {
    // "Nothing happened" on its own leaves somebody clicking the same button.
    expect(STATUS_MOVE_RACED_MESSAGE).toMatch(/refresh/i);
  });
});

/**
 * Every place a PERSON changes a status has to handle it. This is a coverage
 * guard, not a behaviour test: it cannot prove the handling is right, only
 * that a new call site has not quietly skipped it. Comments are stripped
 * first, or the docblock above a call would satisfy its own check.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".next", ".git", "worktrees"].includes(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

// Callers that are deliberately NOT user-facing: losing the race is the
// outcome the guard exists to produce, and they are right to carry on quietly.
const AUTOMATIC = [
  "lib/commercial/opportunities/auto-advance.ts", // yields to the human, by design
  "lib/commercial/opportunities/mutations.ts", // cascade from another write
  "lib/commercial/proposals/db.ts", // deal follows the proposal; best-effort
  "lib/commercial/opportunities/status.ts", // the function itself
];

describe("every user-facing status change checks for the no-op", () => {
  const files = [...walk("app"), ...walk("lib"), ...walk("components")].filter((f) => {
    if (AUTOMATIC.some((a) => f.endsWith(a))) return false;
    return /\bchangeOpportunityStatus\s*\(/.test(stripComments(readFileSync(f, "utf8")));
  });

  it("found the call sites at all", () => {
    // A zero-file scan that reports a pass is the failure mode this suite has
    // already shipped once. Name the floor.
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    it(`${file} handles skipped: "guard"`, () => {
      expect(stripComments(readFileSync(file, "utf8"))).toContain("statusMoveRaced");
    });
  }
});
