/**
 * SETUP HEALTH MUST NOT REPORT THE SAME CHECK TWICE.
 *
 * On 2026-10-14 I added a `writeback_mode` check to the health endpoint
 * without noticing it already had one — I listed the ids with
 * `grep | head -30`, the list was truncated, and I read it as complete. The
 * page then rendered two cards saying the same thing, under the same React
 * key, on the screen whose entire job is to be unambiguous about whether the
 * platform is ready.
 *
 * The route now detects this itself and turns it into a failing card. These
 * assert the detector is wired, and that the source carries no duplicate id
 * outside the branch groups that are mutually exclusive by construction.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

const root = join(__dirname, "..", "..");
const src = () =>
  stripComments(readFileSync(join(root, "app/api/admin/health/route.ts"), "utf8"));

describe("the endpoint notices its own duplicates", () => {
  it("counts ids and reports a repeat as a failing card", () => {
    const s = src();
    expect(s).toContain("health_duplicate_ids");
    expect(s).toMatch(/idCounts/);
    expect(s).toMatch(/filter\(\(\[, n\]\) => n > 1\)/);
  });

  it("fails rather than warns — two cards disagreeing is worse than one", () => {
    const s = src();
    const at = s.indexOf('id: "health_duplicate_ids"');
    expect(at).toBeGreaterThan(-1);
    expect(s.slice(at, at + 200)).toMatch(/status: "fail"/);
  });

  it("runs before the summary, so the count includes it", () => {
    const s = src();
    expect(s.indexOf("health_duplicate_ids")).toBeLessThan(s.indexOf("const summary ="));
  });
});

describe("the duplicate I actually shipped is gone", () => {
  it("has exactly one writeback-mode check, in one branch group", () => {
    const s = src();
    // The surviving check pushes from four mutually exclusive branches
    // (all / off / test_only / catch) — only one runs per request. A fifth
    // would mean a second check had crept back in.
    const pushes = [...s.matchAll(/id: "writeback_mode"/g)].length;
    expect(pushes).toBe(4);
  });

  it("keeps the one that reads the tables and reports the allowlist size", () => {
    const s = src();
    expect(s).toContain("customer_form_writeback_settings");
    expect(s).toContain("customer_form_writeback_allowlist");
  });
});
