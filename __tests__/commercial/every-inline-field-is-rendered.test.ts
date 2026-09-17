import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { INLINE_FIELDS } from "@/lib/commercial/opportunities/inline-fields";

/**
 * Every inline-editable field is actually ON the page.
 *
 * `INLINE_FIELDS` is an ALLOWLIST — it says what `updateOpportunityField` will
 * accept. It does not put anything on screen: the Info tab calls `inlineRow()`
 * once per field, by name. So the two halves can disagree in both directions
 * and TypeScript sees neither:
 *
 *   · a field in the allowlist with no `inlineRow()` is a capability that
 *     exists only in theory — the editor is reachable by URL and invisible on
 *     the page. Adding "Expected start" (Karan 2026-09-17, "RFP when we think
 *     when this project is gonna happen") hit exactly this: the allowlist entry
 *     granted the write and the page still rendered read-only text.
 *   · an `inlineRow()` for a name NOT in the allowlist renders a pencil that
 *     opens an editor whose save is refused with "That field can't be edited
 *     here" — a control that is dead on arrival.
 *
 * This is the project's own rule about a capability the UI re-derives: grep the
 * consumers before calling it shipped.
 */

const page = readFileSync(
  join(process.cwd(), "app/commercial/opportunities/[id]/page.tsx"),
  "utf8"
);

/** Field names the Info tab actually renders a row for. */
const rendered = new Set(
  [...page.matchAll(/inlineRow\(\s*"([a-z_]+)"/g)].map((m) => m[1])
);

describe("inline fields", () => {
  it("renders a row for every field the allowlist permits", () => {
    const missing = INLINE_FIELDS.map((f) => f.name).filter((n) => !rendered.has(n));
    expect(missing, `in INLINE_FIELDS but never rendered: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not render a row the allowlist would refuse to save", () => {
    const allowed = new Set(INLINE_FIELDS.map((f) => f.name));
    const orphan = [...rendered].filter((n) => !allowed.has(n));
    expect(orphan, `rendered but not in INLINE_FIELDS: ${orphan.join(", ")}`).toEqual([]);
  });

  it("measured something — the helper is still called inlineRow", () => {
    // Without this the pair of assertions above pass trivially the day someone
    // renames the helper, and the check quietly stops covering anything.
    expect(rendered.size).toBeGreaterThanOrEqual(8);
    expect(INLINE_FIELDS.length).toBeGreaterThanOrEqual(8);
  });

  it("keeps the expected-work dates editable", () => {
    // The specific ask. Named so a future tidy-up of the Info tab cannot drop
    // them back to read-only without saying so.
    expect(rendered.has("proposed_start_at")).toBe(true);
    expect(rendered.has("proposed_end_at")).toBe(true);
    // And they are dates, not free text — the projected calendar will parse them.
    for (const n of ["proposed_start_at", "proposed_end_at"]) {
      expect(INLINE_FIELDS.find((f) => f.name === n)?.type).toBe("date");
    }
  });
});
