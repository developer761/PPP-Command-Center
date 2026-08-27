import { describe, it, expect } from "vitest";
import {
  cameraForward, depressionAngle, groundPoint, groundDistance,
  groundErrorEstimate, groundAimQuality, averageAttitude, attitudeSpread,
  calibrateHeight, type Attitude,
} from "@/lib/measure/ground-plane";

const FT = 0.3048;
const D2R = Math.PI / 180;

/**
 * The attitude that aims the crosshair at a given floor point.
 *
 * Derived from the forward vector: with gamma = 0 the ground point works out to
 * d·(−sin α, cos α), so the bearing inverts as atan2(−x, y) and the pitch is
 * whatever depression puts the ray at horizontal distance d.
 */
function aimAt(px: number, py: number, h: number): Attitude {
  const d = Math.hypot(px, py);
  const theta = Math.atan(h / d);
  return { alpha: Math.atan2(-px, py) / D2R, beta: 90 - theta / D2R, gamma: 0 };
}

describe("ground-plane measuring — geometry", () => {
  it("a phone flat on the table aims straight down", () => {
    // Pins the W3C convention: Z is up, and beta=0 is face-up on a table, so
    // the rear camera looks at the table. Getting this axis wrong turns "aim at
    // the floor" into "aim at the north wall".
    const f = cameraForward({ alpha: 0, beta: 0, gamma: 0 });
    expect(f.x).toBeCloseTo(0, 9);
    expect(f.y).toBeCloseTo(0, 9);
    expect(f.z).toBeCloseTo(-1, 9);
    const at = groundPoint({ alpha: 0, beta: 0, gamma: 0 }, 1.5)!;
    expect(at.x).toBeCloseTo(0, 9);
    expect(at.y).toBeCloseTo(0, 9);
  });

  it("a phone held upright aims at the horizon and cannot reach the floor", () => {
    const level: Attitude = { alpha: 0, beta: 90, gamma: 0 };
    expect(depressionAngle(level)).toBeCloseTo(0, 6);
    // No intersection: a level ray never meets the floor, and pretending it
    // does would return a distance racing to infinity as the phone tilts up.
    expect(groundPoint(level, 1.5)).toBeNull();
    expect(groundPoint({ alpha: 0, beta: 110, gamma: 0 }, 1.5)).toBeNull();
  });

  it("reproduces d = h / tan(depression)", () => {
    for (const deg of [15, 30, 45, 60]) {
      const a: Attitude = { alpha: 0, beta: 90 - deg, gamma: 0 };
      expect(depressionAngle(a) / D2R).toBeCloseTo(deg, 6);
      const p = groundPoint(a, 1.5)!;
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(1.5 / Math.tan(deg * D2R), 6);
    }
  });

  it("round-trips an aimed point back to where it was aimed", () => {
    const h = 1.5;
    for (const target of [{ x: 0, y: 3 }, { x: -1.83, y: 3.05 }, { x: 2.4, y: 1.2 }]) {
      const p = groundPoint(aimAt(target.x, target.y, h), h)!;
      expect(p.x).toBeCloseTo(target.x, 6);
      expect(p.y).toBeCloseTo(target.y, 6);
    }
  });

  it("refuses nonsense heights rather than returning a number", () => {
    expect(groundPoint({ alpha: 0, beta: 45, gamma: 0 }, 0)).toBeNull();
    expect(groundPoint({ alpha: 0, beta: 45, gamma: 0 }, -1.5)).toBeNull();
    expect(groundPoint({ alpha: 0, beta: 45, gamma: 0 }, NaN)).toBeNull();
  });

  it("error grows as the aim flattens, not linearly", () => {
    // ∂d/∂θ = -h/sin²θ, so halving the depression roughly quadruples the error.
    // This is why the warning is tied to aim angle, not to a fixed tolerance.
    const steep = groundErrorEstimate(40 * D2R, 1.5);
    const flat = groundErrorEstimate(10 * D2R, 1.5);
    expect(flat).toBeGreaterThan(steep * 5);
  });

  it("rejects an aim too flat to trust", () => {
    expect(groundAimQuality(3 * D2R, 1.5).usable).toBe(false);
    expect(groundAimQuality(30 * D2R, 1.5).usable).toBe(true);
    expect(groundAimQuality(-5 * D2R, 1.5).reason).toMatch(/aim down/i);
  });
});

/**
 * The question that decides whether this ships: how wrong is it in a real room?
 *
 * Deterministic pseudo-noise (no Math.random — the harness forbids it and a
 * flaky accuracy test is worse than none). Attitude noise of 1° is a fair
 * figure for a gravity-referenced pitch estimate on a phone held by hand.
 */
