/**
 * Build a room's true floor plan by walking its walls.
 *
 * WHY THIS EXISTS. Everything before it asks for length × width, which assumes
 * the room is a rectangle. Plenty aren't: an L-shaped living room, a kitchen
 * with a pantry bump-out, a bedroom with a chimney breast. Measuring one of
 * those as length × width overstates the floor and understates the perimeter —
 * both in the direction that gets the paint wrong.
 *
 * HOW. Walk the room and record each wall as you pass it. Corners in houses are
 * square, so knowing which WAY each corner turns is enough to place every wall
 * exactly — no protractor, no angles to enter. An outside corner turns one way,
 * the notch of an L turns the other.
 *
 * That gives a real polygon, and from it:
 *   · floor area by the shoelace formula, exact for any shape
 *   · perimeter as the actual sum of the walls
 *   · a CLOSURE CHECK, which is the part that earns its keep — if the walls
 *     don't return you to where you started, a measurement is wrong, and the
 *     size of the gap says by how much. Nothing else in the tool can catch a
 *     mistyped wall.
 */

export type Turn = "right" | "left";

export type WallSegment = {
  /** Wall length in feet. */
  lengthFt: number;
  /** Which way the corner at the END of this wall turns. */
  turn: Turn;
  /** Optional label — "window wall", "behind the sofa". */
  note?: string;
};

export type PlanPoint = { x: number; y: number };

