import { describe, it, expect } from "vitest";
import { resolveTeamForZip, parseZipPrefixes, normalizeZip, type TeamTerritory } from "@/lib/commercial/teams/zip-territory";

/**
 * Zip → team, the rule Brendan asked for: "the location of the job will
 * determine the team who will execute the project."
 */

const suffolk: TeamTerritory = { id: "s", name: "Tomco Suffolk", zip_prefixes: ["117"], created_at: "2026-01-01" };
const islip:   TeamTerritory = { id: "i", name: "Islip Crew",    zip_prefixes: ["11722"], created_at: "2026-02-01" };
const nassau:  TeamTerritory = { id: "n", name: "Tomco Nassau",  zip_prefixes: ["115"], created_at: "2026-01-01" };
const trainee: TeamTerritory = { id: "t", name: "Trainee Shadow", zip_prefixes: ["117"], created_at: "2026-06-01" };

describe("resolveTeamForZip", () => {
  it("matches a team by zip prefix", () => {
    expect(resolveTeamForZip("11780", [suffolk, nassau])?.team.name).toBe("Tomco Suffolk");
    expect(resolveTeamForZip("11501", [suffolk, nassau])?.team.name).toBe("Tomco Nassau");
  });

  it("the most specific territory wins", () => {
    // One town belonging to a different crew than the county around it is the
    // normal case, not the exception.
    const hit = resolveTeamForZip("11722", [suffolk, islip]);
    expect(hit?.team.name).toBe("Islip Crew");
    expect(hit?.matchedPrefix).toBe("11722");
  });

  it("a broader team is NOT reported as a rival", () => {
    // Suffolk covering 117 is the territory Islip sits inside — that is
    // hierarchy, not ambiguity, and flagging it would cry wolf on every job.
    expect(resolveTeamForZip("11722", [suffolk, islip])?.runnersUp).toEqual([]);
  });

  it("allows two teams on the same prefix, and says so", () => {
    // Mac named Salesforce's one-owner-per-zip rule as the thing that breaks on
    // new hires: a trainee has to shadow territory that already belongs to
    // someone. Refusing overlap here would rebuild that limitation.
    const hit = resolveTeamForZip("11780", [suffolk, trainee]);
    expect(hit?.team.name).toBe("Tomco Suffolk"); // older team wins
    expect(hit?.runnersUp.map((t) => t.name)).toEqual(["Trainee Shadow"]);
  });

  it("breaks ties the same way every time", () => {
    // Input order must not decide who gets the job.
    const a = resolveTeamForZip("11780", [trainee, suffolk])?.team.id;
    const b = resolveTeamForZip("11780", [suffolk, trainee])?.team.id;
    expect(a).toBe(b);
  });

  it("returns null rather than guessing", () => {
    expect(resolveTeamForZip("90210", [suffolk, nassau])).toBeNull();
    expect(resolveTeamForZip(null, [suffolk])).toBeNull();
    expect(resolveTeamForZip("117", [suffolk])).toBeNull();       // not a full zip
    expect(resolveTeamForZip("11780", [])).toBeNull();
  });

  it("ignores a team with no territory", () => {
    expect(resolveTeamForZip("11780", [{ ...suffolk, zip_prefixes: [] }])).toBeNull();
  });

  it("handles a ZIP+4 and stray formatting", () => {
    expect(normalizeZip("11722-1234")).toBe("11722");
    expect(resolveTeamForZip("11722-1234", [islip])?.team.name).toBe("Islip Crew");
  });
});

describe("parseZipPrefixes", () => {
  it("accepts the ways a person actually types a list", () => {
    expect(parseZipPrefixes("117, 11722\n11780;  115")).toEqual(["117", "11722", "11780", "115"]);
  });

  it("de-duplicates", () => {
    expect(parseZipPrefixes("117 117 117")).toEqual(["117"]);
  });

  it("drops entries that cannot mean anything", () => {
    // A single digit covers a tenth of the country; more than five cannot match
    // a zip at all. Both are typos, not territories.
    expect(parseZipPrefixes("1, 117, 1172233, abc")).toEqual(["117"]);
  });
});