function noisy(a: Attitude, k: number, deg: number): Attitude {
  const j = (n: number) => Math.sin(n * 12.9898) * 43758.5453;
  const f = (n: number) => ((j(n) - Math.floor(j(n))) * 2 - 1) * deg;
  return { alpha: a.alpha + f(k), beta: a.beta + f(k + 7.1), gamma: a.gamma + f(k + 13.7) };
}

describe("ground-plane measuring — measured accuracy", () => {
  const h = 1.5;                       // phone held ~5ft up
  const wallFt = 12;
  const wall = wallFt * FT;

  /** Stand back `awayFt` from a 12ft wall and measure it corner to corner. */
  function measureWall(awayFt: number, noiseDeg: number) {
    const away = awayFt * FT;
    const A = { x: -wall / 2, y: away };
    const B = { x: wall / 2, y: away };
    const errs: number[] = [];
    for (let k = 0; k < 200; k++) {
      const pa = groundPoint(noisy(aimAt(A.x, A.y, h), k, noiseDeg), h);
      const pb = groundPoint(noisy(aimAt(B.x, B.y, h), k + 101, noiseDeg), h);
      if (!pa || !pb) continue;
      errs.push(Math.abs(groundDistance(pa, pb) - wall));
    }
    errs.sort((x, y) => x - y);
    return {
      medianIn: (errs[Math.floor(errs.length / 2)] / FT) * 12,
      p90In: (errs[Math.floor(errs.length * 0.9)] / FT) * 12,
      medianPct: (errs[Math.floor(errs.length / 2)] / wall) * 100,
    };
  }

  it("is usable close in, and degrades with distance — the numbers, not a promise", () => {
    const near = measureWall(6, 1);
    const mid = measureWall(10, 1);
    const far = measureWall(16, 1);
    // Printed so the accuracy band is visible in CI output rather than folklore.
    console.log("  12ft wall, 1° attitude noise, phone at 5ft:");
    for (const [name, r] of [["6ft back", near], ["10ft back", mid], ["16ft back", far]] as const) {
      console.log(`    ${name.padEnd(9)} median ${r.medianIn.toFixed(1)}in (${r.medianPct.toFixed(1)}%)  p90 ${r.p90In.toFixed(1)}in`);
    }
    // Error must grow with distance — that is the whole shape of the method.
    expect(mid.medianIn).toBeGreaterThan(near.medianIn);
    expect(far.medianIn).toBeGreaterThan(mid.medianIn);
  });

  it("close range lands around 1.5% — the measured figure, not a hoped-for one", () => {
    // Standing 6ft off a 12ft wall, phone at 5ft, 1° attitude noise. This came
    // out at ~2.2in median (~1.5%). Asserted as a band so a regression that
    // doubles it fails, and so the number in the UI copy stays honest.
    const r = measureWall(6, 1);
    expect(r.medianIn).toBeLessThan(3.5);
    expect(r.medianPct).toBeLessThan(2.5);
  });

  it("a steadier hand helps roughly linearly", () => {
    // Attitude noise dominates at close range, so halving it should roughly
    // halve the error — worth knowing before trying to average more samples.
    const oneDeg = measureWall(6, 1).medianIn;
    const halfDeg = measureWall(6, 0.5).medianIn;
    console.log(`  hand steadiness at 6ft: 1.0° -> ${oneDeg.toFixed(1)}in, 0.5° -> ${halfDeg.toFixed(1)}in`);
    expect(halfDeg).toBeLessThan(oneDeg);
  });

  it("shows why aiming across a big room cannot be trusted", () => {
    // This is the case the UI has to refuse rather than quietly report.
    expect(measureWall(20, 1).medianPct).toBeGreaterThan(3);
  });
});


