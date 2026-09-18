import { describe, it, expect } from "vitest";
import { applyToAllTargets } from "@/lib/customer-form/apply-to-all";

/**
 * "Apply to all areas", and the overwrite Kate asked for on 2026-09-18:
 * "add an 'overwrite anyway' option in case customers change their mind and
 * need to update multiple rooms/areas".
 *
 * The default stays fill-empty-only (Katie 2026-05-29) — a click in the
 * kitchen must not silently repaint a bedroom the customer already answered.
 */

const line = (id: string, surfaces = ["Walls", "Ceiling"]) => ({ id, surfaces });

const pick = (colorId: string | null, skipped = false) => ({ colorId, skipped });

const JOB = {
  lineItems: [line("kitchen"), line("bed1"), line("bed2"), line("bath"), line("hall")],
  sourceLineId: "kitchen",
  surface: "Walls",
  colorId: "a02AQUA",
};

describe("by default it fills the empty rooms only", () => {
  const picks = {
    kitchen: { picks: { Walls: pick("a02AQUA") } },
    bed1: { picks: { Walls: pick(null) } },
    bed2: { picks: { Walls: pick("a02OTHER") } },   // already answered
    bath: { picks: { Walls: pick(null, true) } },   // "don't paint this"
    hall: { picks: { Walls: pick(null) } },
  };

  it("touches the blank rooms and nothing else", () => {
    const { fill, differing } = applyToAllTargets({ ...JOB, picks });
    expect(fill).toEqual(["bed1", "hall"]);
    // Reported, not filled — this is what the "Overwrite 1 room" offer counts.
    expect(differing).toEqual(["bed2"]);
  });

  it("never touches a surface the customer skipped", () => {
    const { fill, differing } = applyToAllTargets({ ...JOB, picks });
    expect(fill).not.toContain("bath");
    expect(differing).not.toContain("bath");
  });

  it("never touches the room the click came from", () => {
    // The fixtures above give the source room the color being applied, so it
    // falls out of both lists anyway and this assertion could not fail —
    // caught by mutation testing. The case that DOES exercise the guard is a
    // source whose stored pick differs from the color being applied, which is
    // what a click lands on between a change and the next commit.
    const stale = { ...picks, kitchen: { picks: { Walls: pick("a02STALE") } } };
    const { fill, differing } = applyToAllTargets({ ...JOB, picks: stale });
    expect([...fill, ...differing]).not.toContain("kitchen");
    // …and the rest of the sweep is unaffected by it.
    expect(fill).toEqual(["bed1", "hall"]);
  });

  it("skips a room that doesn't have this surface at all", () => {
    const { fill } = applyToAllTargets({
      ...JOB,
      lineItems: [line("kitchen"), line("deck", ["Trim"])],
      picks: { kitchen: { picks: { Walls: pick("a02AQUA") } }, deck: { picks: { Trim: pick(null) } } },
    });
    expect(fill).toEqual([]);
  });
});

describe("the rooms an overwrite would change", () => {
  it("are the ones holding a DIFFERENT color", () => {
    const { differing } = applyToAllTargets({
      ...JOB,
      picks: {
        kitchen: { picks: { Walls: pick("a02AQUA") } },
        bed1: { picks: { Walls: pick("a02OTHER") } },
        bed2: { picks: { Walls: pick("a02THIRD") } },
        bath: { picks: { Walls: pick("a02OTHER", true) } },
        hall: { picks: { Walls: pick(null) } },
      },
    });
    expect(differing).toEqual(["bed1", "bed2"]);
  });

  it("do NOT include a room already using this very color", () => {
    // Nothing to change, so offering to "overwrite 3 rooms" would be a lie.
    const { fill, differing } = applyToAllTargets({
      ...JOB,
      picks: {
        kitchen: { picks: { Walls: pick("a02AQUA") } },
        bed1: { picks: { Walls: pick("a02AQUA") } },
        bed2: { picks: { Walls: pick("a02AQUA") } },
        bath: { picks: { Walls: pick("a02AQUA") } },
        hall: { picks: { Walls: pick("a02AQUA") } },
      },
    });
    expect(fill).toEqual([]);
    expect(differing).toEqual([]);
  });

  it("and a skip still wins, even when the customer asks to overwrite", () => {
    // Every other consumer treats "don't paint this surface" as an answer.
    // An overwrite changes colors; it does not un-skip a surface.
    const { fill, differing } = applyToAllTargets({
      ...JOB,
      picks: {
        kitchen: { picks: { Walls: pick("a02AQUA") } },
        bed1: { picks: { Walls: pick("a02OTHER", true) } },
        bed2: { picks: { Walls: pick(null, true) } },
        bath: { picks: { Walls: pick(null, true) } },
        hall: { picks: { Walls: pick(null, true) } },
      },
    });
    expect([...fill, ...differing]).toEqual([]);
  });
});

describe("the message the customer reads", () => {
  // The counts on screen come from these two lists, so they cannot disagree
  // with what the sweep actually did.
  it("has something to offer when every room is already answered", () => {
    const { fill, differing } = applyToAllTargets({
      ...JOB,
      picks: {
        kitchen: { picks: { Walls: pick("a02AQUA") } },
        bed1: { picks: { Walls: pick("a02OTHER") } },
        bed2: { picks: { Walls: pick("a02OTHER") } },
        bath: { picks: { Walls: pick(null, true) } },
        hall: { picks: { Walls: pick("a02OTHER") } },
      },
    });
    // "Every other Walls already has a color." + "Overwrite 3 rooms"
    expect(fill).toHaveLength(0);
    expect(differing).toHaveLength(3);
  });

  it("and nothing to offer when the only others are skipped", () => {
    // Here the honest answer really is "nothing to fill" — there must be no
    // overwrite button, because there is nothing an overwrite would do.
    const { fill, differing } = applyToAllTargets({
      ...JOB,
      lineItems: [line("kitchen"), line("bath")],
      picks: {
        kitchen: { picks: { Walls: pick("a02AQUA") } },
        bath: { picks: { Walls: pick(null, true) } },
      },
    });
    expect(fill).toHaveLength(0);
    expect(differing).toHaveLength(0);
  });
});
