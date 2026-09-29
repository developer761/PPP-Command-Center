import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE DATE FIELD MUST POST THE DATE IT SHOWS.
 *
 * The hidden input that carries a DateField's value into the form was
 * `defaultValue` + imperative `el.value = next`. Setting `.value` by hand
 * leaves React unaware the input is dirty, so the next re-render — which the
 * `setInternal` on the line above triggers — resets the DOM back to
 * `defaultValue`.
 *
 * The field then displayed the date you picked and posted a different one.
 * Verified in the browser on 2026-09-29: pick Sep 15 on an AIA payment, the
 * box reads "Sep 15, 2026", and the hidden input still holds today's date.
 *
 * Stephanie reported this shape three times before it was understood — "Bid
 * set date is still not showing up" and "Application period settings are not
 * sticking" (09-11), then every AIA payment date (09-29). All 20 AIA payments
 * and all 118 invoice payments carried a paid_at of exactly T16:00:00Z on the
 * day they were ENTERED: the default this bug kept posting.
 *
 * A SOURCE TEST, deliberately. The suite has no DOM, so the behaviour cannot
 * be exercised here — but the property that broke is visible in one line, and
 * a `defaultValue` creeping back onto that input is the whole bug returning.
 */
const src = readFileSync(
  join(process.cwd(), "components/commercial/date-field.tsx"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("the DateField's hidden input", () => {
  it("is React-controlled, never defaultValue", () => {
    const hidden = [...src.matchAll(/<input[^>]*type="hidden"[^>]*\/>/g)].map((m) => m[0]);
    expect(hidden.length, "no hidden input found — did the markup change?").toBeGreaterThan(0);
    for (const tag of hidden) {
      expect(
        /defaultValue=/.test(tag),
        `this hidden input uses defaultValue, so a re-render will reset it and the field will post a stale date: ${tag}`,
      ).toBe(false);
      expect(/value=\{/.test(tag), `hidden input has no controlled value: ${tag}`).toBe(true);
    }
  });

  it("still sets the DOM value imperatively before dispatching change", () => {
    // AutosaveForm reads new FormData(form) synchronously on that event,
    // before React has re-rendered. Removing this reads the previous value.
    expect(src).toMatch(/el\.value = next;[\s\S]{0,400}dispatchEvent\(new Event\("change"/);
  });
});
