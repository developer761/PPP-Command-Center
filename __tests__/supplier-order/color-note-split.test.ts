import { describe, it, expect } from "vitest";
import {
  splitColorNoteOffer,
  splitFinish,
  splitSurface,
} from "@/lib/supplier-order/color-note-split";

/**
 * Kate, 2026-10-06, with three screenshots: adding a color from the parsed
 * notes put the whole string on the order, and the vendor email read
 *
 *     3 gal — [NOT SET] — All rooms · Ceiling: Super White - Flat
 *
 * beside properly formed lines like
 *
 *     4 gal — Ultra Spec INT — HC-172 Revere Pewter · Eggshell
 *
 * "Can we make this similar to the order what to buy section where the color +
 * finish are separate from the room/area?"
 */

describe("Kate's actual line", () => {
  it("separates color, finish and where it goes", () => {
    const out = splitColorNoteOffer("Ceiling: Super White - Flat", "All rooms");
    expect(out.color).toBe("Super White");
    expect(out.finish).toBe("Flat");
    expect(out.scope).toBe("Ceiling — All rooms");
  });

  it("leaves the vendor a line that reads like every other one", () => {
    // The whole point. Rebuild the email segment the formatter produces and
    // check it against the shape of the real lines in her screenshot.
    const out = splitColorNoteOffer("Ceiling: Super White - Flat", "All rooms");
    const emailed = `3 gal — Ultra Spec INT — ${out.color}${out.finish ? ` · ${out.finish}` : ""}`;
    expect(emailed).toBe("3 gal — Ultra Spec INT — Super White · Flat");
    // And the room is NOT in it — R4.25 took room and surface off every other
    // line, and a custom line carrying them is the inconsistency she reported.
    expect(emailed).not.toMatch(/All rooms|Ceiling/);
  });
});

describe("a dash inside a color is not a finish separator", () => {
  it("keeps Benjamin Moore codes whole", () => {
    // The reason this cannot be "split on the last dash". Both of these carry
    // a hyphen INSIDE the color, and both appear in Kate's own screenshots.
    expect(splitFinish("HC-172 Revere Pewter · Eggshell")).toEqual({
      color: "HC-172 Revere Pewter",
      finish: "Eggshell",
    });
    expect(splitFinish("2108-40 Stardust - Eggshell")).toEqual({
      color: "2108-40 Stardust",
      finish: "Eggshell",
    });
    expect(splitFinish("OC-17 White Dove, Semi-Gloss")).toEqual({
      color: "OC-17 White Dove",
      finish: "Semi-Gloss",
    });
  });

  it("does not amputate a color that has no finish on it", () => {
    expect(splitFinish("HC-6 Kendall Charcoal")).toEqual({
      color: "HC-6 Kendall Charcoal",
      finish: null,
    });
    expect(splitFinish("Carter Plum CW-355")).toEqual({
      color: "Carter Plum CW-355",
      finish: null,
    });
  });

  it("prefers Semi-Gloss over Gloss", () => {
    // Longest-first. Matching "Gloss" first would leave the color as
    // "OC-17 White Dove Semi-" and sell the wrong sheen.
    const out = splitFinish("OC-17 White Dove - Semi-Gloss");
    expect(out.finish).toBe("Semi-Gloss");
    expect(out.color).toBe("OC-17 White Dove");
  });

  it("normalizes the casing a rep typed", () => {
    expect(splitFinish("Super White - flat").finish).toBe("Flat");
    expect(splitFinish("Super White - EGGSHELL").finish).toBe("Eggshell");
  });
});

describe("it never hands the vendor an empty color", () => {
  it("keeps a bare finish as the line rather than blanking it", () => {
    // The submit route's "Finish not available in the Salesforce list" trailer
    // arrives as a bare finish word. Treating it as a sheen would leave a line
    // with a quantity and no color at all.
    expect(splitFinish("Flat")).toEqual({ color: "Flat", finish: null });
    expect(splitFinish("High-Gloss")).toEqual({ color: "High-Gloss", finish: null });
  });

  it("falls back to the original text when there is nothing else", () => {
    expect(splitColorNoteOffer("Ceiling:", null).color).toBe("Ceiling:");
    expect(splitColorNoteOffer("Flat", null).color).toBe("Flat");
  });
});

