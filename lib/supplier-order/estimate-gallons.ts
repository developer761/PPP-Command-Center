/**
 * Paint gallons calculator — implements PPP's estimating spec.
 *
 * Source of truth: ppp-salesforce-reference/estimating/paint-gallons-calculator.md
 * (Katie, spec locked 2026-05-29). This file mirrors that spec exactly. If the
 * two ever disagree, the reference doc wins — update here to match.
 *
 * THE DATA GAP we bridge: Katie's per-room formulas need width W, length L,
 * height H and door/window/closet counts. Salesforce only reliably stores
 * Sq_Footage__c (= W × L = floor area); perimeter, height and opening counts are
 * fields that exist but are almost never populated. So, per Katie's "inputs used
 * when available, otherwise sensible defaults":
 *   - perimeter: WOLI.Perimeter__c when present, else 4 × √(floor area) (assumes
 *     a square room — exact for square rooms, slightly low for long ones).
 *   - height:    WOLI height when present, else DEFAULT_HEIGHT_FT.
 *   - openings:  WOLI Doors/Windows/Closets when present, else the defaults
 *     (1 door + 1 window per room, 0 closets).
 *
 * Output: a suggested ORDER per color+finish for the whole job — rolled up
 * across rooms, ÷ coverage, + buffer, then packaged into 5-gal buckets + 1-gal
 * cans. A defensible default a PM can trust and adjust; NOT a precise takeoff.
 *
 * Pure + deterministic: no I/O. Verify with scripts/verify-gallon-estimate.ts.
 */

/** All tunable constants in one place (Katie: "treat as named config, not
 *  magic numbers — PPP will tune per product / per SW vs BM"). */
export const COVERAGE_CONFIG = {
  // 1.5 (Jason + Alex, 2026-09-17), down from 1.75 and originally 2.0. A
  // second coat goes onto a sealed, same-color surface and spreads much
  // further than the first, and PPP's crews were still buying less than the
  // 1.75 assumption ordered.
  //
  // An explicit of_Coats__c on the line still WINS — that is measured data
  // about the job, not a default. This only changes what we assume when
  // Salesforce is silent, which is the overwhelming majority of lines.
  defaultCoats: 1.5,
  coverageSqftPerGallon: 375,
  bufferPct: 0.10,
  defaultHeightFt: 8,
  // Default openings when a room's counts aren't captured.
  defaultDoorsPerRoom: 1,
  defaultWindowsPerRoom: 1,
  defaultClosetsPerRoom: 0,
  // Wall-area deductions per opening (sq ft).
  deductDoorSqft: 20,
  deductWindowSqft: 15,
  deductClosetSqft: 30,
  // Trim casing additions per opening (linear ft).
  casingDoorLf: 17,
  casingWindowLf: 15,
  casingClosetLf: 18,
  // Trim width: linear ft → paintable sq ft. Kept for reference and for the
  // door-face maths; the trim ORDER is no longer sized from it (see below).
  trimWidthFt: 0.25,
  // TRIM, Jason + Alex 2026-09-17: "it should calculate linear feet total
  // within the rooms, add 25% for door and window molding. usually when the
  // trim is the same color through multiple rooms, 2+ is 1 gallon of trim
  // paint."
  //
  // The old model priced trim as a 3-inch-wide painted strip — geometrically
  // honest, and it produced 1 qt for a whole floor of trim, because it ignores
  // everything a brush costs: cut-in, back-brushing, what stays in the tray.
  // These two numbers are a USAGE rate taken from what PPP actually buys, not
  // a measurement: ~140 linear ft to the gallon at the default coat count.
  // Calibrated so ONE ordinary room still prices in quarts (Karan's trade
  // figures, 2026-09-08: a 15x20 living room's trim is not a gallon) while two
  // rooms cross the existing three-quarts-is-a-gallon line on their own.
  trimMoldingUpliftPct: 0.25,
  trimLfPerGallon: 140,
  /** A trim color spanning this many rooms is at least one gallon. */
  trimMultiRoomMinRooms: 2,
  // Door FACE area (single-sided), added to trim only when door faces are in scope.
  doorFaceSqft: 20,
  // The painted area of a window — sash, frame and stops — on an ordinary
  // double-hung. Deliberately NOT deductWindowSqft (the rough opening, glass
  // included): borrowing that ordered ~3x the paint a window needs.
  windowSashSqft: 5,
  // ROOM-TYPE DEFAULTS (Karan 2026-09-08). Two rooms where the geometry lies:
  //
  //   Kitchen  — cabinets, appliances and backsplash cover most of the wall the
  //              perimeter says is there, so a kitchen is "usually one gallon"
  //              regardless of size. We do not know the cabinet run, so rather
  //              than invent one the estimate is DEFAULTED and flagged for a
  //              human, which is honest about being a rule of thumb.
  //   Bathroom — small enough that a 5x7 is quarts, not gallons.
  //
  // Both apply ONLY when every room feeding that color is of the type. A wall
  // color shared between the kitchen and the living room is sized normally,
  // because the living room dominates and capping it at a gallon would leave
  // the crew short.
  kitchenDefaultGallons: 1,
  quartsPerGallon: 4,
  // Katie 2026-09-08. A kitchen sharing a color with another room is no longer
  // sized at full area: the cabinets still cover half its wall. "If the surface
  // area from dimensions = 300sq ft, then it only adds 150sq ft."
  kitchenSharedAreaFactor: 0.5,
  // Katie: "bathroom walls should be 1 gallon, bathroom ceilings are 1 quart."
  bathroomWallGallons: 1,
  bathroomCeilingQuarts: 1,
  // Katie: "generally if we're ordering 3qts, the price makes sense to just
  // order 1 gallon." Four quarts IS a gallon, so at three the tin is cheaper
  // than the quarts and the crew gets more paint for less money.
  quartsBecomeGallonAt: 3,
  // Packaging: individual cans up to this many gallons; switch to buckets above it.
  bucketThresholdGallons: 4,
  bucketSizeGallons: 5,
} as const;

export type CoverageConfig = typeof COVERAGE_CONFIG;

/** Which of Katie's three buckets (+ floor / unsized) a surface maps to. */
export type PaintSurfaceKind = "ceiling" | "walls" | "trim" | "floor" | "unsized";

/** One painted surface within a room. */
export type RoomSurface = {
  kind: PaintSurfaceKind;
  surfaceLabel: string; // original Surfaces__c label, for display
  colorId: string;
  colorName: string;
  colorCode: string | null;
  finish: string | null;
};

