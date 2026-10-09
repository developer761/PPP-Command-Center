import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A CAPPED LIST SHOWN AS A TOTAL.
 *
 * Four screens have had this now, and each was found by hand after the last
 * one was fixed — the fix landing on one twin, four times over:
 *
 *   the board            a page of conversations rendered as the count
 *   the review queue     `{drafts.length} waiting`, list capped at 25, so
 *                        sixty customers waiting read as "25 waiting" and the
 *                        number stopped moving as the queue grew
 *   the held leads       `total: leads.length` against a 2000-row scan,
 *                        documented as "every held lead, however old".
 *                        Production holds 1514 today, so it was 486 leads
 *                        from freezing at 2000 for ever.
 *
 * The shape is always the same: a query with `.limit(...)`, and the length of
 * what came back presented as how many there are. It is invisible to a unit
 * test because the function is correct — it returns what it fetched — and the
 * lie is in what the screen calls it.
 *
 * So this asserts the rule structurally: where a module caps a read AND
 * publishes a total, the total must come from the database's own count.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("a total comes from a count, never from a page of rows", () => {
  /**
   * Each entry is a module that both caps a read and reports a total. Adding a
   * fifth screen with this shape means adding it here, which is the point: the
   * list is what somebody reads when they wonder whether their new count is
   * the real one.
   */
  const SITES: { file: string; what: string }[] = [
    { file: "lib/messaging/lead-redrive-write.ts", what: "held leads" },
    { file: "lib/messaging/drafts-write.ts", what: "the review queue" },
  ];

  it.each(SITES)("$what counts in the database", ({ file }) => {
    const src = stripComments(readFileSync(file, "utf8"));
    // head: true means the database counted and no rows were read.
    expect(src, `${file} caps a read but never asks the database to count`)
      .toMatch(/count:\s*["']exact["'][\s\S]{0,40}head:\s*true/);
  });

  it.each(SITES)("$what does not report the length of what it fetched", ({ file }) => {
    const src = stripComments(readFileSync(file, "utf8"));
    /**
     * The exact shape that was wrong: a published `total` assigned from an
     * array's length. `scanned: leads.length` is fine and deliberate — it
     * says how many this pass looked at, which is a different claim.
     */
    expect(src, `${file} reports a fetched array's length as a total`)
      .not.toMatch(/\btotal:\s*\w+\.length\b/);
  });

  /**
   * AND THE COUNT HAS TO DESCRIBE THE SAME ROWS AS THE LIST.
   *
   * A count with different filters from the scan beside it is the same lie
   * with a more convincing number. In lead-redrive-write both queries filter
   * on one shared constant for exactly this reason; asserting the constant
   * exists is asserting they cannot drift.
   */
  it("the held-lead count and scan filter on one shared list of statuses", () => {
    const src = stripComments(readFileSync("lib/messaging/lead-redrive-write.ts", "utf8"));
    expect(src).toMatch(/const HELD_STATUSES\s*=/);
    // Both queries use it, and neither spells the statuses out again.
    expect((src.match(/HELD_STATUSES/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(src, "a status list is spelled out separately from the shared constant")
      .not.toMatch(/\.in\(\s*["']status["']\s*,\s*\[\s*["']triage["']/);
  });

  /**
   * And when the scan really is short of the total, the screen has to say so —
   * otherwise it offers to release a number computed from a subset while
   * naming a bigger backlog, which is worse than either alone.
   */
  it("the held-leads screen says when it is showing a subset", () => {
    const src = readFileSync("components/messaging/held-leads.tsx", "utf8");
    expect(src).toMatch(/summary\.scanned\s*<\s*summary\.total/);
  });
});
