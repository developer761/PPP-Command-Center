import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * "Time to review 9 →" opened a page with one row on it.
 *
 * Field Ops Overview counted every `commercial_time_entries` row in status
 * submitted/questioned. The Approvals page it links to drops one kind — an
 * entry of ZERO hours belonging to a DEACTIVATED employee — and the docblock
 * on that filter explains at length why: they are the "(old company entry)"
 * duplicates the Salesforce migration left behind, approving them changes
 * nothing, and they cannot age out.
 *
 * That reasoning was applied to one side of the seam. Eight of the nine
 * pending entries were exactly those rows, so the counter sat amber forever
 * and resolved, on click, to a single line. A to-do with nothing to do behind
 * it is not a small cosmetic problem: it is how somebody learns to ignore
 * every other counter on the page, including the ones that mean something.
 *
 * The overview now counts the list itself rather than re-expressing its rule.
 * Re-expressing it is what produced the bug — and the rule needs a join
 * PostgREST cannot do in a single count query, so a second copy would drift
 * again.
 *
 * Asserted on the source: reconciling two live counts needs a database, and
 * the seam — does the counter read the same function the page reads — is both
 * what broke and what a rewrite would break again.
 */

const ROOT = process.cwd();

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const overview = strip(
  readFileSync(join(ROOT, "lib/commercial/field-ops/overview.ts"), "utf8"),
);
const approvals = strip(
  readFileSync(join(ROOT, "lib/commercial/field-ops/approvals.ts"), "utf8"),
);

describe("the Field Ops review counter", () => {
  it("reads the same list the Approvals page renders", () => {
    expect(
      overview.includes("listPendingApprovals"),
      "the counter must come from the approvals queue, not a second query",
    ).toBe(true);
  });

  it("does not count time entries by status on its own", () => {
    // The original: a head-count over commercial_time_entries filtered only by
    // status, which cannot see the employee-active rule.
    const raw =
      /from\("commercial_time_entries"\)[\s\S]{0,200}?count:\s*"exact"[\s\S]{0,200}?\["submitted",\s*"questioned"\]/;
    expect(
      raw.test(overview),
      "counting submitted/questioned directly re-creates the mismatch",
    ).toBe(false);
  });

  it("still filters on BOTH zero hours and inactive, never inactive alone", () => {
    // An inactive person with REAL hours must stay in the queue or they are
    // not paid for their last week. Dropping the hours half of the predicate
    // would silently strip exactly the entries that matter most.
    expect(approvals).toContain("Number(e.actual_hours) === 0");
    expect(approvals).toContain('empActive.get(e.employee_id) === false');
    expect(
      /\.filter\(\(e\) => empActive\.get\(e\.employee_id\) === false\)/.test(approvals),
      "filtering on inactive alone would drop a leaver's real unpaid hours",
    ).toBe(false);
  });
});