/** One room (work-order line item) + its geometry + painted surfaces. */
export type RoomTakeoff = {
  woliId: string;
  roomLabel: string;
  /** WOLI.Sq_Footage__c (floor area W×L). 0 / missing → "needs measurement". */
  floorAreaSqft: number;
  /** WOLI.Wall_Surface_Area__c — the MEASURED paintable wall area. When > 0 we
   *  trust it directly (most accurate) and skip the perimeter×height estimate +
   *  opening deductions (the measurement already reflects them). 0 → derive. */
  wallSurfaceAreaSqft: number;
  /** WOLI.Perimeter__c. 0 / missing → derived as 4×√(floor area). */
  perimeterLf: number;
  /** Room height. 0 / missing → DEFAULT_HEIGHT_FT. */
  heightFt: number;
  /** Raw opening counts (0 → Katie's per-room defaults). */
  doors: number;
  windows: number;
  closets: number;
  /** WOLI.of_Coats__c (0 → defaultCoats). */
  coats: number;
  /** Door faces in scope for this room? (default off — casings always count). */
  paintDoorFaces: boolean;
  /** The line's free text — Salesforce Description and Color Notes, joined.
   *  Read ONLY to spot an accent wall (Katie item 7): an accent wall is a
   *  second color over part of one wall, and nothing in the geometry can see
   *  it, so the line is flagged for a person instead of silently sized. */
  notes?: string | null;
  surfaces: RoomSurface[];
};

/** Suggested order for one color+finish across the whole job. */
export type GallonEstimate = {
  colorId: string;
  colorName: string;
  colorCode: string | null;
  finish: string | null;
  /** Bathrooms are ordered separately from the same color elsewhere in the
   *  house — they take a bathroom product (Jason + Alex 2026-09-17). Optional
   *  so a stored estimate written before the split still reads as non-bath. */
  isBathroom?: boolean;
  surfaces: string[];
  rooms: string[];
  /** R4.19: which rooms each surface covers, so the order screen can render
   *  "Walls — Kitchen, Bathroom · Ceiling — Kitchen". `surfaces` and `rooms`
   *  are flat lists that lost the pairing: a color on the kitchen walls and
   *  the bathroom ceiling read "Kitchen, Bathroom · Walls, Ceiling", which
   *  implies four combinations and names none of them. */
  placements: Array<{ surface: string; rooms: string[] }>;
  /** 2-coat, post-deduction coverage area summed across rooms (pre-buffer). */
  totalSqft: number;
  /** 5-gallon buckets to order. */
  buckets: number;
  /** Leftover 1-gallon cans to order — or, when `unit` is "qt", the whole
   *  quart count (quarts don't come in buckets). */
  cans: number;
  /** Container unit for this line (Kate round-3 #27). Absent = gallons; the
   *  estimator only ever produces gallons, quarts come from a worker choice. */
  unit?: PaintUnit;
  /** Total gallon-equivalent (buckets×5 + cans) — for sorting / sanity. */
  gallons: number;
  /** An accent wall is in scope for this color. The geometry cannot see one —
   *  it is a second color over part of one wall — so the quantity is a guess
   *  and a person is asked to look (Katie item 7). */
  accentWallReview: boolean;
  /** Set when a ROOM-TYPE default replaced the computed figure — a kitchen
   *  capped to one gallon, a bathroom expressed in quarts. Reads as a sentence
   *  for the worker, and is deliberately never silent: these are rules of
   *  thumb standing in for data we do not have (the cabinet run), so a person
   *  is asked to confirm rather than told a number. */
  defaultedNote: string | null;
  /** The maths produced REAL coverage but it rounded down to nothing — i.e.
   *  under a gallon. Distinct from "no paint needed" and from "no data":
   *  the surface IS being painted, PPP just takes it off the truck rather than
   *  ordering it. Without this the line renders as a bare "—" and a worker
   *  cannot tell which of the three it means. */
  sizedToZero: boolean;
  /** A contributing room had no floor area → this is an UNDER-count. */
  needsMeasurement: boolean;
  /** Surface we can't size from the data (accent wall, cabinets, …). */
  unsized: boolean;
  /** EVERY contributing room had ZERO measurement data on Salesforce — no
   *  floor area, no measured wall area, no perimeter. We CANNOT estimate at
   *  all; the order line MUST be filled manually by the worker. Stronger
   *  than `needsMeasurement` (which just means "may be low / under-count").
   *  Karan 2026-06-09: surface a banner, do not auto-suggest gallons. */
  manualOnly: boolean;
  /** The worker explicitly set this line to zero — "we're not buying this one".
   *  Distinct from an unsized/zero ESTIMATE, which means "we don't know yet".
   *  Without the distinction, decrementing a color to 0 didn't remove it: the
   *  vendor was emailed `___ — White Dove (PPP to confirm quantity)` for paint
   *  PPP had deliberately decided not to order, and the builder row nagged
   *  "⚠️ set qty" as though the worker had made a mistake. Only
   *  `applyQuantityOverrides` can set this — the estimator never produces it. */
  excluded?: boolean;
};

/** Map a Surfaces__c label to a paint bucket. Order matters: "Accent Wall"
 *  must be caught before "wall"; doors/windows are trim (casings/faces).
 *  Trims whitespace defensively — "Walls " from a customer-form payload
 *  shouldn't fall through to unsized. */
export function classifySurface(label: string): PaintSurfaceKind {
  const s = label.toLowerCase().trim();
  if (s.includes("accent")) return "unsized";
  if (s.includes("cabinet") || s.includes("closet") || s.includes("shelf") || s.includes("shelves")) return "unsized";
  if (s.includes("ceil")) return "ceiling";
  if (s.includes("trim") || s.includes("door") || s.includes("window")) return "trim";
  if (s.includes("floor")) return "floor";
  if (s.includes("wall")) return "walls";
  return "unsized";
}

/**
 * Room types whose paint order is decided by what is IN the room rather than
 * by its dimensions. Returns null for everything else — the normal maths.
 */
/** A door, as opposed to trim generally. Katie item 6: "door is a quart". */
export function isDoorSurface(label: string | null | undefined): boolean {
  const l = (label ?? "").toLowerCase();
  // "Door casing" is trim around the opening, not the door itself — it is
  // painted with the trim and must not drag a whole line into quarts.
  if (l.includes("casing") || l.includes("jamb") || l.includes("frame")) return false;
  return l.includes("door");
}

/** A window sash, as opposed to the trim around it. Same reasoning as
 *  isDoorSurface: a color painting only the windows should not be charged for
 *  the room's baseboard. A label naming BOTH ("Trim & Windows") is trim: the
 *  baseboard is the larger part and under-ordering it is the worse mistake. */
export function isWindowSurface(label: string | null | undefined): boolean {
  const l = (label ?? "").toLowerCase();
  if (l.includes("casing") || l.includes("jamb") || l.includes("frame") || l.includes("sill")) return false;
  if (l.includes("trim") || l.includes("door")) return false;
  return l.includes("window");
}

/** A label naming BOTH openings ("Doors & Windows") is neither on its own:
 *  pricing it as doors drops the windows. It takes the trim path, which is the
 *  larger figure — over-ordering a little beats sending a crew back. */
