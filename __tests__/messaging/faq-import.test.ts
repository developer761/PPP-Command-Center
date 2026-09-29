import { describe, it, expect } from "vitest";
import { buildFaqImportPreview, toFaqRecords, MAX_FAQ_IMPORT_ROWS } from "@/lib/messaging/faq-import";

/**
 * Loading the standing answers from a spreadsheet.
 *
 * ~25 answers per workspace, one row at a time, is roughly 555 clicks for 15
 * workspaces and 1,180 for 32 — and the per-workspace ones are the answers
 * most likely to change, so the cost recurs. This is the shortcut.
 *
 * It is also a door into the one table whose rows are sentences the BOT says
 * as PPP, in bulk, across every workspace at once. So the thing under test is
 * not really the parsing. It is that the file cannot get past a single check
 * a typed answer has to pass.
 */
const WS = [
  { id: "11111111-1111-1111-1111-111111111111", name: "NY LI Nassau Leads" },
  { id: "22222222-2222-2222-2222-222222222222", name: "CA LA Leads" },
];
const ctx = (existing: { workspaceId: string | null; question: string }[] = []) =>
  ({ workspaces: WS, existing });

const csv = (...lines: string[]) => lines.join("\n");

describe("reading the file", () => {
  it("treats a row with no workspace as shared", () => {
    const p = buildFaqImportPreview(
      csv("question,answer", "Are you insured?,Yes - fully licensed and insured."), ctx()
    );
    expect(p.usable).toBe(1);
    expect(p.shared).toBe(1);
    expect(p.rows[0].workspaceId).toBeNull();
  });

  it("resolves a workspace by name", () => {
    const p = buildFaqImportPreview(
      csv("workspace,question,answer", "CA LA Leads,Where are you located?,Pasadena."), ctx()
    );
    expect(p.usable).toBe(1);
    expect(p.rows[0].workspaceId).toBe(WS[1].id);
  });

  it("matches a workspace name regardless of case and spacing", () => {
    const p = buildFaqImportPreview(
      csv("workspace,question,answer", "  ca la   leads ,Where are you?,Pasadena."), ctx()
    );
    expect(p.rows[0].workspaceId).toBe(WS[1].id);
  });

  /**
   * THE WORST THING THIS IMPORTER COULD DO.
   *
   * A typo in a workspace name, treated as "no workspace", promotes one
   * region's answer into EVERY region — and it would look like a successful
   * import. So an unmatched name is a refused row, never a shared one.
   */
  it("refuses an unknown workspace rather than sharing it", () => {
    const p = buildFaqImportPreview(
      csv("workspace,question,answer", "NY LI Nassu Leads,Are you insured?,Yes."), ctx()
    );
    expect(p.usable).toBe(0);
    expect(p.rows[0].problem).toMatch(/no workspace called/i);
    expect(p.rows[0].workspaceId).toBeNull();
    expect(p.shared).toBe(0);
  });

  it("reads columns named the way a person would name them", () => {
    const p = buildFaqImportPreview(
      csv("Region,Customer question,What we say", "CA LA Leads,Are you insured?,Yes."), ctx()
    );
    expect(p.detectedHeaders.workspace).toBe("Region");
    expect(p.usable).toBe(1);
  });

  it("says which columns it found when it cannot find them", () => {
    const p = buildFaqImportPreview(csv("foo,bar", "a,b"), ctx());
    expect(p.detectedHeaders.question).toBeNull();
    expect(p.rows[0].problem).toMatch(/needs a question column/i);
  });

  it.each([
    ["no question", csv("question,answer", ",Yes."), /no question/],
    ["no answer", csv("question,answer", "Are you insured?,"), /no answer/],
    ["an empty row", csv("question,answer", ","), /empty/],
  ])("refuses a row with %s", (_label, text, match) => {
    expect(buildFaqImportPreview(text, ctx()).rows[0].problem).toMatch(match);
  });

  it("points at the line in the file", () => {
    const p = buildFaqImportPreview(
      csv("question,answer", "Are you insured?,Yes.", "Bad row,"), ctx()
    );
    // Line 3: one header plus two rows, 1-indexed.
    expect(p.rows[1].line).toBe(3);
  });
});

