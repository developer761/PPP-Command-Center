import { describe, it, expect } from "vitest";
import { initialGesture, pointerDown, pointerMove, pointerUp } from "@/lib/measure/gesture";

/**
 * Regression cover for a bug that shipped and was caught only by driving the
 * real component: capture-before-bookkeeping meant a thrown NotFoundError
 * skipped the pointer registration, and the photo silently would not pan.
 */
describe("pan and pinch bookkeeping", () => {
  it("pans by the pointer delta", () => {
    let s = pointerDown(initialGesture(), 1, { x: 100, y: 100 });
    const r = pointerMove(s, 1, { x: 130, y: 80 });
    expect(r.effect).toEqual({ kind: "pan", dx: 30, dy: -20 });
  });

  it("accumulates across successive moves rather than re-basing", () => {
    let s = pointerDown(initialGesture(), 1, { x: 0, y: 0 });
    let total = { x: 0, y: 0 };
    for (const p of [{ x: 10, y: 5 }, { x: 25, y: 15 }, { x: 20, y: 40 }]) {
      const r = pointerMove(s, 1, p);
      s = r.state;
      if (r.effect.kind === "pan") { total.x += r.effect.dx; total.y += r.effect.dy; }
    }
    expect(total).toEqual({ x: 20, y: 40 });   // ends where the finger ended
  });

  it("ignores a move for a pointer that never went down", () => {
    // This is the exact shape of the shipped bug. Inventing a start position
    // here would make the photo jump instead of doing nothing.
    const s = initialGesture();
    expect(pointerMove(s, 99, { x: 5, y: 5 }).effect).toEqual({ kind: "none" });
  });

  it("zooms by the ratio of finger separation", () => {
    let s = pointerDown(initialGesture(), 1, { x: 0, y: 0 });
    s = pointerDown(s, 2, { x: 100, y: 0 });         // 100px apart
    const r = pointerMove(s, 2, { x: 150, y: 0 });   // now 150px
    expect(r.effect).toEqual({ kind: "zoom", factor: 1.5 });
  });

  it("never divides by a zero starting separation", () => {
    // Two fingers landing on the same pixel would otherwise produce Infinity
    // and slam the view to maximum zoom on the first frame.
    let s = pointerDown(initialGesture(), 1, { x: 50, y: 50 });
    s = pointerDown(s, 2, { x: 50, y: 50 });
    const r = pointerMove(s, 2, { x: 90, y: 50 });
    expect(r.effect.kind).toBe("none");
  });

  it("does not lurch when one finger of a pinch lifts", () => {
    let s = pointerDown(initialGesture(), 1, { x: 0, y: 0 });
    s = pointerDown(s, 2, { x: 200, y: 0 });
    s = pointerUp(s, 2);
    expect(s.pinchDistance).toBeNull();
    // The survivor now pans cleanly rather than being measured against the gap.
    const r = pointerMove(s, 1, { x: 12, y: 7 });
    expect(r.effect).toEqual({ kind: "pan", dx: 12, dy: 7 });
  });

  it("forgets a pointer once it is up", () => {
    let s = pointerDown(initialGesture(), 1, { x: 0, y: 0 });
    s = pointerUp(s, 1);
    expect(pointerMove(s, 1, { x: 50, y: 50 }).effect).toEqual({ kind: "none" });
  });
});
