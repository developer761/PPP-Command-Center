/**
 * Pointer bookkeeping for pan and pinch, as a pure reducer.
 *
 * This exists because of a specific bug. The first version tracked pointers in
 * a ref and called `setPointerCapture` in the same handler — capture first,
 * bookkeeping second. `setPointerCapture` throws NotFoundError for a pointer
 * the browser no longer considers active, and that exception skipped the
 * bookkeeping entirely: `pointermove` then found no start position and the
 * photo silently refused to pan. Nothing logged, nothing visibly broken, just a
 * measuring tool that ignored your finger.
 *
 * Keeping the state transitions pure and separate from the DOM side effects
 * makes that ordering mistake impossible to repeat, and lets the gesture logic
 * be tested without a browser.
 */

export type GesturePoint = { x: number; y: number };
export type GestureState = {
  /** Live pointers by pointerId, at their most recent position. */
  pointers: Map<number, GesturePoint>;
  /** Distance between the two fingers at the last sample, when pinching. */
  pinchDistance: number | null;
};

export type GestureEffect =
  | { kind: "none" }
  | { kind: "pan"; dx: number; dy: number }
  | { kind: "zoom"; factor: number };

export function initialGesture(): GestureState {
  return { pointers: new Map(), pinchDistance: null };
}

const distance = (a: GesturePoint, b: GesturePoint) => Math.hypot(a.x - b.x, a.y - b.y);

export function pointerDown(s: GestureState, id: number, at: GesturePoint): GestureState {
  const pointers = new Map(s.pointers);
  pointers.set(id, at);
  const two = pointers.size === 2 ? [...pointers.values()] : null;
  return { pointers, pinchDistance: two ? distance(two[0], two[1]) : null };
}

/**
 * A move produces at most one effect: two fingers zoom, one finger pans.
 *
 * A move for a pointer we never saw go down is ignored rather than guessed at —
 * that happens after the pointer is captured elsewhere, and inventing a start
 * position would jump the photo.
 */
export function pointerMove(
  s: GestureState,
  id: number,
  to: GesturePoint
): { state: GestureState; effect: GestureEffect } {
  const prev = s.pointers.get(id);
  if (!prev) return { state: s, effect: { kind: "none" } };

  const pointers = new Map(s.pointers);
  pointers.set(id, to);

  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const now = distance(a, b);
    const was = s.pinchDistance;
    const next = { pointers, pinchDistance: now };
    // A zero starting distance would divide to Infinity and throw the view to
    // maximum zoom on the first frame of a two-finger touch.
    if (!was || was <= 0 || now <= 0) return { state: next, effect: { kind: "none" } };
    return { state: next, effect: { kind: "zoom", factor: now / was } };
  }

  return {
    state: { pointers, pinchDistance: null },
    effect: { kind: "pan", dx: to.x - prev.x, dy: to.y - prev.y },
  };
}

export function pointerUp(s: GestureState, id: number): GestureState {
  const pointers = new Map(s.pointers);
  pointers.delete(id);
  // Dropping from two fingers to one must clear the pinch baseline, or the
  // remaining finger's next move is measured against a stale gap and the photo
  // lurches. Lifting one finger should just become a pan.
  return { pointers, pinchDistance: pointers.size === 2 ? s.pinchDistance : null };
}
