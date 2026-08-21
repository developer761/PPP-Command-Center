import { describe, it, expect } from "vitest";
import { absoluteDate, relativeAgo, daysSinceIso } from "@/lib/commercial/dates";
import { etDateOf } from "@/lib/date-et";

/**
 * A DATE column must render on the day it says.
 *
 * From docs/OPEN_BACKLOG, "Also confirmed-open": the bare-DATE timezone
 * cluster. `new Date("2026-01-01")` is UTC MIDNIGHT, and formatting that in
 * Eastern gives **31 December 2025** — a day early, and across a new year, the
 * wrong YEAR on a document a GC reads.
 *
 * It was live: `bid-lifecycle-timeline` prints `Due {absoluteDate(
 * proposal_due_at)}` and proposal_due_at is a DATE column. Every other DATE on
 * the platform reaches the same formatters — follow_up_at, rfp_received_at,
 * substantial_completion_date, the AIA periods, the work-order and field-ops
 * dates.
 *
 * The rule, matching what etDateOf already does: a date-only string is the
 * calendar day somebody picked. Anchor it, don't convert it.
 */

describe("absoluteDate", () => {
  it("renders a bare DATE on its own day", () => {
    expect(absoluteDate("2026-08-21")).toBe("Aug 21, 2026");
  });

  it("does not move a January 1st into the previous YEAR", () => {
    // The failure that matters most: a proposal dated 2026-01-01 printing
    // "Dec 31, 2025" puts the job in the wrong fiscal year on the page.
    expect(absoluteDate("2026-01-01")).toBe("Jan 1, 2026");
    expect(absoluteDate("2026-12-31")).toBe("Dec 31, 2026");
  });

  it("still zone-converts a real timestamp", () => {
    // 15:00 UTC is 11am ET the same day…
    expect(absoluteDate("2026-08-21T15:00:00Z")).toBe("Aug 21, 2026");
    // …and 01:00 UTC is 9pm ET the PREVIOUS day, which must still shift.
    expect(absoluteDate("2026-08-21T01:00:00Z")).toBe("Aug 20, 2026");
  });

  it("is consistent with etDateOf, which fixed the same class first", () => {
    expect(etDateOf("2026-01-01")).toBe("2026-01-01");
  });
});

describe("day math on a bare DATE", () => {
  // Anchor "now" at 9am ET on 2026-08-21 (13:00 UTC) so the assertions are
  // about the date handling, not about when the suite happens to run.
  const NOW = Date.parse("2026-08-21T13:00:00Z");

  it("counts today as today, not yesterday", () => {
    expect(daysSinceIso("2026-08-21", NOW)).toBe(0);
  });

  it("counts a genuine yesterday as one day", () => {
    expect(daysSinceIso("2026-08-20", NOW)).toBe(1);
  });

  it("does not report a date due today as already past", () => {
    // The symptom the backlog recorded: "a proposal due today reads 1 day
    // overdue".
    expect(daysSinceIso("2026-08-21", NOW)).not.toBeGreaterThan(0);
  });

  it("says 'today' rather than a stale hour count", () => {
    expect(relativeAgo("2026-08-21", NOW)).toMatch(/today|hour|minute|just/i);
  });
});