/**
 * ── A CSV IS NOT A SIDE DOOR ────────────────────────────────────────────
 *
 * Every row goes through the same checkFaq a typed answer does. An import
 * that skipped it would put a price, or a service area, into a model prompt
 * in bulk — and the shared tier means one row reaches every workspace.
 */
describe("the checks a typed answer has to pass", () => {
  const problem = (text: string) => buildFaqImportPreview(text, ctx()).rows[0].problem ?? "";

  it("refuses a price (A1), which the bot may never quote", () => {
    expect(problem(csv("question,answer", "How much?,About $2500.")))
      .toMatch(/contains a price/i);
  });

  it("refuses naming another company (A18)", () => {
    expect(problem(csv("question,answer", "Do you do roofs?,No - try another company for that.")))
      .toMatch(/another company/i);
  });

  it("refuses a location-bound question on a SHARED row", () => {
    // One service area written once is wrong in every other region, and by
    // CSV it arrives in all of them at once.
    expect(problem(csv("question,answer", "Where are you located?,Pasadena.")))
      .toMatch(/depends on where the workspace is/i);
  });

  it("allows that same row when it names a workspace", () => {
    const p = buildFaqImportPreview(
      csv("workspace,question,answer", "CA LA Leads,Where are you located?,Pasadena."), ctx()
    );
    expect(p.rows[0].problem).toBeNull();
  });

  it("refuses an answer long enough to be a document", () => {
    expect(problem(csv("question,answer", `Long?,${"x".repeat(700)}`))).toMatch(/characters/);
  });
});

describe("saying what would actually happen", () => {
  it("counts rows that REPLACE an answer already held", () => {
    /**
     * "312 rows will be imported" hides that 200 of them overwrite answers
     * somebody wrote last week. A preview that cannot tell adding from
     * replacing is not a preview.
     */
    const p = buildFaqImportPreview(
      csv("question,answer", "Are you insured?,New wording.", "Do you do EPA work?,Yes."),
      ctx([{ workspaceId: null, question: "are you insured? " }])
    );
    expect(p.usable).toBe(2);
    expect(p.replacing).toBe(1);
  });

  it("does not call it a replacement when the workspace differs", () => {
    const p = buildFaqImportPreview(
      csv("workspace,question,answer", "CA LA Leads,Are you insured?,Yes."),
      ctx([{ workspaceId: null, question: "Are you insured?" }])
    );
    expect(p.replacing).toBe(0);
  });

  it("catches the same question twice inside one file", () => {
    // Two rows answering one question is the "two rows disagree forever"
    // failure arriving by spreadsheet.
    const p = buildFaqImportPreview(
      csv("question,answer", "Are you insured?,Yes.", "are you insured?,Also yes."), ctx()
    );
    expect(p.duplicates).toBe(1);
    expect(p.usable).toBe(1);
    expect(p.rows[1].problem).toMatch(/appears earlier/i);
  });

  it("keeps the same question apart when it is for different workspaces", () => {
    const p = buildFaqImportPreview(csv(
      "workspace,question,answer",
      "CA LA Leads,Where are you?,Pasadena.",
      "NY LI Nassau Leads,Where are you?,Garden City."
    ), ctx());
    expect(p.usable).toBe(2);
    expect(p.duplicates).toBe(0);
  });

  it("hands the caller only the rows that would be written", () => {
    const p = buildFaqImportPreview(
      csv("question,answer", "Are you insured?,Yes.", "How much?,About $2500."), ctx()
    );
    expect(toFaqRecords(p)).toEqual([
      { workspaceId: null, question: "Are you insured?", answer: "Yes." },
    ]);
  });

  it("stops at the row cap rather than timing out", () => {
    const many = ["question,answer", ...Array.from(
      { length: MAX_FAQ_IMPORT_ROWS + 50 }, (_, i) => `Question ${i}?,Answer ${i}.`
    )];
    expect(buildFaqImportPreview(csv(...many), ctx()).rows).toHaveLength(MAX_FAQ_IMPORT_ROWS);
  });
});
