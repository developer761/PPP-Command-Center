import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EXCLUSION_KINDS, isExclusionKind } from "@/lib/commercial/exclusions/constants";

/**
 * Stephanie 2026-08-17: "Qualifications should be its own section after
 * exclusions, not grouped in with alternates."
 *
 * Two different statements: an exclusion is work we are NOT doing, a
 * qualification is a condition the PRICE DEPENDS ON. One list under one
 * "Exclusions:" heading meant a qualification either read as a refusal or got
 * typed into the alternate notes to keep it out — which is how it ended up
 * beside the alternates on the page.
 */
describe("exclusion kinds", () => {
  it("has exactly the two the proposal prints", () => {
    expect([...EXCLUSION_KINDS]).toEqual(["exclusion", "qualification"]);
  });

  it("rejects anything else, so a bad post can't relocate a line", () => {
    expect(isExclusionKind("qualification")).toBe(true);
    expect(isExclusionKind("qualifications")).toBe(false);
    expect(isExclusionKind("")).toBe(false);
    expect(isExclusionKind(undefined)).toBe(false);
  });

  it("matches the DB CHECK constraint exactly", () => {
    // The app list and the Postgres constraint are the classic "one list in two
    // places" — and Postgres is the copy TypeScript cannot see.
    const sql = readFileSync("supabase/migrations/164_exclusion_kind_qualification.sql", "utf8");
    for (const k of EXCLUSION_KINDS) {
      expect(sql, `migration doesn't allow "${k}"`).toContain(`'${k}'`);
    }
    expect(sql).toContain("DEFAULT 'exclusion'");
  });
});

describe("the proposal prints them as separate sections", () => {
  const SRC = readFileSync("lib/commercial/proposals/pdf.tsx", "utf8");

  it("Qualifications comes after Exclusions", () => {
    const ex = SRC.indexOf("<ExclusionsBlock");
    const qual = SRC.indexOf("<QualificationsBlock");
    expect(ex).toBeGreaterThan(-1);
    expect(qual).toBeGreaterThan(-1);
    expect(qual, "Qualifications must render after Exclusions").toBeGreaterThan(ex);
  });

  it("each has its own heading", () => {
    expect(SRC).toContain(">Exclusions:<");
    expect(SRC).toContain(">Qualifications:<");
  });
});

describe("only ONE thing is called Qualifications", () => {
  const PDF = readFileSync("lib/commercial/proposals/pdf.tsx", "utf8");
  const EDITOR = readFileSync(
    "app/commercial/accounts/[id]/deals/[dealId]/proposal/[proposalId]/page.tsx",
    "utf8"
  );

  /**
   * Migration 164 gave the exclusions library a `kind`, and the PDF a
   * "Qualifications:" heading fed by it. But the editor ALREADY had a box
   * titled "Qualifications" — renamed from "Alternate description" at
   * Stephanie's request — and that box wrote `alternate_notes`, which printed
   * INSIDE the Alternate block.
   *
   * So the platform had two different things under one name, and typing into
   * the box marked Qualifications put nothing under the heading marked
   * Qualifications. That was introduced by the 164 work, not reported by her.
   *
   * Her original words are the resolution: "Qualifications should be its own
   * section after exclusions, not grouped in with alternates."
   */
  it("the alternate block no longer prints the qualifications paragraph", () => {
    expect(PDF).not.toContain("altNotes");
  });

  it("the paragraph prints in the Qualifications section instead", () => {
    expect(PDF).toContain("<QualificationsBlock qualifications={qualifications} notes={proposal.alternate_notes} />");
  });

  it("an alternates block with no alternate LINES renders nothing", () => {
    // It used to render for a note alone; the note now lives elsewhere, so the
    // old guard would have produced an empty "Alternate:" heading.
    const block = PDF.slice(PDF.indexOf("function AlternateSectionCustomer"));
    expect(block.slice(0, 400)).toContain("if (items.length === 0) return null;");
  });

  it("the editor stops promising the old placement", () => {
    expect(EDITOR).not.toContain("shown above the alternate line items");
    expect(EDITOR).toContain("Prints in its own section after Exclusions");
  });

  it("the picker can tell an exclusion from a qualification", () => {
    // Without this the only way to learn where a library line prints was to
    // render the PDF and look.
    const picker = readFileSync("components/commercial/exclusion-picker.tsx", "utf8");
    expect(picker).toContain("KindBadge");
    expect(picker).toContain('kind?: "exclusion" | "qualification"');
    // …and the search endpoint has to actually send it.
    const api = readFileSync("app/api/commercial/exclusions/search/route.ts", "utf8");
    expect(api).toContain("kind: r.kind");
  });
});