export function isCombinedOpeningSurface(label: string | null | undefined): boolean {
  const l = (label ?? "").toLowerCase();
  return l.includes("door") && l.includes("window");
}

/** Katie item 7 — an accent wall anywhere in this color's rooms. */
export function mentionsAccentWall(text: string | null | undefined): boolean {
  return /accent\s*wall/i.test(text ?? "");
}

export function classifyRoomType(label: string | null | undefined): "kitchen" | "bathroom" | null {
  const s = (label ?? "").toLowerCase();
  if (!s) return null;
  // "Kitchenette" counts; "Butler's pantry" deliberately does not — it is
  // shelving, not a cabinet wall, and PPP paints it like a normal room.
  if (s.includes("kitchen")) return "kitchen";
  // Word boundaries, not substrings. This used to decide only a note; since
  // the bathroom split (2026-09-17) it decides what is BOUGHT, and
  // "Pool bathhouse", "Bath House" and "Sunbathing deck" are not bathrooms.
  // "Bathroom" still matches, via its own alternative.
  // A bath HOUSE is a building, not a bathroom, and it is painted like a
  // normal room. Removed before the test so "Pool bath house" cannot match on
  // its first word.
  const cleaned = s.replace(/bath\s*houses?/g, " ");
  if (/\b(bathrooms?|bathrms?|baths?|powder\s*(rooms?|rms?)|en[\s-]?suites?|wc)\b/.test(cleaned)) {
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
    const otherRoom = /\b(bed|bedrooms?|living|dining|family|hall|hallway|foyer|entry|basement|attic|office|study|den|closets?|laundry|garage|deck|porch|kitchen)\b/.test(cleaned);
    if (joined && otherRoom) return null;
    return "bathroom";
  }
  return null;
}

type RoomCoverage = {
  /** Paintable area of the door faces themselves — used when a color paints
   *  the DOORS rather than the room's trim. */
  doorFaces: number;
  /** The same idea for window sashes. */
  windowFaces: number;
  ceiling: number; walls: number; trim: number; floor: number;
  // Per-bucket: was this surface's area derived without the data it needed
  // (so the figure is an under-count the worker should verify)?
  ceilingMissing: boolean; wallsMissing: boolean; trimMissing: boolean; floorMissing: boolean;
  // True when the ROOM has zero measurable data at all — no floor area, no
  // measured wall area, no perimeter. In that case we do NOT auto-derive from
  // default opening counts (Karan 2026-06-09: "no auto-calculation whatsoever"
  // when SF has no square footage). Returns all zeros + every Missing flag set.
  noDataAtAll: boolean;
};

/** True when the room has ANY measurement data we can build an estimate from. */
function hasAnyMeasurement(room: RoomTakeoff): boolean {
  return room.floorAreaSqft > 0 || room.wallSurfaceAreaSqft > 0 || room.perimeterLf > 0;
}

/** Per-room coverage sq ft for each bucket (2-coat, post-deduction). */
function roomCoverage(room: RoomTakeoff, cfg: CoverageConfig): RoomCoverage {
  // GUARD: no data at all → return zeros. Default openings would otherwise
  // synthesize ~16 sqft of trim per room (1 door + 1 window casings × 0.25 ft
  // trim width × 2 coats), spitting out a phantom ~1 can per color. Karan's
  // directive (2026-06-09): zero estimate + force manual entry instead.
  if (!hasAnyMeasurement(room)) {
    return {
      ceiling: 0, walls: 0, trim: 0, floor: 0, doorFaces: 0, windowFaces: 0,
      ceilingMissing: true, wallsMissing: true, trimMissing: true, floorMissing: true,
      noDataAtAll: true,
    };
  }

  const floor = room.floorAreaSqft > 0 ? room.floorAreaSqft : 0;
  const noFloor = floor <= 0;
  const coats = room.coats > 0 ? room.coats : cfg.defaultCoats;
  const height = room.heightFt > 0 ? room.heightFt : cfg.defaultHeightFt;
  const haveRealPerimeter = room.perimeterLf > 0;
  const perimeter = haveRealPerimeter
    ? room.perimeterLf
    : (floor > 0 ? 4 * Math.sqrt(floor) : 0); // assume square when no perimeter
  // Per-WO sanity cap: a typo of `numDoors=50` on one WOLI would silently
  // order 10× the paint. Cap each opening count at MAX_OPENINGS_PER_ROOM
  // (same ceiling we apply to the defaults in coverage-validation.ts) so
  // a single bad data entry can't run away with the gallon math.
  const MAX_OPENINGS_PER_ROOM = 20;
  const doorsRaw = room.doors > 0 ? room.doors : cfg.defaultDoorsPerRoom;
  const windowsRaw = room.windows > 0 ? room.windows : cfg.defaultWindowsPerRoom;
  const closetsRaw = room.closets > 0 ? room.closets : cfg.defaultClosetsPerRoom;
  const doors = Math.min(doorsRaw, MAX_OPENINGS_PER_ROOM);
  const windows = Math.min(windowsRaw, MAX_OPENINGS_PER_ROOM);
  const closets = Math.min(closetsRaw, MAX_OPENINGS_PER_ROOM);

  const ceilingSqft = floor * coats;
  const floorSqft = floor * coats;

  // Prefer the MEASURED paintable wall area when present (most accurate — it
  // already reflects this room's real walls + openings). Otherwise estimate
  // from perimeter × height minus standard opening deductions.
  const haveMeasuredWall = room.wallSurfaceAreaSqft > 0;
  let wallSqft: number;
  if (haveMeasuredWall) {
    wallSqft = room.wallSurfaceAreaSqft * coats;
  } else {
    const grossWall = perimeter * height;
    const wallDeduct = doors * cfg.deductDoorSqft + windows * cfg.deductWindowSqft + closets * cfg.deductClosetSqft;
    wallSqft = Math.max(0, grossWall - wallDeduct) * coats;
  }

  // Jason's model: the room's linear feet plus a flat 25% for door and window
  // molding. It replaces the per-opening casing constants (17/15/18 lf), which
  // asked Salesforce for door and window counts that are blank on most lines
  // and then guessed one of each anyway.
  const trimLf = perimeter * (1 + cfg.trimMoldingUpliftPct);
  // Converted into the sq-ft currency the rest of the pipeline divides by
  // coverageSqftPerGallon, so trim ends up at trimLf / trimLfPerGallon gallons.
  // Scaled by coats against the default, so a measured 3-coat line still costs
  // more trim paint than a 1-coat one.
  const trimSqftPerLf = cfg.coverageSqftPerGallon / Math.max(1, cfg.trimLfPerGallon);
  const coatFactor = cfg.defaultCoats > 0 ? coats / cfg.defaultCoats : 1;
  // The door faces ride on the TRIM line only when the room does not list the
  // doors as their own surface. When it does, they are priced on that line
  // (below) and adding them here charged for them twice.
  const hasOwnDoorSurface = room.surfaces.some((x) => isDoorSurface(x.surfaceLabel));
  const trimSqft = trimLf * trimSqftPerLf * coatFactor
    + (room.paintDoorFaces && !hasOwnDoorSurface ? doors * cfg.doorFaceSqft * coats : 0);
  // A DOOR is not the room's baseboard. A color painting only the doors used
  // to inherit the whole room's trim area — harmless while trim was priced as
  // a 3-inch strip (it still came to a quart), and not harmless at the
  // linear-foot rate, which turned two doors into a gallon. Katie item 6:
  // "door is a quart."
  const doorFacesSqft = Math.max(1, doors) * cfg.doorFaceSqft * coats;
  /** Sashes and frames. NOT `deductWindowSqft` (15), which is the ROUGH
   *  OPENING the wall maths removes — glass included — and would have bought
   *  three times the paint a sash needs. `windowSashSqft` is the painted part
   *  of an ordinary double-hung. */
  const windowFacesSqft = Math.max(1, windows) * cfg.windowSashSqft * coats;

  return {
    ceiling: ceilingSqft, walls: wallSqft, trim: trimSqft, floor: floorSqft,
    doorFaces: doorFacesSqft, windowFaces: windowFacesSqft,
    ceilingMissing: noFloor,
    floorMissing: noFloor,
    // walls fine if measured directly OR derivable from floor; missing only if neither.
    wallsMissing: !haveMeasuredWall && noFloor,
    // trim needs a perimeter; if neither a real perimeter nor a floor to derive
    // one, it's only the default casings — flag it.
    trimMissing: !haveRealPerimeter && noFloor,
    noDataAtAll: false, // we exited earlier if there's truly no data
  };
}

