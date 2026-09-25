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
    // "paint my home office" is a ROOM, and this matched it as the exterior
    // of a house — the same shape as "I'm home all day" that the comment
    // above already guards against, one word further on.
    String.raw`\b(?:re)?(?:paint|painting|stain)\w*\s+(?:the\s+|my\s+|our\s+)?(?:home|house)\b(?!\s*(?:office|gym|theat(?:er|re)|bar|library|studio|interior|inside))`,
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
  // (?:re)? for the same reason scope.ts needed it: \bpaint has no word
  // boundary inside "repaint", so "repaint the stairwells" described no work
  // at all and nothing downstream ever ran.
  //
  // wallpaper, repair, scraping and resurfacing joined the lookup on
  // 2026-09-25 — A6 gained rows for them, and a row cannot fire if the text
  // never gets past this gate.
  /\b(?:re)?(?:paint\w*|stain\w*|finish\w*|coat\w*|surfac\w*|do)\b|\b(?:primer|priming|touch[\s-]?ups?|patch\w*|spackle|drywall|dry\s?wall|sheet\s?rock|wall\s?paper\w*|repair\w*|scrap\w*|replac\w*|hang\w*|water\s+damage|estimate|quote|project|job|redo|spray\w*)\b/i;

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
/**
 * COMMERCIAL ROUTES ONSITE — A6's gate, which sits ABOVE the lookup.
 *
 * Kate, 2026-09-25: "IF THE PROPERTY IS COMMERCIAL, THE JOB ROUTES ONSITE.
 * Any scope, any size, no exceptions on the JOB side." So this is read before
 * the component rows, the same way A2's zip gate sits above all of A6.
 *
 * TWO HALVES, AND THE SECOND ONE IS A PROHIBITION. Shared space in a
 * multi-unit building counts — "the lobby, the common areas, the corridors,
 * the stairwells, the whole floor" — but "THE TRIGGER IS THE SPACE, NEVER THE
 * BUILDING": co-op, condo, tenant and apartment "must never be treated as
 * commercial signals". A condo owner painting their own living room is a
 * residential interior job.
 *
 * KATE, THIS IS THE ONE THING I COULD NOT RECONCILE. A3 lists "the tenants"
 * among the phrases that establish commercial; A6 names "tenant" among the
 * words that must never fire it. They cannot both hold, so this follows A6,
 * because A6 owns the gate and states its half as a never. Worth a line in
 * the sheet either way.
 */
const COMMERCIAL_SPACE =
  /\b(?:lobb(?:y|ies)|common\s+areas?|corridors?|stair\s?wells?|the\s+whole\s+floor|entire\s+floor|suites?)\b/i;

const COMMERCIAL_PROPERTY =
  /\b(?:dentists?|dental|doctors?|medical|clinics?|law\s+(?:firm|office)|stores?|shops?|storefronts?|retail|restaurants?|cafes?|bars?|salons?|gyms?|warehouses?|hotels?|motels?|schools?|churches|church|offices?\s+building|commercial|business(?:es)?)\b/i;

/** "our building", "our facility" — the possessive is what makes it a business. */
const COMMERCIAL_OURS = /\b(?:our|the)\s+(?:building|facility|premises|property\s+management)\b/i;

/**
 * Words that describe where somebody LIVES and must not route anything.
 * Named explicitly so a future edit cannot quietly add them to the list above.
 */
const NOT_COMMERCIAL = /\b(?:co-?ops?|condos?|condominiums?|tenants?|apartments?|apt)\b/i;

export function isCommercial(scope: string | null | undefined): boolean {
  const t = (scope ?? "").trim();
  if (!t) return false;
  // A named shared space fires even in a residential building — that is the
  // whole point of the multi-unit clause.
  if (COMMERCIAL_SPACE.test(t)) return true;
  // "home office" is a room in a house, not an office building.
  const withoutHomeOffice = t.replace(/\bhome\s+offices?\b/gi, " ");
  return COMMERCIAL_PROPERTY.test(withoutHomeOffice) || COMMERCIAL_OURS.test(withoutHomeOffice);
}

/** Wallpaper: one wall or less is off-site, more than one wall is not. */
const WALLPAPER = /\bwall\s?paper\w*\b/i;
const ONE_WALL_OR_LESS =
  /\b(?:one|a|an|single|accent|1)\s+wall\b|\bhalf\s+(?:a\s+)?wall\b/i;
const MORE_THAN_ONE_WALL =
  /\b(?:two|three|four|several|all|every|both|\d+)\s+walls\b|\b(?:whole|entire)\s+room\b|\bwalls\b/i;

/**
 * Drywall: "PATCHES IS THE WHOLE DRYWALL TEST. The test is the KIND of work,
 * not how many rooms it touches." Patches stay off-site across several rooms;
 * board replacement, hanging or finishing new board, and resurfacing a whole
 * wall or ceiling do not.
 */
const DRYWALL_WORK =
  /\b(?:dry\s?wall|sheet\s?rock|plaster\w*|patch\w*|holes?|cracks?|water\s+damage|scrap\w*|resurfac\w*)\b/i;
const PATCHES_ONLY = /\b(?:patch\w*|holes?|cracks?|small\s+damaged\s+areas?)\b/i;
const MORE_THAN_PATCHES =
  /\b(?:replac\w*|hang\w*|new\s+board|board\s+to\s+replace|resurfac\w*|water\s+damage|scrap\w*)\b/i;

/**
 * "PARTIAL-ROOM WORK COUNTS AS FEWER THAN TWO FULL ROOMS. A single wall, a
 * ceiling only, or trim only is eligible on the interior row, on the same
 * logic that a hallway is not a full room."
 */
