import { describe, it, expect } from "vitest";
import {
  formatAuditSheet, formatAuditCsv, transcriptOnly, conductFor, reasonFrom,
  type AuditSheet,
} from "@/lib/messaging/audit-sheet";

/** Kate's own example, 2026-09-10. */
const SHEET: AuditSheet = {
  overall: "mid",
  date: "2026-08-28",
  turns: [
    { ordinal: 1, speaker: "CAMPAIGN", channel: "SMS", at: "2026-08-28T19:05:00",
      text: "Hello, this is Precision Painting Plus. Thanks for requesting a free estimate!" },
    { ordinal: 2, speaker: "CUSTOMER", channel: "SMS", at: "2026-08-28T19:07:00",
      text: "What would be cost" },
    { ordinal: 3, speaker: "AI (Emily)", channel: "SMS", at: "2026-08-28T19:07:00",
      text: "Totally get it. For a quick quote, we can provide a quick quote for this project. Do you prefer text or email?",
      shortfall: {
        code: "A21 | Misc Awkward/mild",
        what: "Said 'For a quick quote, we can provide a quick quote for this project' in one sentence.",
        shouldHave: "kept it short and natural",
      },
      didWell: { code: "A6", why: "Customer asked what it would cost — offsite fired immediately" },
    },
  ],
};

describe("Kate's audit sheet", () => {
  /**
   * The thing her format does that ours could not: T3 is BOTH clumsy and
   * right. One verdict per turn cannot say that, so grading carries two
   * independent notes.
   */
  it("puts the same turn under both headings when it was both", () => {
    const out = formatAuditSheet(SHEET);
    const short = out.slice(out.indexOf("Where it fell short:"), out.indexOf("Good Turns:"));
    const good = out.slice(out.indexOf("Good Turns:"));
    expect(short).toContain("T3");
    expect(good).toContain("T3");
  });

  it("keeps her code and her SHOULD HAVE wording", () => {
    const out = formatAuditSheet(SHEET);
    expect(out).toContain("T3 [A21 | Misc Awkward/mild]");
    expect(out).toContain("-> SHOULD HAVE: kept it short and natural");
    expect(out).toContain("T3 [A6]");
  });

  it("writes the transcript the way her sheet does", () => {
    const out = formatAuditSheet(SHEET);
    expect(out).toContain("--- 2026-08-28 ---");
    expect(out).toContain("[1] 19:05 [SMS] CAMPAIGN: Hello, this is Precision");
    expect(out).toContain("[3] 19:07 [SMS] AI (Emily):");
  });

  it("says so rather than leaving a heading empty", () => {
    const out = formatAuditSheet({ overall: "good", turns: [SHEET.turns[0]] });
    expect(out).toContain("none noted");
  });

  it("records the overall rating in her words", () => {
    expect(formatAuditSheet(SHEET)).toContain("Overall rating: mid");
  });

  /** She says "mid"; the column says "mixed". Translate here, not on her. */
  it("maps her wording onto what the corpus stores", () => {
    expect(conductFor("mid")).toBe("mixed");
    expect(conductFor("good")).toBe("good");
    expect(conductFor("bad")).toBe("bad");
    expect(conductFor(null)).toBeNull();
  });
});

describe("the same conversation as a spreadsheet", () => {
  it("gives one row per turn with both kinds of note", () => {
    const csv = formatAuditCsv(SHEET);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(4); // header plus three turns
    expect(lines[0]).toContain("should_have");
    expect(lines[3]).toContain("A21 | Misc Awkward/mild");
    expect(lines[3]).toContain("kept it short and natural");
  });

  it("escapes a quote inside a message rather than breaking the row", () => {
    const csv = formatAuditCsv({
      overall: "good",
      turns: [{ ordinal: 1, speaker: "CUSTOMER", channel: "SMS", text: 'He said "no thanks"' }],
    });
    expect(csv).toContain('"He said ""no thanks"""');
    expect(csv.split("\n")).toHaveLength(2);
  });
});

describe("what reaches the training corpus", () => {
  it("stores what was said, without the ratings mixed in", () => {
    const t = transcriptOnly(SHEET);
    expect(t).toContain("CUSTOMER: What would be cost");
    expect(t).not.toContain("SHOULD HAVE");
    expect(t).not.toContain("A21");
  });

  it("carries every note as the reason, so a good grade still teaches", () => {
    const r = reasonFrom(SHEET)!;
    expect(r).toContain("T3 did well: Customer asked what it would cost");
    expect(r).toContain("T3 fell short:");
    expect(r).toContain("Should have: kept it short and natural");
  });

  it("has no reason when nobody wrote one", () => {
    expect(reasonFrom({ overall: "good", turns: [SHEET.turns[0]] })).toBeNull();
  });
});
