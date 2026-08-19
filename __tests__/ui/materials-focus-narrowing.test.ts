import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * /dashboard/materials/[woId] is the canonical deep-link target — the Salesforce
 * "Open in Command Center" button, the mail timeline, the activity feed and
 * global search all land on it. It was doing the entire board's work to render
 * ONE job: 460 open work orders (measured against production 2026-08-19) with
 * all their line items serialized into the RSC payload, plus the form-status
 * and progress aux queries run across all 460 ids.
 *
 * The narrowing is only safe while every aggregate the client derives from the
 * job list stays behind `!focusMode`. That's the invariant this guards: if
 * someone later renders the stat strip or needs-attention rollup in focus mode,
 * it would silently report "1 open WO" instead of 460 — a wrong number with no
 * error anywhere.
 */
const view = readFileSync(join(process.cwd(), "components/materials-view.tsx"), "utf8");
const props = readFileSync(join(process.cwd(), "lib/materials/view-props.ts"), "utf8");
const page = readFileSync(join(process.cwd(), "app/dashboard/materials/[woId]/page.tsx"), "utf8");

describe("materials focus-mode narrowing", () => {
  it("passes the focused id into the loader, not just the view", () => {
    expect(page).toMatch(/loadMaterialsViewProps\(sp,\s*\{\s*focusWoId:/);
  });

  it("narrows the job list before the aux queries and serialization", () => {
    const body = props.slice(props.indexOf("export async function loadMaterialsViewProps"));
    const narrowed = body.indexOf("const openJobs = opts.focusWoId");
    expect(narrowed).toBeGreaterThan(-1);
    // Order matters: narrowing after these would save nothing.
    expect(narrowed).toBeLessThan(body.indexOf("getMaterialsPageAuxData"));
    expect(narrowed).toBeLessThan(body.indexOf("serializeOpenJobs"));
  });

  it("keeps board-wide aggregates out of focus mode", () => {
    // `stats` and `needsAttention` are computed from the (now narrowed) list.
    // Both must render only inside the !focusMode branch.
    const listOnlyStart = view.indexOf("{!focusMode && (<>");
    expect(listOnlyStart).toBeGreaterThan(-1);
    // Brace-match the block rather than guessing at a closing tag — the admin
    // sub-block nested inside closes with the same `</>)}` at the same indent,
    // and stopping there silently excluded half the branch from the check.
    let depth = 0;
    let listOnlyEnd = -1;
    for (let i = listOnlyStart; i < view.length; i++) {
      const c = view[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { listOnlyEnd = i + 1; break; }
      }
    }
    expect(listOnlyEnd).toBeGreaterThan(listOnlyStart);
    const listOnly = view.slice(listOnlyStart, listOnlyEnd);
    const rest = view.slice(0, listOnlyStart) + view.slice(listOnlyEnd);

    for (const usage of ["stats.openWoCount", "stats.totalSqFt", "stats.distinctColors", "stats.distinctSuppliers"]) {
      expect(listOnly, `${usage} should be list-mode only`).toContain(usage);
      expect(rest, `${usage} leaked outside !focusMode — it would read 1, not the real count`).not.toContain(usage);
    }
    expect(rest).not.toContain("needsAttention.");
  });
});