const PARTIAL_ROOM =
  /\b(?:accent\s+wall|one\s+wall|single\s+wall|ceilings?\s+only|just\s+the\s+ceilings?|trim\s+only|just\s+the\s+trim|baseboards?\s+only)\b/i;

/** One row of the lookup. `eligible: null` means the row cannot be resolved yet. */
type Component = { name: string; eligible: boolean | null; why: string };

/**
 * Route the job, reading the lookup PER COMPONENT.
 *
 * Kate, 2026-09-25: "ONSITE DOMINATES — THE JOB IS OFF-SITE ONLY IF EVERY
 * PART OF IT IS... A single ineligible component routes the whole job ONSITE,
 * no matter what else is in scope. THIS IS NOT A COUNT OF COMPONENTS: two
 * eligible components stay off-site."
 *
 * Her two worked examples, and this function is checked against both:
 *   "Kitchen cabinets in Queens plus one accent wall"  → OFF-SITE
 *   "cabinets plus three rooms"                        → ONSITE
 *
 * UNRESOLVED IS NOT ONSITE. "Where the lookup is run and a fact is missing,
 * the answer is ASK for that fact — the lookup has not returned ONSITE, it
 * has not returned at all." So an unresolvable row returns null, and null
 * still means keep asking, exactly as before.
 */
export function jobRoute(scope: string | null | undefined, area?: string | null): RouteVerdict {
  const t = (scope ?? "").trim();
  if (!t) return null;
  // Scheduling, pleasantries and everything else that is not a description of
  // work. Routing those is answering a question nobody asked.
  // A named surface is a description of work even with no verb: "just the
  // ceiling" is scope, and A6 now routes it on the interior row.
  if (!DESCRIBES_WORK.test(t) && !PARTIAL_ROOM.test(t)) return null;

  // THE GATE, ABOVE THE LOOKUP. Any scope, any size, no exceptions.
  if (isCommercial(t)) {
    return { route: "onsite", why: "commercial work, which is always seen in person" };
  }

  const parts: Component[] = [];

  // A ROOM WORD ON A CABINET JOB IS NOT A SECOND COMPONENT. "Bathroom
  // cabinets" and "kitchen cabinets" are cabinet jobs; the room word only
  // says which cabinets. Removed before anything counts rooms.
  const withoutCabinetRooms = t.replace(
    /\b(?:kitchen|bath\s?room|bath|bed\s?room|laundry|garage|office)\s+(?:cabinets?|cabinetry)\b/gi,
    " cabinets ",
  );

  if (CABINETS.test(t)) {
    const queens = !!area && /queens/i.test(area);
    parts.push({
      name: "cabinets",
      eligible: queens,
      why: queens ? "kitchen cabinets in the Queens area" : "kitchen cabinets",
    });
  }

  if (WALLPAPER.test(t)) {
    const one = ONE_WALL_OR_LESS.test(t);
    const many = !one && MORE_THAN_ONE_WALL.test(t);
    parts.push({
      name: "wallpaper",
      eligible: one ? true : many ? false : null,
      why: one ? "wallpaper on one wall or less" : many ? "wallpaper on more than one wall" : "wallpaper, but not how many walls",
    });
  }

  if (DRYWALL_WORK.test(t)) {
    const more = MORE_THAN_PATCHES.test(t);
    const patches = !more && PATCHES_ONLY.test(t);
    parts.push({
      name: "drywall",
      eligible: more ? false : patches ? true : null,
      why: more ? "drywall work beyond patching" : patches ? "drywall patches" : "drywall work, but not which kind",
    });
  }

  const exterior = EXTERIOR.test(t) || SMALL_EXTERIOR.test(t) || HOME_WALLS.test(t);
  if (exterior) {
    if (HOME_WALLS.test(t)) {
      parts.push({ name: "exterior", eligible: false, why: "exterior home walls, which always need a visit" });
    } else if (SMALL_EXTERIOR.test(t)) {
      parts.push({ name: "exterior", eligible: true, why: "a smaller, clearly defined exterior item" });
    } else {
      // "exterior" alone says nothing about which row applies.
      parts.push({ name: "exterior", eligible: null, why: "exterior, but not what on it" });
    }
  }

  // Interior is only its own component when something other than the rows
  // above says so — otherwise "kitchen cabinets" would count a kitchen.
  const rooms = roomCount(withoutCabinetRooms);
  const partial = PARTIAL_ROOM.test(t);
  const interiorNamed = INTERIOR.test(withoutCabinetRooms) || rooms !== null || partial;
  if (interiorNamed && !(parts.length && rooms === null && !partial && !INTERIOR.test(withoutCabinetRooms))) {
    if (partial && (rooms === null || rooms < 2)) {
      parts.push({ name: "interior", eligible: true, why: "partial-room work, which is fewer than two full rooms" });
    } else if (rooms === null) {
      parts.push({ name: "interior", eligible: null, why: "interior, but not how many rooms" });
    } else if (rooms >= 2) {
      parts.push({ name: "interior", eligible: false, why: "two or more full rooms" });
    } else {
      parts.push({
        name: "interior",
        eligible: true,
        why: rooms === 0 ? "no full rooms, which is a legible interior job" : "fewer than two full rooms",
      });
    }
  }

  if (!parts.length) return null;

  // A missing fact is a question, not a route.
  const unresolved = parts.find((p) => p.eligible === null);
  if (unresolved) return null;

  // ONSITE DOMINATES.
  const blocking = parts.find((p) => p.eligible === false);
  if (blocking) return { route: "onsite", why: blocking.why };

  return {
    route: "offsite",
    why: parts.length === 1 ? parts[0].why : parts.map((p) => p.why).join(", and "),
  };
}
