import { classifyRoomType } from "@/lib/rooms/room-type";

/**
 * PPP's recommended finish for a surface, given the room it is in.
 *
 * Straight from "Precision Painting Plus — Standardized Paint Finishes,
 * Interior & Exterior" (Mac's guide, sent on by Kate 2026-09-22: "there are
 * recommended finishes for different rooms … could you update the logic to
 * suggest them for specific areas? For instance, in the bathroom, Satin is
 * recommended for walls instead of the standard Eggshell").
 *
 *   INTERIOR
 *     Main-area ceilings ......... Flat
 *     Bathroom ceilings .......... Kitchen & Bath product / low-sheen finish
 *     Kitchen ceilings ........... Flat, or Kitchen & Bath product
 *     Main-area walls ............ Matte or Eggshell
 *     Bathroom walls ............. Satin / Kitchen & Bath product
 *     Trim / doors / baseboards .. Semi-Gloss (PPP's preference) or Satin
 *
 *   EXTERIOR
 *     Siding ..................... Low Lustre (or Soft Gloss)
 *     Trim ....................... Soft Gloss
 *     Soffits .................... Soft Gloss
 *     Doors / detailed trim ...... Soft Gloss
 *
 * A RECOMMENDATION, not a rule — the guide says so twice, and the customer can
 * always pick something else. It is also filtered by what the chosen product
 * is actually sold in before it reaches anybody (see defaultFinishFor): there
 * is no point recommending Satin in a line that only comes in Matte.
 *
 * Returns a PREFERENCE ORDER, not one value, because the second choice matters
 * when the product does not sell the first. Empty means "we have no
 * recommendation — let a person choose", which is deliberate for exterior
 * woodwork: a rear deck is stained or solid-coated depending on the product,
 * and a sheen auto-filled there is a sheen the supplier cannot fill
 * (Katie item 19, 2026-09-08).
 */
export function recommendedFinishes(
  surface: string,
  roomLabel?: string | null,
  scope?: "interior" | "exterior" | null
): string[] {
  const s = (surface ?? "").toLowerCase();
  const room = classifyRoomType(roomLabel);

  if (scope === "exterior") {
    // Exterior woodwork has no sheen recommendation — the product decides.
    // Stated rather than left to the fallthrough at the end of this branch,
    // which happens to give the same answer: deleting this line kills no test
    // (checked), and that is the point of saying it out loud. A catch-all
    // added below one day would otherwise start auto-filling a sheen onto a
    // deck that gets stained.
    if (/deck|fence|railing/.test(s)) return [];
    // The guide's "soffits" are an exterior ceiling: a porch ceiling is the
    // same surface by another name, and both sit under the trim's finish.
    if (s.includes("soffit") || s.includes("ceiling")) return ["Soft Gloss"];
    if (/trim|door|window|shutter|column|post/.test(s)) return ["Soft Gloss"];
    // Exterior WALLS are the siding. The guide names Low Lustre first and Soft
    // Gloss as the alternative.
    if (s.includes("wall") || s.includes("siding")) return ["Low Lustre", "Soft Gloss"];
    return [];
  }

  // ── interior ──────────────────────────────────────────────────────────────
  if (s.includes("ceiling")) {
    // The guide separates bathroom ceilings from main-area ceilings rather
    // than leaving them on Flat, and asks for a "low-sheen finish" without
    // naming one; its own quick-reference calls Matte the low-sheen option.
    // Flat stays as the fallback, which is where a bathroom ceiling sits today.
    if (room === "bathroom") return ["Matte", "Flat"];
    return ["Flat"];
  }
  if (/trim|door|window|baseboard|crown|molding|moulding|cabinet|shelf|shelves/.test(s)) {
    return ["Semi-Gloss", "Satin"];
  }
  if (s.includes("floor")) return ["Satin"];
  if (/deck|fence|railing|siding/.test(s)) return [];
  // Walls, accent walls, and anything else that takes a wall finish.
  // Satin in a bathroom is the change Kate asked for by name; everywhere else
  // Eggshell leads, with Matte as the guide's equally-common alternative.
  if (room === "bathroom") return ["Satin", "Eggshell"];
  return ["Eggshell", "Matte"];
}

/** Why a surface is being recommended something unusual, for the one-line hint
 *  on the form. Null when the recommendation is the ordinary one for that
 *  surface, so the form stays quiet unless it has something to add. */
export function recommendationReason(
  surface: string,
  roomLabel?: string | null,
  scope?: "interior" | "exterior" | null
): string | null {
  const s = (surface ?? "").toLowerCase();
  const room = classifyRoomType(roomLabel);
  if (scope === "exterior") return null;
  if (room !== "bathroom") return null;
  if (s.includes("ceiling")) return "PPP recommends a low-sheen finish on a bathroom ceiling.";
  if (/trim|door|window|floor|cabinet|shelf|shelves/.test(s)) return null;
  return "PPP recommends Satin in a bathroom — it stands up to moisture better than Eggshell.";
}