/**
 * Package raw gallons into 5-gal buckets + 1-gal cans (Katie's rule).
 *
 * ROUNDS DOWN (Karan 2026-09-08). It rounded up, which on top of the 2.0-coat
 * assumption meant a room needing 2.7 gallons was ordered 4. Rounding down
 * costs at most a can of slack against a crew that already carries stock;
 * rounding up cost a can on every single line of every order.
 *
 * A consequence worth stating, because it is the point rather than a side
 * effect: a surface needing less than a gallon now orders NOTHING. Trim at
 * 0.13 gallons and a small ceiling at 0.41 stop appearing on the vendor email
 * at all, which is what PPP actually does — those come off the truck. Callers
 * must therefore treat a zero as "from stock", not as "no paint needed", and
 * `sizedToZero` on the estimate says so explicitly.
 */
export function packageGallons(rawGallons: number, cfg: CoverageConfig = COVERAGE_CONFIG): { buckets: number; cans: number } {
  // NO automatic bucketing (Karan 2026-09-09: "if I have 5 gallons it shouldn't
  // automatically [convert] — instead when we add 5 gallons it gives us another
  // option for bucket next to Gallon/Quart").
  //
  // Five gallons and a five-gallon pail are not the same purchase: the pail is
  // cheaper per gallon but it is one container, and whether that suits the job
  // is the estimator's call, not arithmetic. Rolling it up silently made the
  // decision for them and put "1 bucket" on a vendor email nobody had chosen.
  //
  // The unit toggle offers Bucket once a line reaches five gallons, and
  // packageForUnit does the conversion when they pick it.
  void cfg;
  return { buckets: 0, cans: Math.floor(Math.max(rawGallons, 0)) };
}

type Bucket = {
  colorId: string;
  colorName: string;
  colorCode: string | null;
  finish: string | null;
  surfaces: Set<string>;
  rooms: Set<string>;
  /** surface label → the rooms it covers, insertion-ordered. */
  placements: Map<string, Set<string>>;
  totalSqft: number;
  anyMissingFloor: boolean;
  unsized: boolean;
  /** Track whether EVERY contributing room had zero measurement data. If yes,
   *  the estimate is `manualOnly` — the supplier-order UI + email render a
   *  strong "MUST be filled manually" banner. Karan 2026-06-09. */
  allRoomsNoData: boolean;
  contributingRoomCount: number;
  /** Room types feeding this color. A room-type default applies only when
   *  every one of them is that type — see kitchenDefaultGallons. */
  roomTypes: Set<"kitchen" | "bathroom" | "other">;
  /** Any contributing room mentions an accent wall, or paints one. */
  accentWall: boolean;
  /** Every surface on this color is a door — Katie item 6, priced in quarts. */
  doorsOnly: boolean;
  /** Wall area to REMOVE if this color turns out to be shared with a normal
   *  room — the kitchen half Katie asked for. Held separately because sharing
   *  is only known once every room has contributed. */
  kitchenSharedSqft: number;
  /** Which surface kinds this color covers. The kitchen cap is about the WALL
   *  the cabinets stand against, so it must not touch a color that also paints
   *  the ceiling — cabinets do not cover that, and a big kitchen ceiling capped
   *  at one gallon would leave the crew short. */
  kinds: Set<PaintSurfaceKind>;
  /** Bathroom paint is a different PRODUCT in the same color (Regal Select
   *  Kitchen & Bath, Aura Bath & Spa), so it is bought as its own line. */
  isBathroom: boolean;
};

/**
 * Roll a job's rooms into a suggested order per color+finish.
 * Per Katie: combine each color's coverage sq ft across ALL rooms, THEN
 * ÷ coverage, × (1 + buffer), then package — once, at the job level.
 */