export type FloorPlan = {
  /** Corner positions in feet, first point at the origin. */
  points: PlanPoint[];
  /** Shoelace area. 0 until the shape closes. */
  floorAreaSqft: number;
  /** Sum of the wall lengths — the real perimeter, whatever the shape. */
  perimeterLf: number;
  /** Distance from the last corner back to the first. */
  closureGapFt: number;
  closed: boolean;
  /** Walls cross over each other — the turns are wrong somewhere. */
  selfIntersecting: boolean;
  /** Extent, for drawing to scale. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

/** A gap under this reads as a rounding difference, not a mistake. */
export const CLOSURE_TOLERANCE_FT = 0.5;

/** Screen-style axes: +x right, +y down. Index order is a right turn. */
const DIRECTIONS: PlanPoint[] = [
  { x: 1, y: 0 },   // east
  { x: 0, y: 1 },   // south
  { x: -1, y: 0 },  // west
  { x: 0, y: -1 },  // north
];

const round = (n: number) => Math.round(n * 100) / 100;

/** Do two segments properly cross? Touching at a shared endpoint doesn't count
 *  — consecutive walls always share one. */
function segmentsCross(p1: PlanPoint, p2: PlanPoint, p3: PlanPoint, p4: PlanPoint): boolean {
  const d = (a: PlanPoint, b: PlanPoint, c: PlanPoint) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  // Strict signs only: a zero means collinear or touching, which for a
  // rectilinear walk is a shared corner rather than a crossing.
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function buildFloorPlan(walls: WallSegment[]): FloorPlan {
  const usable = walls.filter((w) => Number.isFinite(w.lengthFt) && w.lengthFt > 0);
  const points: PlanPoint[] = [{ x: 0, y: 0 }];
  let dir = 0;

  for (const wall of usable) {
    const cur = points[points.length - 1];
    const v = DIRECTIONS[dir];
    points.push({ x: round(cur.x + v.x * wall.lengthFt), y: round(cur.y + v.y * wall.lengthFt) });
    dir = wall.turn === "right" ? (dir + 1) % 4 : (dir + 3) % 4;
  }

  const perimeterLf = round(usable.reduce((a, w) => a + w.lengthFt, 0));
  const first = points[0];
  const last = points[points.length - 1];
  const closureGapFt = round(Math.hypot(last.x - first.x, last.y - first.y));
  // Three walls can never enclose a rectilinear room — every corner is square,
  // so the sides must come in opposing pairs.
  const closed = usable.length >= 4 && closureGapFt <= CLOSURE_TOLERANCE_FT;

  // Shoelace over the closed ring. Reported only when the shape closes: the
  // formula returns a number for an open path too, and it would be meaningless.
  let floorAreaSqft = 0;
  if (closed) {
    const ring = points.slice(0, -1); // drop the duplicated closing corner
    let sum = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      sum += a.x * b.y - b.x * a.y;
    }
    floorAreaSqft = round(Math.abs(sum) / 2);
  }

  // Crossed walls mean a turn is wrong somewhere — the area would be wrong in a
  // way that looks entirely reasonable, so it has to be surfaced.
  let selfIntersecting = false;
  for (let i = 0; i < points.length - 1 && !selfIntersecting; i++) {
    for (let j = i + 2; j < points.length - 1; j++) {
      if (i === 0 && j === points.length - 2) continue; // first and last share a corner
      if (segmentsCross(points[i], points[i + 1], points[j], points[j + 1])) {
        selfIntersecting = true;
        break;
      }
    }
  }

  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  return {
    points,
    floorAreaSqft,
    perimeterLf,
    closureGapFt,
    closed,
    selfIntersecting,
    bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
  };
}

/**
 * Paintable wall area for a plan.
 *
 * Uses the REAL perimeter, so an L-shaped room gets the wall it actually has
 * rather than the wall a bounding rectangle would have.
 */
export function wallAreaFromPlan(
  plan: FloorPlan,
  ceilingFt: number,
  openings: { doors?: number; windows?: number } = {}
): { grossWallSqft: number; paintableWallSqft: number; ceilingAssumed: boolean } {
  // 8 ft is the right guess for residential Long Island, but a guess it is —
  // and this figure becomes a paint order. Report that it was assumed.
  const assumed = !(ceilingFt > 0);
  const h = assumed ? 8 : ceilingFt;
  const grossWallSqft = round(plan.perimeterLf * h);
  const doors = Math.max(0, Math.floor(openings.doors ?? 0));
  const windows = Math.max(0, Math.floor(openings.windows ?? 0));
  const deduction = doors * 20 + windows * 15;
  // Same floor as the rectangular path: a slip claiming 12 doors must not drive
  // the wall area to nothing and under-order the paint.
  return {
    grossWallSqft,
    paintableWallSqft: round(Math.max(grossWallSqft * 0.4, grossWallSqft - deduction)),
    ceilingAssumed: assumed,
  };
}

/**
 * What's wrong with the plan, in words a painter can act on.
 *
 * Ordered by what to fix first, and deliberately specific: "you're 3 ft short"
 * is actionable where "invalid shape" is not.
 */
export function planProblems(plan: FloorPlan, walls: WallSegment[]): string[] {
  const out: string[] = [];
  const usable = walls.filter((w) => w.lengthFt > 0).length;
  if (usable === 0) return ["Add your first wall to start the plan."];
  if (usable < 4) {
    out.push(`A room needs at least 4 walls — you have ${usable}. Keep going round.`);
    return out;
  }
  if (plan.selfIntersecting) {
    out.push("The walls cross over each other, so a corner is turning the wrong way. Check where the room bends inward.");
  }
  if (!plan.closed) {
    out.push(
      `The walls don't return to where you started — you're ${plan.closureGapFt} ft out. ` +
      `Usually one wall is mistyped, or a corner turns the wrong way.`
    );
  }
  return out;
}

/**
 * Compare against the rectangle the old two-number capture would have assumed,
 * so the value of walking the room is visible rather than asserted.
 */
export function versusBoundingRectangle(plan: FloorPlan): {
  rectAreaSqft: number;
  rectPerimeterLf: number;
  areaDiffPct: number;
  perimeterDiffPct: number;
} | null {
  if (!plan.closed || plan.floorAreaSqft <= 0) return null;
  const w = plan.bounds.maxX - plan.bounds.minX;
  const h = plan.bounds.maxY - plan.bounds.minY;
  const rectAreaSqft = round(w * h);
  const rectPerimeterLf = round(2 * (w + h));
  return {
    rectAreaSqft,
    rectPerimeterLf,
    areaDiffPct: rectAreaSqft > 0 ? round(((rectAreaSqft - plan.floorAreaSqft) / plan.floorAreaSqft) * 100) : 0,
    perimeterDiffPct: plan.perimeterLf > 0 ? round(((rectPerimeterLf - plan.perimeterLf) / plan.perimeterLf) * 100) : 0,
  };
}
