import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * Kate, 2026-10-07, with a photograph from her phone: *"When I click 'All
 * reps' or the notification bell, the pop-up is outside of my screen."* The
 * search box inside the panel read "eps…".
 *
 * Both were `absolute right-0` against a control sitting in the MIDDLE of the
 * top bar, so a ~288px panel's left edge went negative. `max-w-[90vw]` capped
 * the WIDTH and could not move it — the element was still anchored to the
 * trigger, and the trigger was not where the room was.
 *
 * Below `sm` each panel is now fixed with its own left/right/bottom insets, so
 * it cannot leave the screen whatever the trigger does. At `sm` and up nothing
 * changed.
 */
const PANELS: Array<[string, string]> = [
  ["rep picker", "components/view-switcher.tsx"],
  ["notification bell", "components/notification-bell.tsx"],
];

describe("a top-bar popover cannot leave the screen on a phone", () => {
  for (const [name, file] of PANELS) {
    const src = read(file);

    it(`${name} pins itself to the viewport below sm`, () => {
      expect(src).toContain("max-sm:fixed");
      // Both horizontal edges, or it can still run off one of them.
      expect(src).toContain("max-sm:left-3");
      expect(src).toContain("max-sm:right-3");
      // A fixed element keeps its desktop width unless this is released.
      expect(src).toContain("max-sm:w-auto");
    });

    it(`${name} is bounded vertically too, so a long list cannot run off the bottom`, () => {
      expect(src).toContain("max-sm:bottom-3");
      // …and the scrolling region inside has to be allowed to shrink, or the
      // panel grows past its own bounds instead of scrolling.
      expect(src).toContain("max-sm:min-h-0");
      expect(src).toContain("max-sm:flex-1");
    });

    it(`${name} clears the sticky header and the iOS safe area`, () => {
      expect(src).toMatch(/max-sm:top-\[calc\(env\(safe-area-inset-top\)\+[\d.]+rem\)\]/);
    });

    it(`${name} is unchanged at sm and above`, () => {
      // The desktop rules must survive — this was a mobile-only complaint and
      // the wide layout was fine.
      expect(src).toMatch(/absolute right-0/);
    });
  }
});

/**
 * "The top bar should scroll with me (the time and battery have nothing
 * behind them so it's overlapping with the text on the screen)."
 *
 * The app sets viewportFit:"cover", so the page runs under the clock and
 * battery. A dozen places pad for safe-area-inset-BOTTOM; nothing had ever
 * padded the top, so content showed through behind the status bar.
 */
describe("the top bar covers the status bar and stays put", () => {
  const src = read("components/topbar.tsx");

  it("paints its own background behind the iOS safe area", () => {
    expect(src).toContain("env(safe-area-inset-top)");
    // max(), not a bare inset — on a device with no notch the bar still needs
    // its normal padding rather than collapsing to zero.
    expect(src).toMatch(/max\(0\.75rem, env\(safe-area-inset-top\)\)/);
  });

  it("is sticky, so it stays while the page moves", () => {
    expect(src).toMatch(/sticky top-0/);
    expect(src).toMatch(/z-\d+/);
  });

  it("gives the loading skeleton the same inset", () => {
    // Otherwise the bar visibly jumps the moment the real one renders.
    const skeleton = src.slice(src.indexOf("if (!now)"), src.indexOf("if (!now)") + 320);
    expect(skeleton).toContain("safe-area-inset-top");
  });
});
