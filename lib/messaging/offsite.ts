/**
 * Does this JOB need somebody to stand in the room?
 *
 * ── TWO RULES, OPPOSITE REQUIREMENTS, ONE TEMPLATE ──────────────────────
 *
 * A6 OFFSITE REQUIRED: "when the JOB routes off-site, PRESENT the quick quote
 * instead of running the in-person booking flow. The route is a LOOKUP in the
 * JOB ROUTING LOOKUP, not a judgement, and it does not depend on the customer
 * asking for anything." A reason is FORBIDDEN — Kate's own findings read
 * "reason clause on an off-site presentation - A6 mandates none."
 *
 * A7 OFFSITE OFFERED: the job routes ONSITE and the customer qualifies anyway.
 * A reason is MANDATED: "for projects like this we like to visit in person,
 * but since [reason they qualify], we can provide a quick quote." This is the
 * ONE exception to A32's cut-the-reason standard.
 *
 * "A6 is REQUIRED and states the quick quote as the plan; A7 is OPTIONAL and
 * asks. Different sentences, different situations." They shared one template
 * carrying A7's reason, so every A6 turn breached A6 and A32 together. 164
 * breaches between them, both critical.
 *
 * ── THE ROUTE IS A LOOKUP, AND THAT IS WHY IT IS CODE ───────────────────
 *
 * Kate wrote it as a table and said twice that it is not a judgement. A table
 * in a prompt is a suggestion; a table in code is the answer. The model's job
 * is to say what the customer told us the work IS — this decides where that
 * work goes.
 *
 * Pure. No clock, no database, no model.
 */

export type JobRoute = "offsite" | "onsite";

/**
 * `null` means UNKNOWN, and it is the common answer.
 *
 * Neither rule may fire on a guess. A6 forces a presentation and A7 needs the
 * job to route onsite, so inventing a route sends the customer the wrong one
 * of two sentences with total confidence. Unknown means keep asking what the
 * job is, which is what A6's card demands anyway: "NEVER route from the SIZE
 * field on the record. 'Exterior: Small' is not a trigger — ask what the job
 * IS."
 */
export type RouteVerdict =
  | { route: JobRoute; why: string }
  | null;

/** Interior rooms. A hallway is deliberately absent — see below. */
const ROOM =
  /\b(?:bed\s?rooms?|bath\s?rooms?|living\s?rooms?|dining\s?rooms?|family\s?rooms?|kitchens?|offices?|dens?|basements?|attics?|nurser(?:y|ies)|playrooms?|laundry\s?rooms?|rooms?)\b/gi;

/**
 * "A hallway is NOT a full room" — Kate, stated in the lookup itself.
 *
 * Listed so it can be recognised and NOT counted, rather than simply missing
 * from ROOM: a job described only as a hallway is a legible interior job under
 * two full rooms, which routes offsite. Silence would make it unknown.
 */
const NOT_A_ROOM = /\b(?:hall\s?ways?|halls?|stairwells?|staircases?|landings?|closets?|foyers?|entryways?|corridors?)\b/gi;

/** Exterior items small and legible enough to quote from a photo. */
const SMALL_EXTERIOR =
  /\b(?:windows?|shutters?|doors?|garage\s?doors?|sheds?|railings?|fences?|columns?|posts?|mail\s?box(?:es)?|gutters?|downspouts?|trim)\b/i;

/**
 * The exterior job that always needs a visit, whatever its size.
 *
 * "home" and "house" are NOT here on their own, and the corpus is why. Bare
 * matching routed "Sure, I'm home all day, please let me know before coming"
 * and "it was Michael who came to my house the last time" as exterior wall
 * jobs — neither describes a job at all. The words only mean the walls when
 * something else says so: a whole one, the exterior of one, its body, or a
 * cladding material that IS the wall.
 */
const HOME_WALLS = new RegExp(
  [
    String.raw`\b(?:siding|stucco|clapboard)\b`,
    String.raw`\bexterior\s+(?:walls?|of\s+(?:the|my|our)\s+(?:home|house))\b`,
    String.raw`\b(?:whole|full|entire)\s+(?:home|house|exterior)\b`,
    String.raw`\bbody\s+of\s+the\s+(?:home|house)\b`,
    String.raw`\b(?:home|house)\s+exterior\b`,
    String.raw`\b(?:paint|painting|stain)\w*\s+(?:the\s+|my\s+|our\s+)?(?:home|house)\b`,
  ].join("|"),
  "i"
);

