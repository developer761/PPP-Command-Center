import { describe, it, expect } from "vitest";
import { buildPreview } from "@/lib/messaging/training-import";

const CSV = [
  `Date,Customer Name,Conversation,Rating,Workspace`,
  `2026-07-04,Marisol Vega,"Hi Marisol, reach me at 516-344-8418",good,NY LI Nassau Leads`,
  `2026-07-05,Bob Coletta,"Bob here. 42 Hillcrest Ave, Garden City 11530",bad,NY LI Meta`,
  `2026-07-06,,"",good,NJ Leads`,
].join("\n");

describe("buildPreview — detection", () => {
  it("finds Kate's columns under her own names", () => {
    const p = buildPreview(CSV, "conduct");
    expect(p.detected.transcript).toBe("Conversation");
    expect(p.detected.grade).toBe("Rating");
    expect(p.detected.name).toBe("Customer Name");
    expect(p.detected.workspace).toBe("Workspace");
  });

  it("reports the distinct grade values actually present", () => {
    // So the UI shows what it is working with rather than assuming.
    expect(buildPreview(CSV, "conduct").gradeValues).toEqual(["bad", "good"]);
  });
});

describe("buildPreview — the conduct vs outcome question", () => {
  it("puts the grade in CONDUCT when told it means conduct", () => {
    const p = buildPreview(CSV, "conduct");
    expect(p.rows[0].conduct).toBe("good");
    expect(p.rows[0].outcome).toBeNull();
  });

  it("puts the grade in OUTCOME when told it means outcome", () => {
    // The whole reason the caller must say. Trained on outcome alone the model
    // learns to imitate luck.
    const p = buildPreview(CSV, "outcome");
    expect(p.rows[0].outcome).toBe("good");
    expect(p.rows[0].conduct).toBeNull();
  });
});

describe("buildPreview — scrubbing", () => {
  it("scrubs the name from the row against its own transcript", () => {
    const p = buildPreview(CSV, "conduct");
    expect(p.rows[0].scrubbed).not.toContain("Marisol");
    expect(p.rows[0].scrubbed).toContain("[NAME]");
    expect(p.rows[0].scrubbed).toContain("[PHONE]");
  });

  it("scrubs address and zip", () => {
    const p = buildPreview(CSV, "conduct");
    expect(p.rows[1].scrubbed).toContain("[ADDRESS]");
    expect(p.rows[1].scrubbed).not.toContain("Hillcrest");
  });

  it("reports what it found per row", () => {
    const p = buildPreview(CSV, "conduct");
    expect(p.rows[0].piiFound.some((f) => f.kind === "phone")).toBe(true);
  });
});

describe("buildPreview — problems are surfaced, not silently dropped", () => {
  it("flags a row with no transcript", () => {
    const p = buildPreview(CSV, "conduct");
    expect(p.rows[2].problems).toContain("no transcript");
  });

  it("flags duplicates on transcript text", () => {
    // Kate's opt-out export repeated the same event many times, so assuming
    // rows are distinct is unsafe.
    const dup = `Conversation,Rating\n"same text",good\n"same text",bad`;
    const p = buildPreview(dup, "conduct");
    expect(p.duplicates).toBe(1);
    expect(p.rows[1].problems).toContain("duplicate of an earlier row");
  });

  it("flags a grade that is not good/mixed/bad", () => {
    const p = buildPreview(`Conversation,Rating\n"hi",excellent`, "conduct");
    expect(p.rows[0].problems.some((x) => x.includes("excellent"))).toBe(true);
  });

  it("counts only clean rows as usable", () => {
    const p = buildPreview(CSV, "conduct");
    expect(p.usable).toBe(2); // the empty-transcript row is not usable
  });

  it("survives an empty file without throwing", () => {
    const p = buildPreview("", "conduct");
    expect(p.rows).toEqual([]);
    expect(p.usable).toBe(0);
  });

  it("survives a header-only file", () => {
    expect(buildPreview("Conversation,Rating", "conduct").rows).toEqual([]);
  });

  it("survives a file with none of the expected columns", () => {
    const p = buildPreview("Foo,Bar\n1,2", "conduct");
    expect(p.detected.transcript).toBeUndefined();
    expect(p.rows[0].problems).toContain("no transcript");
  });

  it("reports line numbers that match the spreadsheet", () => {
    // Row 1 of data is line 2 of the file. Off by one here and Kate cannot
    // find the row we are complaining about.
    expect(buildPreview(CSV, "conduct").rows[0].line).toBe(2);
  });
});
