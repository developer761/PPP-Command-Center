import { describe, it, expect } from "vitest";
import { parseInlineValue, inlineField } from "@/lib/commercial/opportunities/inline-fields";

/**
 * BACKLOG §4.2 said `rfp_received_at`'s write paths were symmetric and the
 * mismatch was latent. They were not, and it was not.
 *
 * There were THREE paths. Two wrote a bare "2026-08-12" into a TIMESTAMPTZ,
 * which Postgres reads as UTC midnight — 8pm the previous evening in Eastern —
 * so the deal stored the day BEFORE the one that was picked. The third
 * anchored at noon and was right. The same date typed on two screens produced
 * two different stored days.
 *
 * Migration 133 makes the column a DATE, and all three paths now write the
 * calendar day untouched. This pins that: a date field must hand back exactly
 * what was typed, with no time bolted on.
 */
describe("date write paths store the day that was typed", () => {
  const dateFields = ["rfp_received_at", "proposal_due_at", "follow_up_at"];

  for (const name of dateFields) {
    const field = inlineField(name);
    if (!field || field.type !== "date") continue;

    it(`${name}: no time component, no zone shift`, () => {
      const r = parseInlineValue(field, "2026-08-12");
      expect(r.error).toBeUndefined();
      expect(r.value).toBe("2026-08-12");
      // The failure this guards: anything that turns the day into an instant.
      expect(String(r.value)).not.toMatch(/T|Z|:/);
    });

    it(`${name}: refuses a value it can't store as a day`, () => {
      expect(parseInlineValue(field, "08/12/2026").error).toBeTruthy();
      expect(parseInlineValue(field, "2026-08-12T12:00:00Z").error).toBeTruthy();
    });
  }
});
