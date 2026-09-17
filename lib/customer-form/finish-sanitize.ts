/**
 * What to do with a finish the list does not contain.
 *
 * WO 00317803 (2026-09-17): a customer filled three rooms correctly and one
 * surface carried a finish that was not on the list. The submit route returned
 * 400 at the first bad value — from inside the loop that was building the
 * Salesforce writes — so the three good rooms were discarded too. The customer
 * saw one error, had no idea which room it meant, and had to enter everything
 * again.
 *
 * The color is real whatever the finish says, so the color is kept and only
 * the finish is set aside. Pure, so the rule can be tested without a database:
 * the route does the I/O, this decides.
 */

export type SurfaceLike = {
  surface?: unknown;
  colorId?: unknown;
  finish?: unknown;
};

export type DroppedFinish = {
  surface: string;
  finish: string;
};

/**
 * Strip off-list finishes from one line item's surfaces.
 *
 * Returns the surfaces to write (same objects, finish nulled where it was not
 * recognised) and what was dropped, so the caller can record it in the notes
 * and tell the customer. Never throws: this runs on a public endpoint where
 * the payload may be anything.
 */
export function sanitizeFinishes<T extends SurfaceLike>(
  surfaces: readonly T[],
  validFinishes: ReadonlySet<string>
): { surfaces: T[]; dropped: DroppedFinish[] } {
  const dropped: DroppedFinish[] = [];
  const out: T[] = [];
  for (const s of surfaces) {
    if (!s || typeof s !== "object") continue;
    const finish = typeof s.finish === "string" ? s.finish : null;
    // No color means nothing is written for this surface at all, so a stray
    // finish on it is not worth telling the customer about.
    const hasColor = typeof s.colorId === "string" && s.colorId.length > 0;
    if (hasColor && finish && !validFinishes.has(finish)) {
      dropped.push({ surface: String(s.surface ?? ""), finish });
      out.push({ ...s, finish: null });
      continue;
    }
    out.push(s);
  }
  return { surfaces: out, dropped };
}