export function estimateOrderGallons(
  rooms: RoomTakeoff[],
  cfg: CoverageConfig = COVERAGE_CONFIG
): GallonEstimate[] {
  const buckets = new Map<string, Bucket>();

  /**
   * Jason + Alex, 2026-09-17: "Bathrooms in the same color as non-bathrooms
   * needs to remain broken out for different paint products (regal kitchen &
   * bath or Aura bath & spa)."
   *
   * A bathroom takes a different PRODUCT in the same color, so its gallons are
   * bought separately. Keyed on color+finish alone, a bathroom sharing the
   * hall's white merged into one line that could carry only one product — and
   * the merge also cancelled the bathroom's own 1-gal / 1-qt default, because
   * that only fires when every contributing room is a bathroom.
   *
   * The suffix is appended only for bathrooms, so every other line keeps the
   * `colorId::finish` key that saved drafts and quantity overrides use.
   */
  const bucketFor = (s: RoomSurface, roomLabel: string): Bucket => {
    // Walls and ceilings only. The bathroom products exist for those surfaces
    // (Aura Bath & Spa is Matte, Regal Select Kitchen & Bath is Pearl), and
    // splitting TRIM would both invent a line no bathroom product can carry and
    // defeat Jason's "trim through multiple rooms is a gallon" — a bedroom and
    // a bathroom sharing one trim color would become two quarts.
    // Trim is excluded (a bathroom product is not a trim product) but an
    // UNSIZED surface — a vanity's Cabinets, an Accent Wall, Shelves — must
    // follow the room, or it forms a second line in the same color that the
    // vendor reads as a duplicate, and that phantom line then claims the
    // pre-split key the real bathroom line needs.
    const isBathroom =
      classifyRoomType(roomLabel) === "bathroom" &&
      (s.kind === "walls" || s.kind === "ceiling" || s.kind === "unsized");
    const key = quantityKey(s.colorId, s.finish, isBathroom);
    let b = buckets.get(key);
    if (!b) {
      b = {
        colorId: s.colorId, colorName: s.colorName, colorCode: s.colorCode, finish: s.finish,
        surfaces: new Set(), rooms: new Set(), placements: new Map(), totalSqft: 0, anyMissingFloor: false, unsized: false,
        allRoomsNoData: true, // assume yes until a measured room contributes
        contributingRoomCount: 0,
        roomTypes: new Set(),
        kinds: new Set(),
        kitchenSharedSqft: 0,
        accentWall: false,
        doorsOnly: true, // until a non-door surface joins
        isBathroom,
      };
      buckets.set(key, b);
    }
    return b;
  };

  for (const room of rooms) {
    const cov = roomCoverage(room, cfg);
    // Track which buckets have already received a contribution from THIS room so
    // we count "rooms contributing" cleanly (multiple surfaces of the same color
    // in one room = one room, not many).
    const seenThisRoom = new Set<Bucket>();
    const roomHasAccent =
      mentionsAccentWall(room.notes) ||
      room.surfaces.some((x) => mentionsAccentWall(x.surfaceLabel));
    for (const s of room.surfaces) {
      if (!s.colorId) continue;
      const b = bucketFor(s, room.roomLabel);
      b.surfaces.add(s.surfaceLabel);
      // Windows join doors here: both are priced from their own area, so a
      // window-only line must take the quart path rather than the trim floor
      // meant for baseboard through a house.
      if (
        isCombinedOpeningSurface(s.surfaceLabel) ||
        (!isDoorSurface(s.surfaceLabel) && !isWindowSurface(s.surfaceLabel))
      ) b.doorsOnly = false;
      // Accent detection is per ROOM, not per color. An accent wall is its own
      // color, so checking only this bucket's own surfaces flagged the accent
      // line and left the WALLS line — the quantity actually thrown off, since
      // part of that wall is now a different color — unflagged.
      if (roomHasAccent) b.accentWall = true;
      if (room.roomLabel) b.rooms.add(room.roomLabel);
      let placed = b.placements.get(s.surfaceLabel);
      if (!placed) {
        placed = new Set();
        b.placements.set(s.surfaceLabel, placed);
      }
      if (room.roomLabel) placed.add(room.roomLabel);
      if (!seenThisRoom.has(b)) {
        b.contributingRoomCount += 1;
        b.roomTypes.add(classifyRoomType(room.roomLabel) ?? "other");
        // If ANY contributing room has real data, the bucket isn't manualOnly.
        if (!cov.noDataAtAll) b.allRoomsNoData = false;
        seenThisRoom.add(b);
      }
      let sqft = 0;
      let missing = false;
      switch (s.kind) {
        case "ceiling": sqft = cov.ceiling; missing = cov.ceilingMissing; break;
        case "walls":   sqft = cov.walls;   missing = cov.wallsMissing;   break;
        case "trim":
          // "Door", "Doors", "Front door" — the door, not the casing around it.
          // isDoorSurface already excludes casing/jamb/frame, which stay trim.
          if (isCombinedOpeningSurface(s.surfaceLabel)) {
            sqft = cov.trim; missing = cov.trimMissing;
          } else if (isDoorSurface(s.surfaceLabel)) {
            sqft = cov.doorFaces;
            // A door count is real data or a default. `false` here claimed
            // every door line was measured, including rooms with no data at
            // all, so the "needs measurement" flag never reached a door.
            missing = cov.noDataAtAll || room.doors <= 0;
          } else if (isWindowSurface(s.surfaceLabel)) {
            // Windows got none of the door fix: a window-only color inherited
            // the whole room's perimeter at the trim rate, which made two
            // rooms of window sashes a gallon.
            sqft = cov.windowFaces;
            missing = cov.noDataAtAll || room.windows <= 0;
          } else { sqft = cov.trim; missing = cov.trimMissing; }
          break;
        case "floor":   sqft = cov.floor;   missing = cov.floorMissing;   break;
        case "unsized": b.unsized = true;   break; // can't size — flag, no sqft
      }
      if (s.kind !== "unsized") {
        b.kinds.add(s.kind);
        // A kitchen sharing its color contributes HALF its wall area (Katie
        // 2026-09-08) — the cabinets are still there even when the color runs
        // on into the dining room. Applied to walls only: cabinets do not cover
        // the ceiling. Whether the color is actually shared is not known until
        // every room has been walked, so the halved figure is accumulated
        // separately and chosen at the end.
        b.totalSqft += sqft;
        b.kitchenSharedSqft += s.kind === "walls" && classifyRoomType(room.roomLabel) === "kitchen"
          ? sqft * (1 - cfg.kitchenSharedAreaFactor)
          : 0;
        if (missing) b.anyMissingFloor = true;
      }
    }
  }

  const out: GallonEstimate[] = [];
  for (const b of buckets.values()) {
    // A bucket is "unsized" only if it had NO sizable coverage at all (every
    // surface was an unsizable one). If it also has real coverage, size it.
    const sizable = b.totalSqft > 0;
    // The area we REPORT has to be the area we priced, or the sq ft on screen
    // contradicts the gallons beside it — and Katie asked for that figure to be
    // shown precisely so a worker can check one against the other.
    //
    // ⚠️ For TRIM this is no longer an area a person can check: since
    // 2026-09-17 trim is priced from linear feet at a usage rate and converted
    // into this currency, so a 15x20 room reports ~234 "sq ft" of trim against
    // perhaps 26 sq ft of real painted moulding. Nothing renders it today
    // (checked across the residential UI and the vendor email). Any surface
    // that starts to must special-case trim, or show linear feet instead.
    let reportedSqft = b.totalSqft;
    let bucketsCount = 0;
    let cans = 0;
    let unit: PaintUnit | undefined;
    let defaultedNote: string | null = null;
    if (sizable) {
      const onlyType = b.roomTypes.size === 1 ? [...b.roomTypes][0] : null;
      const shared = b.roomTypes.size > 1;
      // Cabinets justify discounting the WALL. They do not cover the ceiling,
      // so a color that paints both is sized on its real area.
      const wallsOnly = b.kinds.size === 1 && b.kinds.has("walls");
      const ceilingOnly = b.kinds.size === 1 && b.kinds.has("ceiling");
      // A bathroom painted one color top to bottom satisfied NEITHER, so
      // Katie's bathroom rule quietly did not apply to the commonest bathroom
      // there is: 5x8 in one color came out a gallon, the same 5x8 split
      // across two colors came out a gallon AND a quart.
      const wallsAndCeilingOnly =
        b.kinds.size === 2 && b.kinds.has("walls") && b.kinds.has("ceiling");

      // A shared kitchen contributes half its wall area (Katie 2026-09-08),
      // rather than the all-or-nothing cap that applied before.
      reportedSqft = shared ? b.totalSqft - b.kitchenSharedSqft : b.totalSqft;
      const rawGallons = (reportedSqft / cfg.coverageSqftPerGallon) * (1 + cfg.bufferPct);
      ({ buckets: bucketsCount, cans } = packageGallons(rawGallons, cfg));
      if (shared && b.kitchenSharedSqft > 0) {
        defaultedNote = "Kitchen shares this color — its wall area counted at half for the cabinets. Please review.";
      }

      if (onlyType === "kitchen" && (wallsOnly || ceilingOnly)) {
        // Kitchen on its own color: one gallon, whatever the size. Karan
        // extended this to the ceiling on 2026-09-08 — "unless it's folded into
        // all the other ceilings", which is the `shared` branch above.
        bucketsCount = 0;
        cans = cfg.kitchenDefaultGallons;
        unit = "gal";
        defaultedNote = `Kitchen — defaulted to ${cfg.kitchenDefaultGallons} gal because cabinets cover most of the wall. Please review.`;
      } else if (onlyType === "bathroom" && ceilingOnly) {
        // A FLOOR, not a cap — but a TOTAL one. This arm is an `else if` in a
        // chain, so anything it leaves unset falls out of the chain entirely
        // rather than reaching the generic under-a-gallon rule below. Guarding
        // it on quarts without answering the other side left a dead band
        // (a 12x15 bath ceiling, or two small ones on one line) at ZERO —
        // "⚠️ set qty" on the screen and "TBD" to the vendor, on a room that
        // is measured. Every path out of here now sets a quantity.
        const quarts = Math.floor(rawGallons * cfg.quartsPerGallon);
        bucketsCount = 0;
        if (quarts <= cfg.bathroomCeilingQuarts) {
          cans = cfg.bathroomCeilingQuarts;
          unit = "qt";
          defaultedNote = `Bathroom ceiling — defaulted to ${cfg.bathroomCeilingQuarts} qt. Please review.`;
        } else if (cans === 0) {
          // Under a gallon but above the floor: price it honestly, with the
          // same three-quarts-is-a-gallon rule every other line gets.
          if (quarts >= cfg.quartsBecomeGallonAt) { cans = 1; unit = "gal"; }
          else { cans = quarts; unit = "qt"; }
        }
      } else if (onlyType === "bathroom" && (wallsOnly || wallsAndCeilingOnly)) {
        // WALLS only. Katie named walls and ceilings; a catch-all here also
        // swept up bathroom TRIM and ordered a gallon of it, which is absurd
        // for a few feet of casing — trim falls through to the quart path below.
        //
        // Why a gallon and not the three quarts the maths gives: four quarts IS
        // a gallon, so at three the tin is cheaper and the crew gets more paint.
        //
        // A FLOOR, not a cap — see the ceiling branch above. A 20x30 pool
        // bathhouse sharing the house color is 5 gallons of wall paint, and
        // before the split it was sized that way because the bucket also held
        // ordinary rooms. Replacing the number here would have bought 1.
        if (bucketsCount === 0 && cans < cfg.bathroomWallGallons) {
          cans = cfg.bathroomWallGallons;
          unit = "gal";
          defaultedNote = `Bathroom — defaulted to ${cfg.bathroomWallGallons} gal. Please review.`;
        }
      } else if (
        b.kinds.size === 1 && b.kinds.has("trim") &&
        // Katie item 6 still owns doors: a color painting only the doors is
        // not "the trim through multiple rooms", and the floor below would
        // turn four doors into a gallon.
        !b.doorsOnly &&
        b.contributingRoomCount >= cfg.trimMultiRoomMinRooms &&
        bucketsCount === 0 && cans < 1
      ) {
        // Jason + Alex: "usually when the trim is the same color through
        // multiple rooms, 2+ is 1 gallon of trim paint." The rate above
        // normally gets there on its own; this is the floor for small rooms,
        // and it is what stops the answer being 1 qt for a whole floor.
        bucketsCount = 0;
        cans = 1;
        unit = "gal";
        defaultedNote = `Trim in ${b.contributingRoomCount} rooms — at least 1 gal. Please review.`;
      } else if (b.doorsOnly) {
        // Katie item 6: "door is a quart — we need to utilise quarts, not
        // always gallons." A door is a few square feet; rounding it up to a
        // full gallon is the same waste the whole review was about.
        const quarts = Math.max(1, Math.floor(rawGallons * cfg.quartsPerGallon));
        if (rawGallons >= 1) {
          // Ten rooms of doors is not one gallon. The quart rule is for the
          // line that is UNDER a gallon; above it, the normal packaging
          // answers — this branch used to cap every door line at 1 gal.
          ({ buckets: bucketsCount, cans } = packageGallons(rawGallons, cfg));
          unit = "gal";
        } else if (quarts >= cfg.quartsBecomeGallonAt) {
          bucketsCount = 0; cans = 1; unit = "gal";
        } else {
          bucketsCount = 0; cans = quarts; unit = "qt";
        }
      } else if (bucketsCount === 0 && cans === 0) {
        // UNDER A GALLON. This used to order nothing at all and read "from
        // stock". Katie: "I would also recommend having the option to order 1
        // quart of this paint." So it is priced in quarts instead of dropped —
        // still the cheapest honest answer, but it reaches the vendor.
        const quarts = Math.max(1, Math.floor(rawGallons * cfg.quartsPerGallon));
        if (quarts >= cfg.quartsBecomeGallonAt) {
          cans = 1;
          unit = "gal";
        } else {
          cans = quarts;
          unit = "qt";
        }
      }
    }

    // manualOnly = EVERY contributing room had zero measurement data on SF, so
    // the math couldn't even attempt a sensible estimate. UI/email surfaces a
    // "MUST be filled manually" banner; gallons stay at 0. Karan 2026-06-09.
    const manualOnly = b.contributingRoomCount > 0 && b.allRoomsNoData && !sizable;
    out.push({
      colorId: b.colorId,
      colorName: b.colorName,
      colorCode: b.colorCode,
      finish: b.finish,
      isBathroom: b.isBathroom,
      surfaces: Array.from(b.surfaces),
      rooms: Array.from(b.rooms),
      placements: Array.from(b.placements, ([surface, rooms]) => ({ surface, rooms: Array.from(rooms) })),
      totalSqft: Math.round(reportedSqft),
      buckets: bucketsCount,
      cans,
      sizedToZero: sizable && bucketsCount === 0 && cans === 0,
      accentWallReview: b.accentWall,
      unit,
      defaultedNote,
      gallons: bucketsCount * cfg.bucketSizeGallons + cans,
      // Mixed sized + unsized (e.g. same color on walls AND cabinets in a
      // room): the gallons cover only the sized surfaces, so the figure is an
      // UNDER-count. Flag needsMeasurement so the UI surfaces "may be low" —
      // otherwise the worker would see a clean gallon number and miss the
      // cabinets contribution.
      needsMeasurement: sizable ? (b.anyMissingFloor || b.unsized) : true,
      unsized: !sizable && b.unsized,
      manualOnly,
    });
  }

  // Biggest orders first, sized before unsized, then color name.
  out.sort((a, z) =>
    (a.unsized ? 1 : 0) - (z.unsized ? 1 : 0) ||
    z.gallons - a.gallons ||
    a.colorName.localeCompare(z.colorName)
  );
  return out;
}

