import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

/**
 * Stephanie, 2026-09-22: "There is something weird going on with the contract
 * amounts on jobs with change orders."
 *
 * She was right, and the cause was not one bad line of arithmetic. The rule —
 * effective contract base PLUS net approved change orders — was spelled out by
 * hand at half a dozen call sites. Every spelling is correct until one of them
 * isn't, and the one that drifts produces a number that looks entirely
 * plausible: right magnitude, right currency, wrong contract. It took a person
 * noticing to find it, which is the part worth preventing.
 *
 * So `contractValueCents` is the definition, and this test makes adding a
 * SEVENTH spelling a deliberate act rather than an accident.
 *
 * It is a coverage guard, not a proof of correctness: it cannot tell a correct
 * re-derivation from a wrong one. What it can do is notice a new file pulling
 * both halves together, and make somebody say why.
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

/**
 * Files allowed to hold both halves, each because it must SHOW them apart —
 * that is the form, not a re-derivation:
 *
 *  · contract-value.ts — the definition itself.
 *  · aia/db.ts — defines one half; the G702 prints the original sum on line 1
 *    and net change orders on line 2, as separate lines on a signed document.
 *  · the change-order PDF (+ its route) — states the contract before and after
 *    this CO, which is the whole point of the document the GC signs.
 *  · the AIA tool and the deal page — render the breakdown to the user.
 */
const MAY_HOLD_BOTH = [
  "lib/commercial/projects/contract-value.ts",
  "lib/commercial/aia/db.ts",
  "lib/commercial/change-orders/pdf-data.ts",
  "app/api/commercial/change-orders/[id]/pdf/route.ts",
  "app/commercial/accounts/[id]/aia/[dealId]/aia-tool.tsx",
  "app/commercial/opportunities/[id]/page.tsx",
];

describe("the contract rule has one definition", () => {
  const holders = [...walk("lib"), ...walk("app")].filter((f) => {
    const src = stripComments(readFileSync(f, "utf8"));
    return src.includes("getEffectiveContractBaseCents") && src.includes("netApprovedChangeOrderCents");
  });

  it("found the call sites at all", () => {
    // A zero-file scan that reports a pass is a failure mode this repo has
    // already shipped once.
    expect(holders.length).toBeGreaterThanOrEqual(5);
  });

  it("no NEW file adds the two halves together", () => {
    const unexpected = holders.filter((f) => !MAY_HOLD_BOTH.includes(f));
    expect(
      unexpected,
      "call contractValueCents() instead of re-deriving the contract — or add the file to MAY_HOLD_BOTH with the reason it must show the parts separately",
    ).toEqual([]);
  });

  it("the deal P&L goes through the shared definition", () => {
    // This file is where the rule used to be spelled out; it is the canary.
    const src = stripComments(readFileSync("lib/commercial/projects/financials.ts", "utf8"));
    expect(src).toContain("contractValueCents");
    expect(src).not.toContain("netApprovedChangeOrderCents");
  });
});
