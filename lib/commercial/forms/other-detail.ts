/**
 * Fold a free-typed "Other" detail into the row's own free-text field.
 *
 * Karan 2026-09-17: "when I choose Other on the platform, it should give me an
 * option to enter something manually." Choosing Other used to record the word
 * "Other" and nothing else — the one option meaning "none of these fit" threw
 * away the only fact worth keeping, and a month later the list has eleven rows
 * saying Other with no way to tell a dumpster hire from a parking permit.
 *
 * There is no column for it, and inventing one means a migration applied by
 * hand on a live book, so the typed value rides in the free-text field the row
 * already has — Reference on a purchase, Reference on a payment. Both halves
 * survive: "dumpster hire — INV-4471" reads better than either alone.
 *
 * Pure, so the joining rules can be tested without a form or a database.
 */
export function joinOtherDetail(
  detail: string | null | undefined,
  existing: string | null | undefined
): string | null {
  const a = (detail ?? "").trim();
  const b = (existing ?? "").trim();
  // Null, not "": the columns are nullable and an empty string is a different
  // thing to a blank — it renders as a present-but-empty reference.
  if (!a && !b) return null;
  // Don't say it twice when somebody typed the same thing in both boxes.
  if (a && b && a.toLowerCase() === b.toLowerCase()) return a;
  return [a, b].filter(Boolean).join(" — ");
}