/* ─── Per-line unit selection (Kate round-3 #27) ─────────────────────────────
 * Around a fifth of the containers PPP actually buys are quarts, so a line's
 * quantity carries its own unit. Gallons keep the bucket/can packaging; quarts
 * are always loose containers (there is no 5-quart bucket), so a quart line
 * stores its whole count in `cans` and leaves `buckets` at 0.
 */

/**
 * Container a line is ordered in.
 *
 * "bucket" is a 5-gallon pail (Katie item 8). It exists only for HAND-TYPED
 * color lines: a normal estimate already rolls into buckets on its own via
 * packageGallons, so offering it there would be two ways to say the same thing.
 */
export type PaintUnit = "gal" | "qt" | "bucket";

/** Gallons in a 5-gallon pail. */
export const GALLONS_PER_BUCKET = 5;

/** A worker-set quantity for one color line — overrides the estimate. */
export type QuantityOverride = {
  buckets: number;
  cans: number;
  /** Defaults to "gal" when absent (every pre-#27 override). */
  unit?: PaintUnit;
};

/** Canonical key for a color line — shared by the builder, the order-builder
 *  UI and the persisted build payload so all three agree on identity. */
export function quantityKey(
  colorId: string,
  finish: string | null | undefined,
  isBathroom: boolean = false
): string {
  // The suffix is appended only for bathrooms (Jason + Alex 2026-09-17), so
  // every other key is byte-identical to the pre-split format that saved
  // drafts, quantity overrides and per-color product overrides already hold.
  return `${colorId}::${finish ?? ""}${isBathroom ? "::bath" : ""}`;
}

