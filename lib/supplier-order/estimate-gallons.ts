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
  // 1.75, not 2 (Karan 2026-09-08). A second coat does not cost a full first
  // coat's worth of paint — it goes onto a sealed, same-colour surface and
  // spreads further. Costing it as 2.0 was the single biggest source of
  // over-ordering: a 15x20 living room came out at 4 gallons of wall paint
  // where the crew buys 3, and an 8x10 bedroom at 2 where they buy 1.
  //
  // An explicit of_Coats__c on the line still WINS — that is measured data
  // about the job, not a default. This only changes what we assume when
  // Salesforce is silent, which is the overwhelming majority of lines.
  defaultCoats: 1.75,
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
  // Trim width: linear ft → paintable sq ft.
  trimWidthFt: 0.25,
  // Door FACE area (single-sided), added to trim only when door faces are in scope.
  doorFaceSqft: 20,
  // ROOM-TYPE DEFAULTS (Karan 2026-09-08). Two rooms where the geometry lies:
  //
  //   Kitchen  — cabinets, appliances and backsplash cover most of the wall the
  //              perimeter says is there, so a kitchen is "usually one gallon"
  //              regardless of size. We do not know the cabinet run, so rather
  //              than invent one the estimate is DEFAULTED and flagged for a
  //              human, which is honest about being a rule of thumb.
  //   Bathroom — small enough that a 5x7 is quarts, not gallons.
  //
  // Both apply ONLY when every room feeding that colour is of the type. A wall
  // colour shared between the kitchen and the living room is sized normally,
  // because the living room dominates and capping it at a gallon would leave
  // the crew short.
  kitchenDefaultGallons: 1,
  quartsPerGallon: 4,
  // Katie 2026-09-08. A kitchen sharing a colour with another room is no longer
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
  /** The line's free text — Salesforce Description and Colour Notes, joined.
   *  Read ONLY to spot an accent wall (Katie item 7): an accent wall is a
   *  second colour over part of one wall, and nothing in the geometry can see
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
  surfaces: string[];
  rooms: string[];
  /** R4.19: which rooms each surface covers, so the order screen can render
   *  "Walls — Kitchen, Bathroom · Ceiling — Kitchen". `surfaces` and `rooms`
   *  are flat lists that lost the pairing: a colour on the kitchen walls and
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
  /** An accent wall is in scope for this colour. The geometry cannot see one —
   *  it is a second colour over part of one wall — so the quantity is a guess
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
   *  Without the distinction, decrementing a colour to 0 didn't remove it: the
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

/** Katie item 7 — an accent wall anywhere in this colour's rooms. */
export function mentionsAccentWall(text: string | null | undefined): boolean {
  return /accent\s*wall/i.test(text ?? "");
}

export function classifyRoomType(label: string | null | undefined): "kitchen" | "bathroom" | null {
  const s = (label ?? "").toLowerCase();
  if (!s) return null;
  // "Kitchenette" counts; "Butler's pantry" deliberately does not — it is
  // shelving, not a cabinet wall, and PPP paints it like a normal room.
  if (s.includes("kitchen")) return "kitchen";
  if (s.includes("bath") || s.includes("powder room") || s.includes("ensuite") || s.includes("en-suite")) {
    return "bathroom";
  }
  return null;
}

