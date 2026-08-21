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
