/**
 * A COLOR WITHOUT A FINISH CANNOT BE ORDERED.
 *
 * Kate FU.1 (2026-10-15): "continue allowing the customer to save the form
 * without all colors filled in so they can save progress and come back, BUT
 * when they enter a color, the finish is required before saving."
 *
 * Two rules, and the second is the easy one to get wrong by over-applying:
 *
 *   · a surface with NOTHING on it is fine — saving partial progress is the
 *     point of the form, and a customer who has picked three rooms and not
 *     the fourth must still be able to come back;
 *   · a surface with a color and no finish is not, because the order screen
 *     then shows a line nobody can buy — her FU.1 screenshot is exactly
 *     that, "01 White 01 / Trim — See Notes" with no sheen and no way to
 *     add one.
 *
 * ── WHY THIS IS A FUNCTION AND NOT AN `if` IN THE COMPONENT ─────────────
 *
 * Because the rule has been reversed twice. Katie required it on
 * 2026-05-29; WO 00317803 on 2026-09-17 showed a customer losing three
 * correctly-filled rooms to it and it became a warning; Kate has now asked
 * for the refusal back. The thing that actually hurt in September was the
 * refusal arriving from the SERVER after the payload was rejected — the
 * answers were gone. Deciding it here, in a pure function the browser calls
 * before sending anything, keeps every answer on screen.
 */

export type FinishCheckSurface = {
  /** What the customer sees this room called. */
  room: string;
  surface: string;
  /** Set when they picked a color. */
  colorId?: string | null;
  finish?: string | null;
  /** They explicitly said not to paint it. */
  skipped?: boolean;
};

/**
 * The surfaces holding a color and no finish, labelled "Room → Surface".
 * Empty means the form can be submitted.
 */
export function surfacesMissingFinish(
  surfaces: ReadonlyArray<FinishCheckSurface>
): string[] {
  const out: string[] = [];
  for (const s of surfaces) {
    if (s.skipped) continue;
    if (!s.colorId) continue;
    if ((s.finish ?? "").trim()) continue;
    out.push(`${s.room} → ${s.surface}`);
  }
  return out;
}

/**
 * What to tell them. Names the surfaces, and says their work is safe —
 * without that sentence a refusal reads like the form has thrown the rest
 * away, which is the thing that actually went wrong in September.
 */
export function missingFinishMessage(missing: readonly string[]): string {
  if (missing.length === 0) return "";
  return missing.length === 1
    ? `Pick a finish for ${missing[0]} before saving — a color cannot be ordered without one. Nothing else you have entered is lost.`
    : `Pick a finish for these before saving — a color cannot be ordered without one, and nothing else you have entered is lost: ${missing.join("; ")}.`;
}
