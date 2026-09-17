import { describe, it, expect } from "vitest";
import { sanitizeFinishes } from "@/lib/customer-form/finish-sanitize";
import { ALL_FINISH_VALUES } from "@/lib/customer-form/material-types";

/**
 * WO 00317803, 2026-09-17: "tried to do the test and they entered 3 good
 * things but 1 was missing and nothing Saved. It should save partial data
 * that's good even if something is missing."
 *
 * The submit route returned 400 at the first off-list finish, from inside the
 * loop building the Salesforce writes — so the rooms already built were thrown
 * away with it. Nothing was written and nothing was marked submitted.
 */

const VALID = ALL_FINISH_VALUES;

describe("one bad finish does not cost the customer the rest of the form", () => {
  const surfaces = [
    { surface: "Walls", colorId: "c1", finish: "Eggshell" },
    { surface: "Ceiling", colorId: "c2", finish: "Flat" },
    { surface: "Trim", colorId: "c3", finish: "Semi-Gloss" },
    { surface: "Door", colorId: "c4", finish: "Eggshell Gloss" }, // not a finish
  ];

  it("keeps the three good surfaces exactly as they were", () => {
    const { surfaces: out } = sanitizeFinishes(surfaces, VALID);
    expect(out).toHaveLength(4);
    expect(out.slice(0, 3)).toEqual(surfaces.slice(0, 3));
  });

  it("keeps the fourth surface's COLOR and drops only its finish", () => {
    // The color is real whatever the finish says. Dropping the whole surface
    // would lose a color the customer picked.
    const { surfaces: out } = sanitizeFinishes(surfaces, VALID);
    expect(out[3]).toEqual({ surface: "Door", colorId: "c4", finish: null });
  });

  it("reports what was dropped, so it can be recorded and asked about", () => {
    const { dropped } = sanitizeFinishes(surfaces, VALID);
    expect(dropped).toEqual([{ surface: "Door", finish: "Eggshell Gloss" }]);
  });

  it("does not mutate the caller's objects", () => {
    const input = [{ surface: "Door", colorId: "c4", finish: "Eggshell Gloss" }];
    sanitizeFinishes(input, VALID);
    expect(input[0].finish).toBe("Eggshell Gloss");
  });
});

describe("what it leaves alone", () => {
  it("a surface with no color at all", () => {
    // Nothing is written for it, so a stray finish is not worth a warning.
    const { surfaces: out, dropped } = sanitizeFinishes(
      [{ surface: "Walls", colorId: null, finish: "Nonsense" }],
      VALID
    );
    expect(dropped).toEqual([]);
    expect(out).toHaveLength(1);
  });

  it("a color with no finish — legal, and the reason this is a warning not a wall", () => {
    const { surfaces: out, dropped } = sanitizeFinishes(
      [{ surface: "Walls", colorId: "c1", finish: null }],
      VALID
    );
    expect(dropped).toEqual([]);
    expect(out[0].finish).toBeNull();
  });

  it("every finish the picker can offer", () => {
    for (const f of VALID) {
      const { dropped } = sanitizeFinishes([{ surface: "Walls", colorId: "c1", finish: f }], VALID);
      expect(dropped).toEqual([]);
    }
  });

  it("junk in the payload, without throwing — this is a public endpoint", () => {
    const { surfaces: out, dropped } = sanitizeFinishes(
      [null as never, "nope" as never, { surface: 7, colorId: "c1", finish: 9 } as never],
      VALID
    );
    expect(dropped).toEqual([]);
    expect(out).toHaveLength(1);
  });
});
