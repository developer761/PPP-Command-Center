import { describe, it, expect } from "vitest";
import { diffRule, sameText, describeChange, TRACKED, type StoredRule } from "@/lib/messaging/rule-diff";
import type { ClassARule } from "@/lib/messaging/class-a-rules";

const incoming = (over: Partial<ClassARule & { shortName: string | null }> = {}) => ({
  code: "A22", statement: "One ASK per message — count asks, not question marks.",
  ruleCard: "Hard policy.", correctiveAction: "asked one thing",
  severity: "critical" as const, status: "live" as const,
  phrasingOnly: false, binds: true, source: "ROLE", measuredBreaches: null,
  changeType: "BINDING", lastModified: "2026-09-17", lastReRated: null,
  shortName: "Two asks in one message", ...over,
});

const stored = (over: Partial<StoredRule> = {}): StoredRule => ({
  code: "A22", statement: "One ASK per message — count asks, not question marks.",
  rule_card: "Hard policy.", corrective_action: "asked one thing",
  severity: "critical", status: "live", binds: true, phrasing_only: false,
  short_name: "Two asks in one message", ...over,
});

/**
 * Kate asked for a change history so that "why did X improve" has an answer in
 * six months. The only way it exists in six months is if nobody has to
 * remember to write it — so the import records it, and the diff decides what
 * is worth recording.
 */
describe("what counts as a change", () => {
  it("records nothing when the sheet is re-issued unchanged", () => {
    // The commonest case by far, and the one that decides whether anybody
    // ever reads this log: a re-export with no edits must be silent.
    expect(diffRule(stored(), incoming())).toEqual([]);
  });

  it("records a severity change on its own row", () => {
    const out = diffRule(stored({ severity: "mild" }), incoming({ severity: "critical" }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: "A22", field: "severity", before: "mild", after: "critical" });
  });

  it("records a retirement", () => {
    const out = diffRule(stored(), incoming({ status: "retired" }));
    expect(out.map((c) => c.field)).toEqual(["status"]);
    expect(out[0].after).toBe("retired");
  });

  it("records each field that moved separately", () => {
    // One row per field, not one per import: "severity went mild -> critical"
    // can be lined up against the breach count. "A22 was edited" cannot.
    const out = diffRule(
      stored({ severity: "mild", corrective_action: "old" }),
      incoming({ severity: "critical", correctiveAction: "new" })
    );
    expect(out.map((c) => c.field).sort()).toEqual(["corrective_action", "severity"]);
  });

  it("carries her BINDING / WORDING distinction", () => {
    // Whether the MEANING changed is the thing that matters when asking
    // whether a rule change could have moved the numbers.
    const out = diffRule(stored({ statement: "Old wording" }), incoming({ changeType: "WORDING" }));
    expect(out[0].changeType).toBe("WORDING");
  });

  it("treats a brand-new rule as one fact, not as every field at once", () => {
    const out = diffRule(null, incoming());
    expect(out).toHaveLength(1);
    expect(out[0].field).toBe("added");
    expect(out[0].before).toBeNull();
  });

  it("records a boolean flipping, in words", () => {
    const out = diffRule(stored({ binds: true }), incoming({ binds: false }));
    expect(out[0]).toMatchObject({ field: "binds", before: "yes", after: "no" });
  });
});

/**
 * A re-export from Google Sheets differs from the last one in line endings and
 * trailing spaces on rows nobody touched. Recording those buries the real
 * edits, and the first time that happens the history stops being read.
 */
describe("whitespace is not a change", () => {
  it("ignores trailing space, tabs and line endings", () => {
    expect(sameText("One ASK per message", "One ASK per message  ")).toBe(true);
    expect(sameText("a\r\nb", "a\nb")).toBe(true);
    expect(sameText("a  b", "a b")).toBe(true);
  });

  it("does not ignore a real edit", () => {
    expect(sameText("One ASK per message", "Two asks per message")).toBe(false);
  });

  it("treats empty and missing as the same", () => {
    expect(sameText(null, "")).toBe(true);
    expect(sameText(undefined, "   ")).toBe(true);
  });

  it("produces no rows for a whitespace-only re-export", () => {
    const out = diffRule(
      stored({ statement: "One ASK per message — count asks, not question marks.  " }),
      incoming()
    );
    expect(out).toEqual([]);
  });
});

describe("what it refuses to record", () => {
  it("does not read a missing short name as a deletion", () => {
    // short_name only ever comes from the older code table. A sheet that does
    // not carry it must not be read as Kate having removed it.
    const out = diffRule(stored({ short_name: "Two asks in one message" }), incoming({ shortName: null }));
    expect(out).toEqual([]);
  });

  it("does record a short name actually being changed", () => {
    const out = diffRule(stored({ short_name: "Old label" }), incoming({ shortName: "New label" }));
    expect(out.map((c) => c.field)).toEqual(["short_name"]);
  });

  it("only tracks fields the database will accept", () => {
    // The CHECK constraint lists these exactly; a field added here and not
    // there would throw on the first import that changed it.
    expect([...TRACKED]).toEqual([
      "statement", "rule_card", "corrective_action", "severity",
      "status", "binds", "phrasing_only", "short_name",
    ]);
  });
});

describe("how a change reads", () => {
  it("shows a short change inline", () => {
    expect(describeChange({ code: "A22", field: "severity", before: "mild", after: "critical", changeType: null }))
      .toBe("Severity: mild → critical");
  });

  it("does not try to inline a rewritten rule card", () => {
    const long = "x".repeat(200);
    expect(describeChange({ code: "A22", field: "rule_card", before: long, after: long + "y", changeType: null }))
      .toBe("The detail rewritten");
  });

  it("says added plainly", () => {
    expect(describeChange({ code: "A45", field: "added", before: null, after: "A new rule", changeType: null }))
      .toBe("Added");
  });

  it("handles a field going from nothing to something", () => {
    expect(describeChange({ code: "A1", field: "severity", before: null, after: "mild", changeType: null }))
      .toBe("Severity: — → mild");
  });
});