/**
 * Does this text describe WORK at all?
 *
 * Required before anything routes. "I'm home all day" and "Available Monday"
 * are scheduling, not scope, and a lookup that answers them is answering a
 * question nobody asked. Kate's own instruction points the same way: "NEVER
 * route from the SIZE field on the record — ask what the job IS."
 */
const DESCRIBES_WORK =
  /\b(?:paint\w*|stain\w*|refinish\w*|coat\w*|primer|priming|touch[\s-]?ups?|patch\w*|spackle|drywall|dry\s?wall|estimate|quote|project|job|redo|spray\w*)\b/i;

const EXTERIOR = /\b(?:exterior|outside|outdoor)\b/i;
const INTERIOR = /\b(?:interior|inside|indoor)\b/i;
const CABINETS = /\b(?:kitchen\s+cabinets?|cabinets?|cabinetry)\b/i;

/** Written numbers people actually use for room counts. */
const WORD_NUMBER: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  a: 1, an: 1, single: 1, couple: 2, few: 3, several: 3,
};

/**
 * How many FULL rooms the customer described, or null when it cannot be told.
 *
 * Counts explicit quantities ("3 bedrooms", "two rooms") and distinct named
 * rooms ("the living room and the dining room"). Hallways and closets are
 * recognised and excluded, per the lookup.
 */
export function roomCount(text: string): number | null {
  const t = text.toLowerCase();

  // "3 bedrooms", "two rooms", "a couple of rooms"
  let total = 0;
  let sawAny = false;
  const quantified = new RegExp(
    String.raw`\b(\d{1,2}|${Object.keys(WORD_NUMBER).join("|")})\s+(?:\w+\s+){0,2}?(${ROOM.source.slice(3, -3)})\b`,
    "gi"
  );
  for (const m of t.matchAll(quantified)) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUMBER[m[1]];
    if (!Number.isFinite(n)) continue;
    total += n;
    sawAny = true;
  }
  if (sawAny) return total;

  // No quantities: count distinct named rooms, ignoring the ones that are not
  // full rooms.
  const stripped = t.replace(NOT_A_ROOM, " ");
  const named = new Set((stripped.match(ROOM) ?? []).map((r) => r.replace(/\s+/g, "").replace(/s$/, "")));
  if (named.size) return named.size;

  // Only non-rooms named: "just the hallway" is a real, legible job.
  if (NOT_A_ROOM.test(t)) return 0;
  return null;
}

/**
 * Where this job goes, per Kate's lookup.
 *
 * `area` is the workspace or territory fragment, for the one geographic
 * exception in the table: kitchen cabinets are ONSITE except in Queens.
 */
export function jobRoute(scope: string | null | undefined, area?: string | null): RouteVerdict {
  const t = (scope ?? "").trim();
  if (!t) return null;
  // Scheduling, pleasantries and everything else that is not a description of
  // work. Routing those is answering a question nobody asked.
  if (!DESCRIBES_WORK.test(t)) return null;

  // Cabinets first: the row has its own geography and would otherwise be
  // swallowed by the interior rules, since a kitchen is a room.
  if (CABINETS.test(t)) {
    if (area && /queens/i.test(area)) {
      return { route: "offsite", why: "kitchen cabinets in the Queens area" };
    }
    return { route: "onsite", why: "kitchen cabinets" };
  }

  const exterior = EXTERIOR.test(t) || SMALL_EXTERIOR.test(t) || HOME_WALLS.test(t);
  const rooms = roomCount(t);
  // rooms !== null, not rooms > 0. "Just the hallway" counts ZERO full rooms
  // and is still plainly an interior job — under two rooms, so it routes
  // offsite. Requiring a positive count made it unknown, which is the one
  // answer the lookup does not have for it.
  const interior = INTERIOR.test(t) || rooms !== null;

  // Both named is a mixed job, and the lookup has no row for one. Onsite is
  // not the safe default either — it is a guess — so this stays unknown and
  // the bot keeps asking.
  if (exterior && interior && !EXTERIOR.test(t)) return null;

  if (exterior) {
    // HOME WALLS, any size, is ONSITE always — and it wins over a small item
    // mentioned alongside it, because the walls still need the visit.
    if (HOME_WALLS.test(t)) return { route: "onsite", why: "exterior home walls, which always need a visit" };
    if (SMALL_EXTERIOR.test(t)) return { route: "offsite", why: "a smaller, clearly defined exterior item" };
    // "exterior" alone says nothing about which row applies.
    return null;
  }

  if (interior) {
    if (rooms === null) return null;
    if (rooms >= 2) return { route: "onsite", why: "two or more full rooms" };
    return { route: "offsite", why: rooms === 0 ? "no full rooms, which is a legible interior job" : "fewer than two full rooms" };
  }

  return null;
}
