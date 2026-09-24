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

  /**
   * THE BUG KARAN REPORTED, 2026-09-23: *"it was a button either in new opp or
   * accounts and when we pressed it it was supposed to do something with the
   * title and it never did."*
   *
   * The button is "Add it to the end of the full name". It saved correctly, and
   * the pipeline list obeyed it — but `jobDisplayName` returned the nickname
   * unconditionally, so the opportunity header and every project card, which is
   * where you look immediately after saving, showed the nickname on its own.
   * The toggle did work. The screen never asked.
   */
  it("appends the nickname when the toggle says to — the header bug", () => {
    expect(
      jobDisplayName(
        { title_override: "The Big One", title: "Motor Mindz, Babylon", title_override_mode: "append" },
        GC
      )
    ).toBe("Motor Mindz, Babylon - The Big One");
  });

  it("replaces outright when the toggle is off", () => {
    expect(
      jobDisplayName(
        { title_override: "The Big One", title: "Motor Mindz, Babylon", title_override_mode: "replace" },
        GC
      )
    ).toBe("The Big One");
  });

  it("appends onto the derived name when the title is auto-composed", () => {
    // Nothing hand-typed to append to, so the GC and street survive instead of
    // being thrown away.
    expect(
      jobDisplayName(
        {
          title: "08-13-2026 DuCon Construction Co. Inc - DuCon Construction Co. Inc - 4 Henry Street",
          client_name: "DuCon Construction Co. Inc",
          property_street: "4 Henry Street",
          title_override: "Phase 2",
          title_override_mode: "append",
        },
        "DuCon Construction Co. Inc"
      )
    ).toBe("DuCon Construction Co. Inc - 4 Henry Street - Phase 2");
  });

  it("does not repeat a nickname the title already ends with", () => {
    expect(
      jobDisplayName(
        { title: "Motor Mindz - The Big One", title_override: "The Big One", title_override_mode: "append" },
        GC
      )
    ).toBe("Motor Mindz - The Big One");
  });

  it("stands alone when there is no name to append to", () => {
    expect(
      jobDisplayName({ title: "08-13-2026", title_override: "The Big One", title_override_mode: "append" }, null)
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
