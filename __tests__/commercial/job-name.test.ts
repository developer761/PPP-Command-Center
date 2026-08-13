import { describe, it, expect } from "vitest";
import { jobDisplayName, isAutoComposedTitle } from "@/lib/commercial/opportunities/job-name";

/**
 * What a job is called on a project card.
 *
 * Stephanie 2026-08-13: *"Why am I not seeing the job name once it is converted
 * into a project? Only the GC and the address?"*
 *
 * The examples below are REAL rows from production, not invented ones — the
 * whole decision turned on what titles actually contain.
 */

const GC = "TLA Contracting";

describe("jobDisplayName", () => {
  it("shows the name someone actually typed", () => {
    // Was displaying as "TLA Contracting - 235 Little East Neck Road".
    expect(
      jobDisplayName(
        { title: "Motor Mindz, Babylon", client_name: "TLA Contracting", property_street: "235 Little East Neck Road" },
        GC
      )
    ).toBe("Motor Mindz, Babylon");

    expect(jobDisplayName({ title: "Pacos Tacos", property_street: "77 Windsor Place" }, "Tomco Painting")).toBe(
      "Pacos Tacos"
    );
  });

  it("does not show auto-composed boilerplate", () => {
    // Showing this raw would put a date stamp and a duplicated builder name on
    // every project card — worse than the problem being fixed.
    const name = jobDisplayName(
      {
        title: "08-12-2026 DuCon Construction Co. Inc - DuCon Construction Co. Inc - 4 Henry Street",
        client_name: "DuCon Construction Co. Inc",
        property_street: "4 Henry Street",
      },
      "DuCon Construction Co. Inc"
    );
    expect(name).not.toMatch(/^\d{2}-\d{2}-\d{4}/);
    // Falls through to the derived name, which at least dedupes the repeat.
    expect(name).not.toContain("Inc - DuCon Construction Co. Inc");
  });

  it("an explicit display name still wins", () => {
    expect(
      jobDisplayName({ title_override: "The Big One", title: "Motor Mindz, Babylon" }, GC)
    ).toBe("The Big One");
  });

  it("handles a title that is only a date", () => {
    // Real row: the auto-composer ran before any other field was filled in.
    const name = jobDisplayName({ title: "08-13-2026" }, GC);
    expect(name).not.toBe("08-13-2026");
    expect(name.trim().length).toBeGreaterThan(0);
  });

  it("recognises the auto-composed shape without eating real names", () => {
    expect(isAutoComposedTitle("08-13-2026 Karan Test 1 - Escape Room")).toBe(true);
    expect(isAutoComposedTitle("08-13-2026")).toBe(true);
    // A real name that merely contains digits must not be mistaken for one.
    expect(isAutoComposedTitle("test title LMJ 123 Main")).toBe(false);
    expect(isAutoComposedTitle("235 Little East Neck Road")).toBe(false);
    expect(isAutoComposedTitle("Pacos Tacos")).toBe(false);
  });

  it("never returns an empty label", () => {
    // A project card with a blank title reads as a broken row.
    expect(jobDisplayName({}, GC).trim().length).toBeGreaterThan(0);
    expect(jobDisplayName({}, null).trim().length).toBeGreaterThan(0);
  });
});
