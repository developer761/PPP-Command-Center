/**
 * Grouping for the sundries catalogue.
 *
 * Karan, from the materials meeting: "extras organize — caulk should be
 * stacked, rolls etc." The catalogue is one flat alphabetical-ish list of
 * twenty items, so the four caulks sit apart from each other and a worker
 * hunting for tape scans the whole thing.
 *
 * Derived from the NAME rather than a column, deliberately. `supplier_extras`
 * has no category field, and adding one means a migration plus a backfill for
 * a list of twenty rows that changes a few times a year. The names are
 * distinctive enough — and the test pins every real product to its group, with
 * an explicit assertion that nothing lands in the catch-all, so a new item that
 * does not match is caught rather than quietly filed under "Other".
 */

export const EXTRA_GROUPS = [
  "Caulk",
  "Tape & masking",
  "Patching & compound",
  "Roller covers",
  "Trays & liners",
  "Other",
] as const;

export type ExtraGroup = (typeof EXTRA_GROUPS)[number];

export function extraGroupOf(name: string): ExtraGroup {
  const n = (name ?? "").toLowerCase();

  // Caulk first: "DAP Alex Plus" names the brand, not the product type, so a
  // rule looking only for the word "caulk" misses three of PPP's four.
  if (n.includes("caulk") || n.startsWith("dap ")) return "Caulk";

  // Roller covers before "tape & masking" — "9 inch microfiber 9/16 (4 pack)"
  // contains "pack", which the masking rule would otherwise claim.
  if (n.includes("roller") || n.includes("microfiber") || n.includes("nap")) {
    return "Roller covers";
  }

  if (n.includes("tray") || n.includes("liner")) return "Trays & liners";

  if (n.includes("tape") || n.includes("plastic") || n.includes("paper")) {
    return "Tape & masking";
  }

  if (
    n.includes("compound") ||
    n.includes("easy sand") ||
    n.includes("plaster") ||
    n.includes("spackle") ||
    n.includes("sand")
  ) {
    return "Patching & compound";
  }

  return "Other";
}

/** Catalogue split into groups, in EXTRA_GROUPS order, empty groups dropped. */
export function groupExtras<T extends { name: string }>(
  items: readonly T[]
): Array<{ group: ExtraGroup; items: T[] }> {
  const by = new Map<ExtraGroup, T[]>();
  for (const it of items) {
    const g = extraGroupOf(it.name);
    const list = by.get(g) ?? [];
    list.push(it);
    by.set(g, list);
  }
  return EXTRA_GROUPS.filter((g) => (by.get(g)?.length ?? 0) > 0).map((g) => ({
    group: g,
    items: by.get(g)!,
  }));
}