describe("holding still and averaging — does it actually help?", () => {
  const h = 1.5, FT2 = 0.3048, wall = 12 * FT2;

  function measureAveraged(awayFt: number, noiseDeg: number, burst: number) {
    const away = awayFt * FT2;
    const A = { x: -wall / 2, y: away }, B = { x: wall / 2, y: away };
    const errs: number[] = [];
    for (let k = 0; k < 200; k++) {
      const sa: Attitude[] = [], sb: Attitude[] = [];
      for (let i = 0; i < burst; i++) {
        sa.push(noisy(aimAt(A.x, A.y, h), k * 97 + i, noiseDeg));
        sb.push(noisy(aimAt(B.x, B.y, h), k * 97 + i + 5000, noiseDeg));
      }
      const pa = groundPoint(averageAttitude(sa)!, h);
      const pb = groundPoint(averageAttitude(sb)!, h);
      if (!pa || !pb) continue;
      errs.push(Math.abs(groundDistance(pa, pb) - wall));
    }
    errs.sort((x, y) => x - y);
    return {
      medianIn: (errs[Math.floor(errs.length / 2)] / FT2) * 12,
      p90In: (errs[Math.floor(errs.length * 0.9)] / FT2) * 12,
    };
  }

  it("averaging a held burst cuts the error, including the tail", () => {
    const one = measureAveraged(6, 1, 1);
    const half = measureAveraged(6, 1, 30);   // ~0.5s at 60Hz
    const full = measureAveraged(6, 1, 60);   // ~1s
    console.log("  12ft wall from 6ft back, 1 deg noise:");
    console.log(`    single sample   median ${one.medianIn.toFixed(2)}in  p90 ${one.p90In.toFixed(2)}in`);
    console.log(`    30-sample hold  median ${half.medianIn.toFixed(2)}in  p90 ${half.p90In.toFixed(2)}in`);
    console.log(`    60-sample hold  median ${full.medianIn.toFixed(2)}in  p90 ${full.p90In.toFixed(2)}in`);
    // The tail is what buys the wrong paint, so assert on p90 too.
    expect(full.medianIn).toBeLessThan(one.medianIn);
    expect(full.p90In).toBeLessThan(one.p90In);
  });

  it("averages the compass the long way round, not through 180 degrees", () => {
    // A plain mean of 359 and 1 gives 180 — the measurement would point across
    // the room in the wrong direction and read as a plausible number.
    const avg = averageAttitude([
      { alpha: 359, beta: 60, gamma: 0 },
      { alpha: 1, beta: 60, gamma: 0 },
    ])!;
    expect(Math.min(avg.alpha, 360 - avg.alpha)).toBeLessThan(1);
  });

  it("reports how still the hand was", () => {
    const steady = attitudeSpread([
      { alpha: 0, beta: 60.0, gamma: 0 }, { alpha: 0, beta: 60.1, gamma: 0 },
    ]);
    const wobbly = attitudeSpread([
      { alpha: 0, beta: 55, gamma: 0 }, { alpha: 0, beta: 65, gamma: 0 },
    ]);
    expect(steady).toBeLessThan(0.3);
    expect(wobbly).toBeGreaterThan(4);
    expect(attitudeSpread([{ alpha: 0, beta: 60, gamma: 0 }])).toBe(Infinity);
  });
});


describe("height calibration — the error averaging cannot remove", () => {
  it("recovers the true holding height from one known length", () => {
    // Assumed 1.50m but really holding at 1.62m: everything reads 8% short.
    const assumed = 1.50, actual = 1.62, trueLen = 12 * 0.3048;
    const measuredWithWrongHeight = trueLen * (assumed / actual);
    expect(calibrateHeight(assumed, measuredWithWrongHeight, trueLen)).toBeCloseTo(actual, 6);
  });

  it("a wrong height is a straight percentage error on every distance", () => {
    // Documents why this matters more than hand steadiness: 2in in 60in is 3.3%,
    // an order of magnitude worse than the 0.34in the burst-average achieves.
    const h = 1.5, D2R2 = Math.PI / 180, theta = 30 * D2R2;
    const trueD = h / Math.tan(theta);
    const withBadHeight = (h + 0.05) / Math.tan(theta);
    expect(((withBadHeight - trueD) / trueD) * 100).toBeCloseTo((0.05 / h) * 100, 6);
  });

  it("refuses a height no human could be holding a phone at", () => {
    // A mistyped known length would otherwise poison every later measurement.
    expect(calibrateHeight(1.5, 0.5, 12)).toBeNull();     // absurdly tall
    expect(calibrateHeight(1.5, 12, 0.2)).toBeNull();     // absurdly low
    expect(calibrateHeight(1.5, 0, 3.6)).toBeNull();
    expect(calibrateHeight(0, 3.6, 3.6)).toBeNull();
    expect(calibrateHeight(1.5, 3.6, NaN)).toBeNull();
  });

  it("accepts a plausible correction", () => {
    const h = calibrateHeight(1.5, 3.5, 3.66);
    expect(h).not.toBeNull();
    expect(h!).toBeGreaterThan(1.5);
    expect(h!).toBeLessThan(1.7);
  });
});
