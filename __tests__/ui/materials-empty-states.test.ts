import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The work-order list must never render NOTHING.
 *
 * `visibleJobs.length === 0` ran a ternary whose else-arm was literally
 * `null`: with no search text and a filter that matched nothing, the list body
 * drew no row, no message and no hint about which control emptied it. It is
 * reachable on the first screen of the day — Status → "Order cancelled" on a
 * job set that has none — and tomorrow that screen is step one for every
 * member of staff.
 *
 * An empty screen must say why.
 */

const src = readFileSync(join(__dirname, "..", "..", "components/materials-view.tsx"), "utf8");

/** The whole `visibleJobs.length === 0 ? … : …` arm, brace-matched rather than
 *  grepped, so this reads the real branch and not a lookalike elsewhere. */
function emptyStateBranch(): string {
  const start = src.indexOf("{visibleJobs.length === 0 ? (");
  expect(start, "empty-state ternary not found — has it been restructured?").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces in the empty-state branch");
}

describe("every empty list says why it is empty", () => {
  const branch = emptyStateBranch();

  it("has no `null` arm left in it", () => {
    // The exact defect. Any arm of this ternary returning null is a blank body.
    expect(branch).not.toMatch(/\)\s*:\s*null\b/);
  });

  it("covers all three reasons a list can be empty", () => {
    // searched and found nothing / filtered to nothing / genuinely nothing.
    expect(branch).toMatch(/searchQuery \?/);
    expect(branch).toMatch(/filtersActive \?/);
    expect(branch).toMatch(/No open paint jobs right now/);
  });

  it("names the status it filtered to, in the picker's own words", () => {
    // Describing it a second, different way is how a message stops matching
    // the control the person actually touched.
    expect(branch).toMatch(/STATUS_LABELS\[filterStatus\]/);
    const labels = src.slice(src.indexOf("const STATUS_LABELS"), src.indexOf("const STATUS_LABELS") + 600);
    for (const option of ["Needs form sent", "Awaiting customer", "Ready to order", "Ordered", "Order cancelled", "Materials delivered"]) {
      expect(labels, option).toContain(option);
      // …and the picker really does offer that exact wording.
      expect(src, `picker option: ${option}`).toContain(`>${option}<`);
    }
  });

  it("offers the way out, not just the diagnosis", () => {
    expect(branch).toMatch(/clearFilters/);
    expect(branch).toMatch(/Clear the filters/);
  });

  it("says the jobs still exist, so it does not read as data loss", () => {
    expect(branch).toMatch(/openJobs\.length/);
  });

  it("keeps a tappable target on the control it offers", () => {
    // 44px — the standing rule for anything a person taps on a phone.
    expect(branch).toMatch(/min-h-\[44px\]/);
  });
});