/** Total container count for an override, in its own unit. */
export function overrideTotal(o: { buckets: number; cans: number; unit?: PaintUnit }): number {
  if (o.unit === "qt") return o.cans;
  if (o.unit === "bucket") return o.cans * GALLONS_PER_BUCKET;
  return o.buckets * GALLONS_PER_BUCKET + o.cans;
}

/** Re-package a raw container count into the shape its unit expects.
 *
 *  Every unit stays LOOSE — nothing rolls up on its own. Karan 2026-09-09:
 *  "if I have 5 gallons it shouldn't automatically [bucket] — instead when we
 *  add 5 gallons it gives us another option for bucket next to Gallon Quart."
 *  Bucketing is now something a person PICKS, never something the system does
 *  behind them; `packageGallons` already stopped doing it and this was the
 *  other half, still turning a plain 6-gal order into "1 bucket + 1 gal" in
 *  the vendor's email. */
export function packageForUnit(total: number, unit: PaintUnit): { buckets: number; cans: number; unit: PaintUnit } {
  const t = Math.max(0, Math.floor(total));
  if (unit === "qt") return { buckets: 0, cans: t, unit };
  // A bucket count is already whole pails — `total` is gallons, so divide.
  if (unit === "bucket") return { buckets: 0, cans: Math.floor(t / GALLONS_PER_BUCKET), unit };
  return { buckets: 0, cans: t, unit };
}

/** Apply the worker's typed quantities to the system estimates. An explicit
 *  override RESOLVES the line — it is no longer `manualOnly`, so every reader
 *  (list row, total, vendor email) sees the same number.
 *
 *  This is the single place that folds overrides in. Kate round-3 #26 came
 *  from the modal folding them for the TOTAL but not for the per-line rows,
 *  so a line read "manual entry required" while the total climbed. */
/**
 * Plain `colorId::finish` keys that a NON-bathroom line on this job owns.
 *
 * The bathroom fallback below needs this, and getting it wrong is worse than
 * having no fallback at all: after the split the plain key is normally the
 * other line's LIVE key — the split exists because that color is used in both
 * places — so an unconditional fallback had the bathroom read the hall's
 * numbers and the hall's product, and a typed zero on the hall marked the
 * bathroom "not ordering" too.
 */
export function claimedPlainKeys(
  estimates: ReadonlyArray<{ colorId: string; finish: string | null; isBathroom?: boolean }>
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const e of estimates) if (!e.isBathroom) out.add(quantityKey(e.colorId, e.finish));
  return out;
}

/**
 * Read a per-color map, tolerating a draft saved BEFORE the bathroom split.
 *
 * Bathroom lines used to be keyed `colorId::finish` like everything else, so a
 * draft saved before 2026-09-17 still holds that key; reading only the new one
 * reverted what the estimator had typed, including a ZERO, which means "do not
 * buy this".
 *
 * The fallback applies ONLY when no other line on this job owns that plain key.
 * When one does, the saved value is that line's — reading it here would order
 * the bathroom's paint twice and print the wrong product on it.
 */
export function lookupByKey<T>(
  map: ReadonlyMap<string, T>,
  e: { colorId: string; finish: string | null; isBathroom?: boolean },
  claimed?: ReadonlySet<string>
): T | undefined {
  const exact = map.get(quantityKey(e.colorId, e.finish, e.isBathroom));
  if (exact !== undefined) return exact;
  if (!e.isBathroom) return undefined;
  const plain = quantityKey(e.colorId, e.finish);
  if (claimed?.has(plain)) return undefined;
  return map.get(plain);
}

export function applyQuantityOverrides(
  estimates: GallonEstimate[],
  overrides: ReadonlyMap<string, QuantityOverride> | undefined
): GallonEstimate[] {
  if (!overrides || overrides.size === 0) return estimates;
  const claimed = claimedPlainKeys(estimates);
  return estimates.map((e) => {
    const o = lookupByKey(overrides, e, claimed);
    if (!o) return e;
    // Clamp here as well as at the persistence boundary. The draft endpoint
    // validates paint lines but takes quantities as given, so this is the last
    // point before a number reaches a vendor's inbox — a typo or a garbled
    // payload should not be able to order 10,000 gallons of paint.
    const buckets = Math.max(0, Math.min(99, Math.floor(Number(o.buckets) || 0)));
    const cans = Math.max(0, Math.min(99, Math.floor(Number(o.cans) || 0)));
    // "bucket" used to fall through to "gal" here, which silently reinterpreted
    // the count: a worker picking 1 BUCKET (5 gal) had "1 gal" sent to the
    // vendor — a 5x under-order, on the exact control Karan asked for. The
    // unit is the worker's decision; carry it through untouched.
    const unit: PaintUnit = o.unit === "qt" ? "qt" : o.unit === "bucket" ? "bucket" : "gal";
    return {
      ...e,
      buckets: unit === "gal" ? buckets : 0,
      cans,
      unit,
      gallons:
        unit === "qt" ? 0
        : unit === "bucket" ? cans * GALLONS_PER_BUCKET
        : buckets * GALLONS_PER_BUCKET + cans,
      // An explicitly-typed quantity is an answer, not a gap.
      manualOnly: false,
      unsized: false,
      // ...including zero, which is the answer "don't order this one".
      excluded: buckets === 0 && cans === 0,
    };
  });
}