type RoomCoverage = {
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
      ceiling: 0, walls: 0, trim: 0, floor: 0,
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

  const trimLf = perimeter + doors * cfg.casingDoorLf + windows * cfg.casingWindowLf + closets * cfg.casingClosetLf;
  const trimSqft = trimLf * cfg.trimWidthFt * coats
    + (room.paintDoorFaces ? doors * cfg.doorFaceSqft * coats : 0);

  return {
    ceiling: ceilingSqft, walls: wallSqft, trim: trimSqft, floor: floorSqft,
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
  /** Room types feeding this colour. A room-type default applies only when
   *  every one of them is that type — see kitchenDefaultGallons. */
  roomTypes: Set<"kitchen" | "bathroom" | "other">;
  /** Any contributing room mentions an accent wall, or paints one. */
  accentWall: boolean;
  /** Every surface on this colour is a door — Katie item 6, priced in quarts. */
  doorsOnly: boolean;
  /** Wall area to REMOVE if this colour turns out to be shared with a normal
   *  room — the kitchen half Katie asked for. Held separately because sharing
   *  is only known once every room has contributed. */
  kitchenSharedSqft: number;
  /** Which surface kinds this colour covers. The kitchen cap is about the WALL
   *  the cabinets stand against, so it must not touch a colour that also paints
   *  the ceiling — cabinets do not cover that, and a big kitchen ceiling capped
   *  at one gallon would leave the crew short. */
  kinds: Set<PaintSurfaceKind>;
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

  const bucketFor = (s: RoomSurface): Bucket => {
    const key = `${s.colorId}::${s.finish ?? ""}`;
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
      const b = bucketFor(s);
      b.surfaces.add(s.surfaceLabel);
      if (!isDoorSurface(s.surfaceLabel)) b.doorsOnly = false;
      // Accent detection is per ROOM, not per colour. An accent wall is its own
      // colour, so checking only this bucket's own surfaces flagged the accent
      // line and left the WALLS line — the quantity actually thrown off, since
      // part of that wall is now a different colour — unflagged.
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
        case "trim":    sqft = cov.trim;    missing = cov.trimMissing;    break;
        case "floor":   sqft = cov.floor;   missing = cov.floorMissing;   break;
        case "unsized": b.unsized = true;   break; // can't size — flag, no sqft
      }
      if (s.kind !== "unsized") {
        b.kinds.add(s.kind);
        // A kitchen sharing its colour contributes HALF its wall area (Katie
        // 2026-09-08) — the cabinets are still there even when the colour runs
        // on into the dining room. Applied to walls only: cabinets do not cover
        // the ceiling. Whether the colour is actually shared is not known until
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
    let reportedSqft = b.totalSqft;
    let bucketsCount = 0;
    let cans = 0;
    let unit: PaintUnit | undefined;
    let defaultedNote: string | null = null;
    if (sizable) {
      const onlyType = b.roomTypes.size === 1 ? [...b.roomTypes][0] : null;
      const shared = b.roomTypes.size > 1;
      // Cabinets justify discounting the WALL. They do not cover the ceiling,
      // so a colour that paints both is sized on its real area.
      const wallsOnly = b.kinds.size === 1 && b.kinds.has("walls");
      const ceilingOnly = b.kinds.size === 1 && b.kinds.has("ceiling");

      // A shared kitchen contributes half its wall area (Katie 2026-09-08),
      // rather than the all-or-nothing cap that applied before.
      reportedSqft = shared ? b.totalSqft - b.kitchenSharedSqft : b.totalSqft;
      const rawGallons = (reportedSqft / cfg.coverageSqftPerGallon) * (1 + cfg.bufferPct);
      ({ buckets: bucketsCount, cans } = packageGallons(rawGallons, cfg));
      if (shared && b.kitchenSharedSqft > 0) {
        defaultedNote = "Kitchen shares this colour — its wall area counted at half for the cabinets. Please review.";
      }

      if (onlyType === "kitchen" && (wallsOnly || ceilingOnly)) {
        // Kitchen on its own colour: one gallon, whatever the size. Karan
        // extended this to the ceiling on 2026-09-08 — "unless it's folded into
        // all the other ceilings", which is the `shared` branch above.
        bucketsCount = 0;
        cans = cfg.kitchenDefaultGallons;
        unit = "gal";
        defaultedNote = `Kitchen — defaulted to ${cfg.kitchenDefaultGallons} gal because cabinets cover most of the wall. Please review.`;
      } else if (onlyType === "bathroom" && ceilingOnly) {
        bucketsCount = 0;
        cans = cfg.bathroomCeilingQuarts;
        unit = "qt";
        defaultedNote = `Bathroom ceiling — defaulted to ${cfg.bathroomCeilingQuarts} qt. Please review.`;
      } else if (onlyType === "bathroom" && wallsOnly) {
        // WALLS only. Katie named walls and ceilings; a catch-all here also
        // swept up bathroom TRIM and ordered a gallon of it, which is absurd
        // for a few feet of casing — trim falls through to the quart path below.
        //
        // Why a gallon and not the three quarts the maths gives: four quarts IS
        // a gallon, so at three the tin is cheaper and the crew gets more paint.
        bucketsCount = 0;
        cans = cfg.bathroomWallGallons;
        unit = "gal";
        defaultedNote = `Bathroom — defaulted to ${cfg.bathroomWallGallons} gal. Please review.`;
      } else if (b.doorsOnly) {
        // Katie item 6: "door is a quart — we need to utilise quarts, not
        // always gallons." A door is a few square feet; rounding it up to a
        // full gallon is the same waste the whole review was about.
        const quarts = Math.max(1, Math.floor(rawGallons * cfg.quartsPerGallon));
        if (quarts >= cfg.quartsBecomeGallonAt) {
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
 * colour lines: a normal estimate already rolls into buckets on its own via
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
export function quantityKey(colorId: string, finish: string | null | undefined): string {
  return `${colorId}::${finish ?? ""}`;
}

/** Total container count for an override, in its own unit. */
export function overrideTotal(o: { buckets: number; cans: number; unit?: PaintUnit }): number {
  if (o.unit === "qt") return o.cans;
  if (o.unit === "bucket") return o.cans * GALLONS_PER_BUCKET;
  return o.buckets * GALLONS_PER_BUCKET + o.cans;
}

/** Re-package a raw container count into the shape its unit expects. Quarts
 *  stay loose; gallons roll up into 5-gal buckets. */
export function packageForUnit(total: number, unit: PaintUnit): { buckets: number; cans: number; unit: PaintUnit } {
  const t = Math.max(0, Math.floor(total));
  if (unit === "qt") return { buckets: 0, cans: t, unit };
  // A bucket count is already whole pails — `total` is gallons, so divide.
  if (unit === "bucket") return { buckets: 0, cans: Math.floor(t / GALLONS_PER_BUCKET), unit };
  return { buckets: Math.floor(t / GALLONS_PER_BUCKET), cans: t % GALLONS_PER_BUCKET, unit };
}

/** Apply the worker's typed quantities to the system estimates. An explicit
 *  override RESOLVES the line — it is no longer `manualOnly`, so every reader
 *  (list row, total, vendor email) sees the same number.
 *
 *  This is the single place that folds overrides in. Kate round-3 #26 came
 *  from the modal folding them for the TOTAL but not for the per-line rows,
 *  so a line read "manual entry required" while the total climbed. */
export function applyQuantityOverrides(
  estimates: GallonEstimate[],
  overrides: ReadonlyMap<string, QuantityOverride> | undefined
): GallonEstimate[] {
  if (!overrides || overrides.size === 0) return estimates;
  return estimates.map((e) => {
    const o = overrides.get(quantityKey(e.colorId, e.finish));
    if (!o) return e;
    // Clamp here as well as at the persistence boundary. The draft endpoint
    // validates paint lines but takes quantities as given, so this is the last
    // point before a number reaches a vendor's inbox — a typo or a garbled
    // payload should not be able to order 10,000 gallons of paint.
    const buckets = Math.max(0, Math.min(99, Math.floor(Number(o.buckets) || 0)));
    const cans = Math.max(0, Math.min(99, Math.floor(Number(o.cans) || 0)));
    const unit: PaintUnit = o.unit === "qt" ? "qt" : "gal";
    return {
      ...e,
      buckets: unit === "qt" ? 0 : buckets,
      cans,
      unit,
      gallons: unit === "qt" ? 0 : buckets * 5 + cans,
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
    // A deliberately-excluded colour is neither ordered nor outstanding — it
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
 * Fold worker-typed colour lines (Kate round-3 #28) into an order total.
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
  // Re-package the gallon side so added cans roll up into buckets the same way
  // an estimate would ("6 gal" reads as "1 bucket + 1 gal", not "6 gal").
  const totalGallonUnits = total.buckets * 5 + total.cans + gallons;
  return {
    buckets: Math.floor(totalGallonUnits / 5),
    cans: totalGallonUnits % 5,
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
