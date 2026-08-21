import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A JS timeout that waits for a CSS animation must not be able to drift from it.
 *
 * Karan's notes, filed as "minor, open": debrief-fields.tsx hard-codes 340ms
 * against the 320ms `.animate-fade-up` in globals.css — "different files, no
 * link between them".
 *
 * The reasoning behind the 340 is sound: scrolling into an element that is
 * still translating makes smooth-scroll chase a moving target, so the deferral
 * needs the animation's duration plus a little headroom. What is missing is any
 * connection between the two numbers. Change the CSS to 400ms and the scroll
 * silently starts firing mid-animation — no error, no failing type, just a
 * scroll that lands slightly wrong on slower devices and would be reported, if
 * at all, as "it feels janky".
 *
 * CSS cannot import a TypeScript constant, so the two numbers have to stay
 * separate. This asserts the RELATIONSHIP between them instead.
 */

const CSS = readFileSync("app/globals.css", "utf8");
const DEBRIEF = readFileSync("components/commercial/debrief-fields.tsx", "utf8");

function fadeUpDurationMs(): number {
  const m = /\.animate-fade-up\s*\{[^}]*?animation:\s*ppp-fade-up\s+(\d+)ms/.exec(CSS);
  expect(m, ".animate-fade-up is gone or no longer declares a duration").toBeTruthy();
  return Number(m![1]);
}

function deferralMs(): number {
  // The setTimeout that waits for the fade-up before scrolling.
  const m = /\}, (\d+)\);\s*\n\s*return \(\) => clearTimeout\(t\);/.exec(DEBRIEF);
  expect(m, "the deferred scroll in debrief-fields.tsx has moved or changed shape").toBeTruthy();
  return Number(m![1]);
}

describe("the deferred scroll outlasts the animation it waits for", () => {
  it("waits at least as long as the fade-up runs", () => {
    const css = fadeUpDurationMs();
    const js = deferralMs();
    expect(
      js,
      `The scroll fires ${js}ms after the outcome is chosen, but .animate-fade-up ` +
        `runs for ${css}ms. Scrolling into a still-translating element makes ` +
        `smooth-scroll chase a moving target. Raise the timeout in ` +
        `components/commercial/debrief-fields.tsx to at least ${css}ms.`
    ).toBeGreaterThanOrEqual(css);
  });

  it("but not so long that it reads as lag", () => {
    // Headroom, not a pause. Past ~150ms over the animation a person notices
    // the gap between choosing an outcome and the form moving.
    const css = fadeUpDurationMs();
    expect(deferralMs() - css).toBeLessThanOrEqual(150);
  });
});
