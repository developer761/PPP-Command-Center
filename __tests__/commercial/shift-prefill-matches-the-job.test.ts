import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The scheduling form's time prefill describes the shift you are editing.
 *
 * An assignment is unique on `(job_id, employee_id, work_date)` — migration 112
 * — so ONE PERSON CAN HOLD SEVERAL SHIFTS IN A DAY, one per work order. The
 * day panel builds `crew` with one entry per assignment, sorted by start time.
 *
 * The prefill I added this morning matched on the employee alone, so it picked
 * whichever of that person's shifts sorted first. And this form emails the crew:
 *
 *   Bob is 07:00-11:00 on job A and 12:00-15:00 on job B.
 *   Pick Bob + job B → the form fills in 07:00-11:00, under a line reading
 *   "Already on this day — these are their current times", writes the morning
 *   times onto the afternoon job, and emails Bob to arrive at 7.
 *
 * It was wrong for a NEW job too: Bob on job A 06:00-14:00, scheduled onto a
 * brand-new job B, was offered 06:00-14:00 from an unrelated work order while
 * claiming to be "moving" a shift it was in fact creating.
 *
 * This is a source-shape test, which is weaker than exercising the component —
 * but the alternative is no coverage at all, because the suite is deliberately
 * DOM-free, and the defect is precisely a missing term in one lookup.
 */

const src = readFileSync(
  join(process.cwd(), "components/commercial/field-ops-calendar.tsx"),
  "utf8"
);

describe("the schedule form's time prefill", () => {
  it("matches on the job as well as the person", () => {
    // THE REGRESSION: `crew.find((c) => c.employee_id === pickedEmployee)` alone.
    const lookup = src.match(/const existingShift =[\s\S]{0,400}?;\n/)?.[0] ?? "";
    expect(lookup).toContain("employee_id === pickedEmployee");
    expect(lookup).toContain("job_id === pickedJob");
    // And requires BOTH to be chosen before it claims to describe a shift.
    expect(lookup).toContain("pickedEmployee && pickedJob");
  });

  it("knows which work order is selected", () => {
    // Without an onChange on the job picker the match above is unreachable —
    // the component would compile, `pickedJob` would stay "", and the prefill
    // would silently fall back to the default for every crew member.
    expect(src).toMatch(/name="job_id"[\s\S]{0,300}?onChange=\{\(c\) => setPickedJob\(c\.value\)\}/);
    expect(src).toMatch(/name="employee_id"[\s\S]{0,300}?onChange=\{\(c\) => setPickedEmployee\(c\.value\)\}/);
  });

  it("clears the selection when the form is remounted after a save", () => {
    // `pickedEmployee`/`pickedJob` live OUTSIDE the form, which is remounted
    // via `key={`sch-${formKey}`}` on success. Without this the pickers reset
    // and the state did not, so the next blank form showed the previous
    // person's times and still called them "their current times".
    expect(src).toMatch(/setPickedEmployee\(""\);[\s\S]{0,80}setPickedJob\(""\);[\s\S]{0,80}\}, \[formKey, date\]\)/);
  });

  it("still defaults to the 7-3 day when nothing matches", () => {
    expect(src).toContain("DEFAULT_SHIFT_START");
    expect(src).toContain("DEFAULT_SHIFT_END");
    expect(src).toContain('const DEFAULT_SHIFT_START = "07:00"');
    expect(src).toContain('const DEFAULT_SHIFT_END = "15:00"');
  });
});

describe("copy week", () => {
  it("hands the server a Monday, because that is what it means", () => {
    // `copyWeekForward` runs `mondayOf(source)` and copies Mon-Sun. The week
    // view is Sunday-start, and `mondayOf(Sunday)` goes BACK six days — so
    // seeding the input with the visible week's own start date copied the
    // PREVIOUS week into the one on screen, under a button reading "Copy to
    // next week".
    expect(src).toContain("useState(() => mondayOfIso(monthStart))");
    expect(src).toMatch(/function mondayOfIso[\s\S]{0,300}dow === 0 \? -6 : 1 - dow/);
  });
});