/** Job-level roll-up of an order — totals per unit + how many colors are
 *  sized vs. need a manual quantity. Drives the at-a-glance "order total". */
export function summarizeOrder(estimates: GallonEstimate[]): {
  buckets: number; cans: number; quarts: number; sizedColors: number; reviewColors: number;
} {
  let buckets = 0, cans = 0, quarts = 0, sizedColors = 0, reviewColors = 0;
  for (const e of estimates) {
    // A deliberately-excluded color is neither ordered nor outstanding — it
    // must not inflate "(+ N to confirm)" on the vendor email's TOTAL line.
    if (e.excluded) continue;
    if (e.buckets > 0 || e.cans > 0) {
      if (e.unit === "qt") {
        quarts += e.cans;
      } else {
        buckets += e.buckets;
        cans += e.cans;
      }
      sizedColors += 1;
    } else {
      reviewColors += 1;
    }
  }
  return { buckets, cans, quarts, sizedColors, reviewColors };
}

/**
 * Fold worker-typed color lines (Kate round-3 #28) into an order total.
 *
 * They render as real order lines, so they have to count toward TOTAL —
 * otherwise the vendor cross-checks the total against the lines and it doesn't
 * add up, which is worse than showing no total at all. Only gallons and quarts
 * are summable; anything else (a typed unit we don't model) is deliberately
 * left out of the arithmetic rather than silently miscounted as gallons.
 */
export function addCustomItemsToTotal(
  total: { buckets: number; cans: number; quarts: number; sizedColors: number; reviewColors: number },
  items: ReadonlyArray<{ qty: number; unit: string }>
): { buckets: number; cans: number; quarts: number; sizedColors: number; reviewColors: number } {
  let gallons = 0;
  let quarts = total.quarts;
  for (const it of items) {
    const qty = Math.max(0, Math.floor(Number(it.qty) || 0));
    if (qty <= 0) continue;
    const unit = (it.unit || "gal").trim().toLowerCase();
    if (unit === "qt") quarts += qty;
    else if (unit === "bucket") gallons += qty * GALLONS_PER_BUCKET;
    else if (unit === "gal") gallons += qty;
  }
  // NOT re-packaged. Karan 2026-09-09: nothing rolls up into buckets on its
  // own — `packageGallons` and `packageForUnit` were both changed for that and
  // this one was missed, so the rows read "6 gal" while the total underneath
  // them read "1 bucket (x5 gal) + 1 gal" for the same order.
  const totalGallonUnits = total.buckets * GALLONS_PER_BUCKET + total.cans + gallons;
  return {
    buckets: 0,
    cans: totalGallonUnits,
    quarts,
    sizedColors: total.sizedColors,
    reviewColors: total.reviewColors,
  };
}

/** "2 buckets (×5 gal) + 3 gal" / "5 gal" / "4 qt" / "—". */
export function formatBucketsCans(buckets: number, cans: number, unit: PaintUnit = "gal"): string {
  if (unit === "qt") return cans > 0 ? `${cans} qt` : "—";
  if (unit === "bucket") {
    return cans > 0 ? `${cans} bucket${cans === 1 ? "" : "s"} (×${GALLONS_PER_BUCKET} gal)` : "—";
  }
  const parts: string[] = [];
  if (buckets > 0) parts.push(`${buckets} bucket${buckets === 1 ? "" : "s"} (×5 gal)`);
  if (cans > 0) parts.push(`${cans} gal`);
  return parts.length ? parts.join(" + ") : "—";
}

/** Job-level total across both units, e.g. "1 bucket (×5 gal) + 2 gal · 3 qt". */
export function formatOrderTotal(t: { buckets: number; cans: number; quarts: number }): string {
  const parts: string[] = [];
  const gal = formatBucketsCans(t.buckets, t.cans, "gal");
  if (gal !== "—") parts.push(gal);
  if (t.quarts > 0) parts.push(`${t.quarts} qt`);
  return parts.length ? parts.join(" · ") : "—";
}

/** Human-readable order, e.g. "1 bucket + 2 gal", "3 qt", "manual entry required". */
export function formatOrderQuantity(e: GallonEstimate): string {
  if (e.excluded) return "not ordering";
  if (e.manualOnly) return "manual entry required";
  if (e.unsized) return "needs review";
  // Checked BEFORE needsMeasurement: a line that rounded under a gallon is a
  // stock item, not a data problem, and labelling it "needs measurement" would
  // send a worker to re-measure a room that is measured fine.
  if (e.sizedToZero) return "under 1 gal — from stock";
  if (e.buckets === 0 && e.cans === 0) return e.needsMeasurement ? "needs measurement" : "—";
  return formatBucketsCans(e.buckets, e.cans, e.unit ?? "gal");
}

/**
 * A color's display label, without printing its code twice (R4.24).
 *
 * PPP's `PaintColor__c.Name` usually already starts with the code, and for some
 * colors the name IS the code:
 *
 *     Name "1421 Bistro Blue"   Code "1421"          → "1421 Bistro Blue"
 *     Name "Super White"        Code "Super White"   → "Super White"
 *     Name "OC-45 Swiss Coffee" Code "OC-45"         → "OC-45 Swiss Coffee"
 *     Name "White Dove"         Code "OC-17"         → "White Dove OC-17"
 *
 * Appending unconditionally produced order lines reading "1421 Bistro Blue 1421"
 * and "Super White Super White", which a vendor reasonably reads as two
 * different things.
 *
 * Comparison strips non-alphanumerics and case, so "HC-14" is recognised inside
 * "HC 14 Princeton Gold" — the hyphenation is inconsistent in PPP's data and a
 * literal `includes` would miss it.
 */
export function formatColorLabel(
  name: string | null | undefined,
  code: string | null | undefined
): string {
  const n = (name ?? "").trim();
  const c = (code ?? "").trim();
  if (!c) return n;
  if (!n) return c;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nn = norm(n);
  const nc = norm(c);
  // An empty normalised code (a code of "—" or "-") carries no information.
  if (!nc) return n;
  return nn.includes(nc) ? n : `${n} ${c}`;
}
