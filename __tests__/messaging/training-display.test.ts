import { describe, it, expect } from "vitest";
import {
  gradingBacklog, backlogLabel, graderDescription, isRetiredCode, sheetParagraphs, pageOf,
} from "@/lib/messaging/training-display";

describe("the grading backlog", () => {
  const rows = [
    { id: "a", conduct: "good", tags: [] },
    { id: "b", conduct: null, tags: [] },
    { id: "c", conduct: "bad", tags: ["one_question"] },
    { id: "d", conduct: "mixed", tags: [] },
    { id: "e", conduct: null, tags: ["no_echo"] },
  ];
  it("counts the two halves separately and puts ungraded first", () => {
    const b = gradingBacklog(rows);
    expect(b.ungraded).toBe(2);
    expect(b.noRule).toBe(2);
    expect(b.queue.map((r) => r.id)).toEqual(["b", "e", "a", "d"]);
  });
  it("the label says what each number is, and drops a zero half", () => {
    expect(backlogLabel({ ungraded: 152, noRule: 1087 })).toBe("152 not graded · 1,087 graded, no rule picked");
    expect(backlogLabel({ ungraded: 0, noRule: 3 })).toBe("3 graded, no rule picked");
    expect(backlogLabel({ ungraded: 0, noRule: 0 })).toBe("Nothing left to grade");
  });
});

describe("the rule picker", () => {
  it("hides a note written to Kate", () => {
    expect(graderDescription("NEEDS KATE: overlaps A21/A23; unclear whether it is a separate rule.")).toBe("");
    expect(graderDescription("Asked them to type an address we already held.")).toBe("Asked them to type an address we already held.");
    expect(graderDescription(null)).toBe("");
  });
  it("knows a retired code whatever its case", () => {
    const retired = new Set(["A5", "A12", "A16"]);
    expect(isRetiredCode("a5", retired)).toBe(true);
    expect(isRetiredCode("A15", retired)).toBe(false);
  });
});

describe("a rule's sheet text", () => {
  it("splits cell paragraphs, drops the sheet's markers and our own provenance", () => {
    const card = "AI tells that undercut the persona. Already in Karan's tone_rules.  ||  \n\n🔴 THIS BINDS WHAT THE BOT SAYS.  ||  \n\n⚠️ Second note.";
    expect(sheetParagraphs(card)).toEqual([
      "AI tells that undercut the persona.",
      "THIS BINDS WHAT THE BOT SAYS.",
      "Second note.",
    ]);
  });
  it("drops a marker that opens a sentence mid-paragraph", () => {
    expect(sheetParagraphs("First point.   \u26A0\uFE0F A DECLINE IS NOT ALWAYS WORDED AS ONE.")).toEqual([
      "First point.   A DECLINE IS NOT ALWAYS WORDED AS ONE.",
    ]);
  });
  it("leaves plain text alone and empty text empty", () => {
    expect(sheetParagraphs("Clumsy wording.")).toEqual(["Clumsy wording."]);
    expect(sheetParagraphs(null)).toEqual([]);
  });
});

describe("paging", () => {
  const rows = Array.from({ length: 120 }, (_, i) => i);
  it("returns one page and says where it is", () => {
    const p = pageOf(rows, 2, 50);
    expect(p.rows[0]).toBe(50);
    expect([p.page, p.pages, p.from, p.to, p.total]).toEqual([2, 3, 51, 100, 120]);
  });
  it("clamps a page past the end, and handles nothing at all", () => {
    expect(pageOf(rows, 99, 50).page).toBe(3);
    expect(pageOf(rows, 0, 50).page).toBe(1);
    expect(pageOf([], 1, 50)).toEqual({ rows: [], page: 1, pages: 1, from: 0, to: 0, total: 0 });
  });
});
