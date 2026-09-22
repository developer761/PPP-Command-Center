import { describe, it, expect } from "vitest";
import { parseFindings, parseBracket, kindOf } from "@/lib/messaging/finding-line";

/**
 * Kate's exact line, sent 2026-09-22. The whole reason this file exists.
 */
const NEW_FORMAT =
  "T4 [A3 | critical] Address and contact were held in full and NEVER confirmed " +
  "with the customer before the close. Holding is not confirming; the handoff turn " +
  "carries the failure.  ->  SHOULD HAVE: asked for the fields it did not hold and " +
  "confirmed the ones it did, until project details, full address and contact were " +
  "all on the record";

/** Her older shape, which the existing import was written against. */
const OLD_FORMAT =
  "T8 [A11 | Redundant Ask/mild] Asked for the full address including the zip " +
  "while already holding it. -> SHOULD HAVE: confirmed the address on file";

describe("Kate's current format", () => {
  const [f] = parseFindings(NEW_FORMAT);

  it("reads the turn, the rule and the severity", () => {
    expect(f.turnOrdinal).toBe(4);
    expect(f.code).toBe("A3");
    // The bug this file was written for: a parser built for the older shape
    // reads "critical" as the rule's NAME and files severity as null. There
    // are findings in the table today showing exactly that.
    expect(f.severity).toBe("critical");
    expect(f.name).toBeNull();
  });

  it("keeps the whole description, including its internal punctuation", () => {
    expect(f.what).toMatch(/^Address and contact were held in full/);
    expect(f.what).toMatch(/handoff turn carries the failure\.$/);
    // The correction must not bleed into the description.
    expect(f.what).not.toMatch(/SHOULD HAVE/);
  });

  it("keeps the correction, which is the most useful field", () => {
    expect(f.shouldHave).toMatch(/^asked for the fields it did not hold/);
    expect(f.shouldHave).toMatch(/all on the record$/);
  });

  it("knows a correction means it fell short", () => {
    expect(f.kind).toBe("fell_short");
  });
});

describe("Kate's older format still reads", () => {
  const [f] = parseFindings(OLD_FORMAT);

  it("separates the rule name from the severity", () => {
    expect(f.code).toBe("A11");
    expect(f.name).toBe("Redundant Ask");
    expect(f.severity).toBe("mild");
  });
});

describe("the bracket, which is where both formats differ", () => {
  it("reads a bare code", () => {
    expect(parseBracket("A6")).toEqual({ code: "A6", name: null, severity: null });
  });

  it("reads a lone severity as a severity, not a name", () => {
    expect(parseBracket("A3 | critical")).toEqual({ code: "A3", name: null, severity: "critical" });
    expect(parseBracket("A21 | mild")).toEqual({ code: "A21", name: null, severity: "mild" });
  });

  it("reads a lone name as a name, with no severity invented", () => {
    // Severity lives on the FINDING, not the code — the same rule is broken
    // mildly in one conversation and critically in another.
    expect(parseBracket("A17 | Disposition")).toEqual({ code: "A17", name: "Disposition", severity: null });
  });

  it("reads a name and severity together", () => {
    expect(parseBracket("A11 | Redundant Ask/mild"))
      .toEqual({ code: "A11", name: "Redundant Ask", severity: "mild" });
  });

  it("handles a name that itself contains a slash", () => {
    // "Misc Awkward/Tone/mild" — only the LAST slash separates the severity.
    expect(parseBracket("A21 | Misc Awkward/Tone/mild"))
      .toEqual({ code: "A21", name: "Misc Awkward/Tone", severity: "mild" });
  });

  it("does not mistake a name ending in a non-severity word", () => {
    expect(parseBracket("A9 | Scope/Summary"))
      .toEqual({ code: "A9", name: "Scope/Summary", severity: null });
  });

  it("normalises the spellings she uses", () => {
    expect(parseBracket("A1 | crit")?.severity).toBe("critical");
    expect(parseBracket("A1 | CRITICAL")?.severity).toBe("critical");
  });

  it("refuses a bracket with no rule code", () => {
    expect(parseBracket("just some text")).toBeNull();
    expect(parseBracket("")).toBeNull();
  });
});

describe("several findings in one block", () => {
  const block = `${NEW_FORMAT}
T7 [A26 | critical] Never acknowledged the three photos sent at T4 through T6. -> SHOULD HAVE: said thanks for the photos
T9 [A21] Slightly stiff phrasing on the close.`;

  it("finds all of them", () => {
    const out = parseFindings(block);
    expect(out.map((f) => f.turnOrdinal)).toEqual([4, 7, 9]);
    expect(out.map((f) => f.code)).toEqual(["A3", "A26", "A21"]);
  });

  it("does not let one finding's text run into the next", () => {
    const out = parseFindings(block);
    expect(out[1].what).not.toMatch(/T9/);
    expect(out[1].shouldHave).toBe("said thanks for the photos");
  });

  it("leaves a finding with no correction unclassified rather than guessing", () => {
    // T9 has no "should have". It might be a good turn or a mild shortfall,
    // and filing a good turn as a failure teaches the bot to avoid the thing
    // it got right.
    const out = parseFindings(block);
    expect(out[2].shouldHave).toBeNull();
    expect(out[2].kind).toBeNull();
  });

  it("uses the column when the caller knows it", () => {
    // A CSV export keeps the boundary a flattened PDF loses.
    expect(parseFindings("T9 [A21] Nice close.", "did_well")[0].kind).toBe("did_well");
  });
});

describe("what it refuses", () => {
  it("returns nothing for text with no findings in it", () => {
    expect(parseFindings("No issues on this conversation.")).toEqual([]);
    expect(parseFindings("")).toEqual([]);
  });

  it("skips a finding with a code but no description", () => {
    expect(parseFindings("T3 [A11]   ")).toEqual([]);
  });

  it("is not confused by a T-number inside the prose", () => {
    const out = parseFindings("T4 [A3 | mild] Referred back to T2 and got it wrong.");
    expect(out).toHaveLength(1);
    expect(out[0].what).toContain("T2");
  });

  it("does not fire twice on the same block", () => {
    // A module-level regex with /g keeps lastIndex between calls, so a second
    // call would silently start mid-string and return fewer findings.
    expect(parseFindings(NEW_FORMAT)).toHaveLength(1);
    expect(parseFindings(NEW_FORMAT)).toHaveLength(1);
  });
});

describe("kindOf", () => {
  it("treats a correction as a shortfall", () => {
    expect(kindOf("should have asked")).toBe("fell_short");
  });

  it("stays null with nothing to go on", () => {
    expect(kindOf(null)).toBeNull();
  });

  it("lets an explicit column win", () => {
    expect(kindOf("should have asked", "did_well")).toBe("did_well");
  });
});
