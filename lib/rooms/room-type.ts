/**
 * Is this area a kitchen, a bathroom, or an ordinary room?
 *
 * Two places need the same answer and must not drift:
 *   · the gallon estimator — a bathroom is bought on its own line, on a
 *     Kitchen & Bath product (Jason & Alex, 2026-09-17);
 *   · the customer color form — PPP recommends a different FINISH in a
 *     bathroom (Satin on the walls, not Eggshell — Mac's finishes guide, sent
 *     on by Kate 2026-09-22).
 *
 * It lived inside estimate-gallons.ts, which the color form has no business
 * importing, and a second copy of a rule this fiddly ("Pool bathhouse" is not
 * a bathroom, "Kitchen & Dining" is not a kitchen) would have gone wrong
 * inside a week. estimate-gallons re-exports it, so every existing caller is
 * untouched.
 */

/** Room words that make a label a COMBINED area when a conjunction joins them
 *  to a kitchen or a bathroom. One list, because it was two: the kitchen's was
 *  missing closet/laundry/garage/deck/porch/bath, so "Kitchen & Laundry" still
 *  took the one-gallon cabinet cap for the whole combined area. */
const OTHER_ROOM_WORDS =
  "bed|bedrooms?|living|dining|family|hall|hallway|foyer|entry|basement|attic|office|study|den|" +
  "great\\s*room|closets?|laundry|mud\\s*rooms?|sun\\s*rooms?|garage|deck|porch|stairs?|landing";

const KITCHEN_WITH_OTHER = new RegExp(
  `\\b(${OTHER_ROOM_WORDS}|bathrooms?|baths?|powder\\s*(rooms?|rms?))\\b`
);
const BATHROOM_WITH_OTHER = new RegExp(`\\b(${OTHER_ROOM_WORDS}|kitchens?)\\b`);

export function classifyRoomType(label: string | null | undefined): "kitchen" | "bathroom" | null {
  const s = (label ?? "").toLowerCase();
  if (!s) return null;
  // "Kitchenette" counts; "Butler's pantry" deliberately does not — it is
  // shelving, not a cabinet wall, and PPP paints it like a normal room.
  const combined = /(\band\b|&|\+|\/|,|\bw\/)/.test(s);
  if (s.includes("kitchen")) {
    // The same guard the bathroom branch below carries. "Kitchen & Dining",
    // "Kitchen/Dining", "Open Kitchen & Living Area" — labels PPP types, and
    // ones roomLabelFrom reproduces from ProductName__c — were capped at ONE
    // gallon for the whole open-plan area, because the cabinets that justify
    // the cap cover a fraction of it. Roughly a third of what it needs.
    const withOther = KITCHEN_WITH_OTHER.test(s);
    if (!(combined && withOther)) return "kitchen";
    return null;
  }
  // Word boundaries, not substrings. This used to decide only a note; since
  // the bathroom split (2026-09-17) it decides what is BOUGHT, and
  // "Pool bathhouse", "Bath House" and "Sunbathing deck" are not bathrooms.
  // "Bathroom" still matches, via its own alternative.
  // A bath HOUSE is a building, not a bathroom, and it is painted like a
  // normal room. Removed before the test so "Pool bath house" cannot match on
  // its first word.
  const cleaned = s.replace(/bath\s*houses?/g, " ");
  if (/\b(bathrooms?|bathrms?|baths?|powder\s*(rooms?|rms?)|en[\s-]?suites?|w\/?c)\b/.test(cleaned)) {
    // …but only when the bathroom IS the area. PPP types COMBINED areas —
    // "Master Bedroom & En suite", "Hall + Bath", "Bedroom w/ ensuite" — and
    // since the split this decides what is BOUGHT: the whole area would be
    // broken onto its own line and ordered on a bathroom product.
    //
    // It takes a CONJUNCTION to make it combined, not merely another room
    // word: "Hall bath" and "Master bath" are bathrooms named by where they
    // are, and treating them as halls and bedrooms would undo the split for
    // most of the bathrooms PPP has. A dash is not a conjunction either —
    // "Master Bath - 2nd floor" is one room.
    const joined = /(\band\b|&|\+|\/|,|\bw\/)/.test(cleaned);
    const otherRoom = BATHROOM_WITH_OTHER.test(cleaned);
    if (joined && otherRoom) return null;
    return "bathroom";
  }
  return null;
}
