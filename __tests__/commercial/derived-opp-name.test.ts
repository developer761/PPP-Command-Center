import { describe, it, expect } from "vitest";
import { derivedOppName, isAutoFilledTitle } from "@/lib/commercial/opportunities/db";

/**
 * Stephanie, 2026-08-18: "Why am I not seeing the job name once it is converted
 * into a project? Only the GC and the address?"
 *
 * She typed a name into "Opportunity name" — a REQUIRED field — and it appeared
 * nowhere, because the display name read `title_override` and then jumped
 * straight to the computed "{GC} - {client} - {street}".
 *
 * The fix has to thread a needle: show a name someone actually typed, WITHOUT
 * re-labelling every existing opportunity whose title is just the untouched
 * "MM-DD-YYYY Builder - Client - Street" auto-fill.
 */

const base = {
  client_name: "Airef",
  property_street: "120 Jericho Turnpike",
  title_override: null as string | null,
};
const GC = "Tomco Painting";

describe("isAutoFilledTitle", () => {
  it("recognises the untouched auto-fill (date + computed name)", () => {
    expect(
      isAutoFilledTitle("08-18-2026 Tomco Painting - Airef - 120 Jericho Turnpike", base, GC)
    ).toBe(true);
  });

  it("recognises the computed name with no date prefix", () => {
    expect(isAutoFilledTitle("Tomco Painting - Airef - 120 Jericho Turnpike", base, GC)).toBe(true);
  });

  it("ignores punctuation and spacing drift", () => {
    // The street gets edited slightly after the title was auto-filled; that
    // must not make the default look hand-written.
    expect(
      isAutoFilledTitle("08-18-2026 Tomco Painting  -  Airef  -  120 Jericho Tpke", {
        ...base,
        property_street: "120 Jericho Tpke",
      }, GC)
    ).toBe(true);
  });

  it("treats blank, or a bare date, as no name", () => {
    expect(isAutoFilledTitle("", base, GC)).toBe(true);
    expect(isAutoFilledTitle("   ", base, GC)).toBe(true);
    expect(isAutoFilledTitle("08-18-2026", base, GC)).toBe(true);
  });

  it("recognises a REAL typed name", () => {
    expect(isAutoFilledTitle("Airef Lobby Repaint", base, GC)).toBe(false);
    expect(isAutoFilledTitle("08-18-2026 Airef Lobby Repaint", base, GC)).toBe(false);
  });
});

describe("derivedOppName", () => {
  it("shows the name Stephanie typed", () => {
    expect(derivedOppName({ ...base, title: "Airef Lobby Repaint" }, GC)).toBe("Airef Lobby Repaint");
  });

  it("leaves every existing deal looking exactly as it does today", () => {
    // THE REGRESSION GUARD. A book of opportunities carrying the untouched
    // auto-fill must keep rendering the clean computed name, not the
    // date-prefixed string.
    expect(
      derivedOppName(
        { ...base, title: "08-18-2026 Tomco Painting - Airef - 120 Jericho Turnpike" },
        GC
      )
    ).toBe("Tomco Painting - Airef - 120 Jericho Turnpike");
  });

  it("the nickname still beats everything", () => {
    expect(
      derivedOppName(
        { ...base, title: "Airef Lobby Repaint", title_override: "Jericho lobby" },
        GC
      )
    ).toBe("Jericho lobby");
  });

  it("drops a blank client from the computed name", () => {
    expect(
      derivedOppName({ ...base, client_name: null, title: "" }, GC)
    ).toBe("Tomco Painting - 120 Jericho Turnpike");
  });

  it("never renders a duplicated part when GC and client match", () => {
    expect(
      derivedOppName({ ...base, client_name: "Tomco Painting", title: "" }, GC)
    ).toBe("Tomco Painting - 120 Jericho Turnpike");
  });

  it("falls back rather than rendering an empty heading", () => {
    expect(
      derivedOppName({ client_name: null, property_street: null, title: "", title_override: null }, null)
    ).toBe("Untitled opportunity");
  });
});

/**
 * Brendan 2026-08-26: "the project nickname should go at the end of the
 * opportunity title, and we should be able to toggle that."
 *
 * The nickname used to REPLACE the whole name. Typing "Building C" erased the
 * date, the GC and the address from every list that job appears in — the three
 * things a pipeline is actually scanned by — so the shorthand cost you the
 * ability to find the job.
 *
 * Migration 170 adds `title_override_mode`. New deals default to 'append';
 * every deal that ALREADY had a nickname is backfilled to 'replace', because
 * those jobs are named what they are named today and flipping the meaning of
 * the column under live data would rename all of them at once. An undefined
 * mode — a row read before the migration lands — must read as 'replace' for
 * exactly the same reason.
 */
describe("nickname: append vs replace", () => {
  const withNick = { ...base, title: "08-18-2026 Tomco Painting - Airef - 120 Jericho Turnpike" };

  it("appends to the end, keeping the GC and address", () => {
    // The base here is the COMPUTED name. An untouched auto-fill resolves
    // through computedOppName, which has never carried the date prefix — the
    // date lives on the raw `title` column, not on what lists display.
    expect(
      derivedOppName({ ...withNick, title_override: "Building C", title_override_mode: "append" }, GC)
    ).toBe("Tomco Painting - Airef - 120 Jericho Turnpike - Building C");
  });

  it("replaces outright when that is the mode", () => {
    expect(
      derivedOppName({ ...withNick, title_override: "Building C", title_override_mode: "replace" }, GC)
    ).toBe("Building C");
  });

  it("an unmigrated row (mode undefined) keeps the name it has today", () => {
    // The regression that would rename every existing job on one deploy.
    expect(derivedOppName({ ...withNick, title_override: "Building C" }, GC)).toBe("Building C");
  });

  it("does not repeat a nickname the title already ends with", () => {
    expect(
      derivedOppName(
        { ...base, title: "Riverhead Job - Building C", title_override: "Building C", title_override_mode: "append" },
        GC
      )
    ).toBe("Riverhead Job - Building C");
    // Same check, ignoring case and punctuation drift.
    expect(
      derivedOppName(
        { ...base, title: "Riverhead Job — building c", title_override: "Building C", title_override_mode: "append" },
        GC
      )
    ).toBe("Riverhead Job — building c");
  });

  it("appends onto a hand-written title, not just the computed one", () => {
    expect(
      derivedOppName(
        { ...base, title: "Riverhead High School", title_override: "Phase 2", title_override_mode: "append" },
        GC
      )
    ).toBe("Riverhead High School - Phase 2");
  });

  it("stands alone when there is nothing to append to", () => {
    expect(
      derivedOppName(
        { client_name: null, property_street: null, title: "", title_override: "Building C", title_override_mode: "append" },
        null
      )
    ).toBe("Building C");
  });

  it("no nickname behaves exactly as before", () => {
    expect(derivedOppName({ ...withNick, title_override: null, title_override_mode: "append" }, GC)).toBe(
      "Tomco Painting - Airef - 120 Jericho Turnpike"
    );
  });
});
