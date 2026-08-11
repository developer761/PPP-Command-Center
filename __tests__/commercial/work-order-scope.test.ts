import { describe, it, expect } from "vitest";

/**
 * Pure re-implementation of the two rules migration 123 introduced, so they're
 * pinned without needing a DB. Both are easy to get subtly wrong, and both
 * fail SILENTLY if you do — a blanked crew sheet, or scope nobody notices is
 * unassigned.
 */

type WO = { scope_line_item_ids: string[] };

/** Mirrors buildWorkOrderContent's filter. */
function scopeForWorkOrder(allIds: string[], wo: WO): string[] {
  const selected = new Set(wo.scope_line_item_ids ?? []);
  return selected.size > 0 ? allIds.filter((id) => selected.has(id)) : allIds;
}

/** Mirrors listUnassignedScopeForOpp. */
function unassigned(allIds: string[], workOrders: WO[]): string[] {
  if (allIds.length === 0 || workOrders.length === 0) return allIds;
  // Empty-means-all is a legacy rule for the single-work-order era; with 2+
  // sheets an empty selection means "not chosen yet".
  const soleSheetCoversEverything =
    workOrders.length === 1 && (workOrders[0].scope_line_item_ids ?? []).length === 0;
  if (soleSheetCoversEverything) return [];
  const assigned = new Set(workOrders.flatMap((wo) => wo.scope_line_item_ids ?? []));
  return allIds.filter((id) => !assigned.has(id));
}

describe("work order scope selection", () => {
  const ALL = ["a", "b", "c", "d"];

  it("treats an EMPTY selection as the whole proposal, not as no scope", () => {
    // Every work order created before scope selection existed has an empty
    // array. Reading that as "no scope" would blank every existing crew sheet
    // the moment the migration ran.
    expect(scopeForWorkOrder(ALL, { scope_line_item_ids: [] })).toEqual(ALL);
  });

  it("prints only the selected lines, in proposal order", () => {
    expect(scopeForWorkOrder(ALL, { scope_line_item_ids: ["c", "a"] })).toEqual(["a", "c"]);
  });

  it("drops ids that no longer exist on the proposal without losing the rest", () => {
    // A line deleted from the proposal after the WO was built. The sheet keeps
    // its other items — which is why this is an array, not a foreign key.
    expect(scopeForWorkOrder(ALL, { scope_line_item_ids: ["a", "zz"] })).toEqual(["a"]);
  });

  it("reports everything unassigned when there are no work orders yet", () => {
    expect(unassigned(ALL, [])).toEqual(ALL);
  });

  it("reports the gap when scope is split across crews", () => {
    const wos = [{ scope_line_item_ids: ["a"] }, { scope_line_item_ids: ["b"] }];
    expect(unassigned(ALL, wos)).toEqual(["c", "d"]);
  });

  it("reports nothing unassigned once every line is on some sheet", () => {
    const wos = [{ scope_line_item_ids: ["a", "b"] }, { scope_line_item_ids: ["c", "d"] }];
    expect(unassigned(ALL, wos)).toEqual([]);
  });

  it("keeps warning once a SECOND sheet exists, even if it's empty", () => {
    // The trap: sheet A covers half, you click "Add another", the new sheet is
    // empty — and the old rule read that as "someone has everything", so the
    // banner switched off at exactly the moment the split began. A deal can
    // only have 2+ sheets post-migration-123, so empty there means "not chosen".
    const wos = [{ scope_line_item_ids: ["a", "b"] }, { scope_line_item_ids: [] }];
    expect(unassigned(ALL, wos)).toEqual(["c", "d"]);
  });

  it("still treats a LONE empty work order as covering everything", () => {
    // Backward compatibility: every pre-123 work order has an empty array and
    // means the whole proposal.
    expect(unassigned(ALL, [{ scope_line_item_ids: [] }])).toEqual([]);
  });

  it("tolerates the same line appearing on two sheets", () => {
    // Not the intended model, but two crews double-covering a line must not
    // make it read as unassigned.
    const wos = [{ scope_line_item_ids: ["a", "b"] }, { scope_line_item_ids: ["b", "c", "d"] }];
    expect(unassigned(ALL, wos)).toEqual([]);
  });
});
