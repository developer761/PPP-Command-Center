/**
 * A short tap of feedback when a measuring point lands.
 *
 * Apple's Measure gives a haptic click on every placed point, and it matters
 * more than it sounds: you are looking at a corner across the room, not at the
 * screen, so touch is the only channel that can confirm the tap registered
 * without making you look away and lose your aim.
 *
 * Support is uneven and there is no graceful way around that. The Vibration API
 * works on Android; Safari on iOS has never shipped it, and the real Taptic
 * Engine is not reachable from a web page at all. So this fires where it can and
 * does nothing where it cannot — the visual confirmation carries the meaning,
 * and the buzz is a bonus rather than the only signal.
 */

type Pattern = "point" | "locked" | "rejected";

const PATTERNS: Record<Pattern, number | number[]> = {
  /** A point landed. */
  point: 18,
  /** The span is complete. Two beats so it is distinguishable eyes-free. */
  locked: [22, 60, 22],
  /** Refused — deliberately longer, so a failure never feels like a success. */
  rejected: 120,
};

export function haptic(kind: Pattern): void {
  if (typeof navigator === "undefined") return;
  const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
  if (typeof nav.vibrate !== "function") return;
  try {
    nav.vibrate(PATTERNS[kind]);
  } catch {
    // Blocked by a permissions policy or a user setting. Not worth surfacing —
    // every one of these actions already confirms itself on screen.
  }
}