describe("the surface prefix", () => {
  it("splits a real surface off the front", () => {
    expect(splitSurface("Siding: HC-6 Kendall Charcoal")).toEqual({
      surface: "Siding",
      rest: "HC-6 Kendall Charcoal",
    });
  });

  it("leaves a sentence with a colon alone", () => {
    // A long lead is prose, not a surface. Splitting it would put half a
    // sentence in the surface slot and the other half on the order.
    const long = "I want different colors for different rooms, so here is the list: HC-6";
    expect(splitSurface(long).surface).toBeNull();
    expect(splitSurface(long).rest).toBe(long);
  });

  it("ignores a colon with nothing after it", () => {
    expect(splitSurface("Ceiling:").surface).toBeNull();
  });
});

describe("the scope line", () => {
  it("reads like the buy rows do", () => {
    // Buy rows show "Walls — Other" (surface — room). Custom lines now match.
    expect(splitColorNoteOffer("Walls: HC-172 Revere Pewter", "Other").scope).toBe(
      "Walls — Other"
    );
  });

  it("uses whichever half it has", () => {
    expect(splitColorNoteOffer("Ceiling: Super White", null).scope).toBe("Ceiling");
    expect(splitColorNoteOffer("HC-6 Kendall Charcoal", "Kitchen").scope).toBe("Kitchen");
  });

  it("is null when the note said neither", () => {
    expect(splitColorNoteOffer("HC-6 Kendall Charcoal", null).scope).toBeNull();
    expect(splitColorNoteOffer("HC-6 Kendall Charcoal", "   ").scope).toBeNull();
  });
});

describe("a sheen is never peeled out of the middle of a color", () => {
  /**
   * Every string below is REAL — taken from the production
   * supplier_order_builds table or from Benjamin Moore's catalog. The first
   * version of the separator made punctuation optional, so each of these lost
   * its last word to the finish field and the vendor was sent wrong paint.
   */
  it("leaves the unhyphenated spellings PPP's reps actually type", () => {
    for (const line of [
      "Behr 56 Semigloss",
      "Navajo White Softgloss",
      "Hale Navy highgloss",
      "2124-10 wrought Iron rs matte",
      "rs semi white dove oc-17",
    ]) {
      expect(splitFinish(line), line).toEqual({ color: line, finish: null });
    }
  });

  it("leaves real colors whose NAME ends in a sheen word", () => {
    // Black Pearl and Blue Velvet are colors, not a color plus a sheen.
    for (const line of ["Black Pearl", "Blue Velvet", "Pearl Harbor", "Satin Slipper"]) {
      expect(splitFinish(line), line).toEqual({ color: line, finish: null });
    }
  });

  it("still splits when the rep actually punctuated it", () => {
    // The whole reason the feature exists — Kate's own line, and the forms
    // that appear beside it.
    expect(splitFinish("Super White - Flat")).toEqual({ color: "Super White", finish: "Flat" });
    expect(splitFinish("HC-172 Revere Pewter · Eggshell")).toEqual({
      color: "HC-172 Revere Pewter",
      finish: "Eggshell",
    });
  });

  it("leaves a punctuated but MISSPELLED sheen inside the color", () => {
    // "Semigloss" is not a value in the finish vocabulary — "Semi-Gloss" is —
    // so this does not split even though the rep punctuated it. Deliberate,
    // and harmless: the vendor reads the whole string and gets the right
    // information, it is just not in the finish field. Teaching the splitter
    // unhyphenated aliases is the obvious next step and was NOT taken the night
    // before a rollout, because every alias widens the surface that produced
    // "Black Pearl" → "Black". Real line, from production.
    expect(splitFinish("HC-166 Kendall Charcoal, Semigloss")).toEqual({
      color: "HC-166 Kendall Charcoal, Semigloss",
      finish: null,
    });
  });

  it("under-splits rather than corrupts, on purpose", () => {
    // A sheen left inside the color reaches the vendor as readable text and
    // the estimator can move it. An amputated color is wrong paint. If this
    // ever flips to splitting on whitespace, the cases above come back.
    const out = splitColorNoteOffer("Ceiling: Super White Flat", "All rooms");
    expect(out.color).toBe("Super White Flat");
    expect(out.finish).toBeNull();
    expect(out.scope).toBe("Ceiling — All rooms");
  });
});
