import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A won deal needs a work order, or the crew's hours have nowhere to go.
 *
 * Mary, 2026-10-13: *"I am not seeing some Opportunities in the Attendance
 * drop-down box. Cummins and Motormindz are examples. I see them in the
 * opportunity but not in the dropdown."*
 *
 * The Attendance picker lists WORK ORDERS — hours are logged against a job, not
 * a deal. All 92 migrated jobs have one because the importer builds a job per
 * Salesforce work order. A deal won HERE got a project and no job, so it was
 * won, carrying money, and invisible to Field Ops. Three deals were in that
 * state: MotorMindz ($30,000), Flagstar, Thermo Fisher.
 *
 * `ensureWorkOrderForWonOpportunity` does the I/O, so what is testable is the
 * part that has to be RIGHT: that its idea of "won" is the SAME as the one
 * Field Ops' own picker uses. If they drift, the picker offers deals the ensure
 * refuses — or worse, the ensure makes jobs for deals Field Ops does not think
 * are live work.
 */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The rule both sides must agree on. */
const isCurrentWork = (status: string, sub: string | null) =>
  (status === "pre_sale_closed" && sub === "won") ||
  ["pre_construction", "in_progress", "billing"].includes(status);

describe("what counts as work a crew could be standing on", () => {
  it("is won, or already in delivery", () => {
    expect(isCurrentWork("pre_sale_closed", "won")).toBe(true);
    expect(isCurrentWork("pre_construction", "coordination")).toBe(true);
    expect(isCurrentWork("in_progress", "wip_on_site")).toBe(true);
    expect(isCurrentWork("billing", "completed_and_invoiced")).toBe(true);
  });

  it("is not a bid, a loss, or a finished job", () => {
    // Cummins-Interior sits here — which is why it is correctly absent from the
    // Attendance list, and a different answer from MotorMindz's.
    expect(isCurrentWork("proposal", "sent")).toBe(false);
    expect(isCurrentWork("estimating", "estimating")).toBe(false);
    expect(isCurrentWork("qualifying", "rfp")).toBe(false);
    expect(isCurrentWork("pre_sale_closed", "lost")).toBe(false);
    // A closed-out job keeps its existing work order; it does not get a new one.
    expect(isCurrentWork("post_sale_closed", "closed")).toBe(false);
  });
});

describe("the ensure and the Field Ops picker agree", () => {
  const ensure = strip(readFileSync("lib/commercial/field-ops/ensure-work-order.ts", "utf8"));
  const picker = strip(readFileSync("lib/commercial/field-ops/jobs.ts", "utf8"));

  it("both name the same four delivery statuses", () => {
    for (const s of ["pre_construction", "in_progress", "billing"]) {
      expect(ensure).toContain(s);
      expect(picker).toContain(s);
    }
    // `[\s\S]` rather than the `s` flag — this project's TS target predates it.
    expect(ensure).toMatch(/pre_sale_closed[\s\S]{0,60}won/);
    expect(picker).toMatch(/pre_sale_closed[\s\S]{0,60}won/);
  });

  it("both skip deleted and archived deals", () => {
    // The picker filters them in SQL; the ensure has to check them itself,
    // because it is handed one id rather than running a query.
    expect(picker).toMatch(/is\("archived_at", null\)/);
    expect(ensure).toMatch(/archived_at/);
    expect(ensure).toMatch(/deleted_at/);
  });
});

describe("it cannot give one deal two work orders", () => {
  const ensure = strip(readFileSync("lib/commercial/field-ops/ensure-work-order.ts", "utf8"));
  const jobs = strip(readFileSync("lib/commercial/field-ops/jobs.ts", "utf8"));

  it("checks for an existing job before creating", () => {
    expect(ensure).toMatch(/from\("commercial_jobs"\)[\s\S]{0,200}eq\("opportunity_id"/);
  });

  it("treats createJob's own duplicate refusal as success, not failure", () => {
    /*
     * Two jobs on one deal split payroll across two job codes and duplicate the
     * calendar cards. `createJob` refuses it; if something made the job between
     * our check and the insert, that refusal means the work order exists —
     * which is the outcome we wanted — and must not be reported as an error a
     * human needs to chase.
     */
    expect(ensure).toMatch(/already has a work order\|already in use/);
  });

  it("the guard it relies on is really there", () => {
    // A test for OUR code that silently depends on THEIR guard; pin it, so
    // removing the guard fails here rather than in production payroll.
    expect(jobs).toMatch(/That deal already has a work order in Field Ops/);
  });
});

describe("winning a deal never fails because of this", () => {
  const status = strip(readFileSync("lib/commercial/opportunities/status.ts", "utf8"));

  it("is wrapped, like the project ensure beside it", () => {
    expect(status).toMatch(/ensureWorkOrderForWonOpportunity/);
    expect(status).toMatch(/work order ensure threw/);
    expect(status).toMatch(/work order ensure failed/);
  });

  it("fires only on the transition INTO won, not on every edit", () => {
    // `isProjectBearing && !wasProjectBearing` — a sub-status tweak on a deal
    // that is already in delivery must not re-enter this at all.
    expect(status).toMatch(/if \(isProjectBearing && !wasProjectBearing\)/);
  });

  it("does not schedule the job", () => {
    const ensure = strip(readFileSync("lib/commercial/field-ops/ensure-work-order.ts", "utf8"));
    // Inventing dates from the deal's proposed start would put guesses on
    // Brendan's calendar and the crews' week. It is ready_to_schedule — a real
    // job on the board, waiting for a date somebody chooses.
    expect(ensure).toMatch(/status: "ready_to_schedule"/);
    expect(ensure).toMatch(/target_start: null/);
    expect(ensure).toMatch(/target_end: null/);
  });
});
