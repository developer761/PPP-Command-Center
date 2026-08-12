import { describe, it, expect } from "vitest";
import { projectStateForOpportunity } from "@/lib/commercial/projects/ensure";

/**
 * When a deal earns a project.
 *
 * The first draft of this rule said "entering a delivery status", and it was
 * wrong in a way only the live data revealed: exactly ONE deal sits in
 * `pre_construction`, while SEVEN sit in `pre_sale_closed/won` already carrying
 * invoices, AIA applications, work orders, submittals and closeout packages.
 * That rule would have created 1 project instead of 9 and left seven won jobs'
 * money attached to nothing.
 *
 * Being WON is the trigger. A delivery status is an additional entry point, not
 * the primary one.
 */
describe("projectStateForOpportunity", () => {
  it("gives a won deal a project — the case the ladder-position rule missed", () => {
    // 7 of the 9 real project-bearing deals are in exactly this state.
    const s = projectStateForOpportunity("pre_sale_closed", "won");
    expect(s.shouldExist).toBe(true);
    expect(s.projectStatus).toBe("awarded");
  });

  it("never gives a lost deal a project", () => {
    expect(projectStateForOpportunity("pre_sale_closed", "lost").shouldExist).toBe(false);
    // A closed deal with no sub-status recorded is not a win either.
    expect(projectStateForOpportunity("pre_sale_closed", null).shouldExist).toBe(false);
  });

  it("covers the deal dragged past the win, straight into delivery", () => {
    // WARN_TRANSITIONS exists because this happens: a verbal yes goes from
    // Proposal to In Progress without ever being formally closed. Keying only
    // off `won` would leave that job with no project at all.
    for (const [status, expected] of [
      ["pre_construction", "pre_construction"],
      ["in_progress", "in_progress"],
      ["billing", "billing"],
      ["post_sale_closed", "closed_out"],
    ] as const) {
      const s = projectStateForOpportunity(status, null);
      expect(s.shouldExist, status).toBe(true);
      expect(s.projectStatus, status).toBe(expected);
    }
  });

  it("does not give a deal still being sold a project", () => {
    for (const status of ["qualifying", "estimating", "proposal"]) {
      expect(projectStateForOpportunity(status, null).shouldExist, status).toBe(false);
      // …including at the very last pre-sale moment, a proposal already sent.
      expect(projectStateForOpportunity(status, "sent").shouldExist, status).toBe(false);
    }
  });

  it("treats an unknown status as not-won rather than guessing", () => {
    // Fail closed: inventing a project for a status nobody has defined would
    // put money rows under a job that was never sold.
    expect(projectStateForOpportunity("some_future_status", "whatever").shouldExist).toBe(false);
  });

  it("is a pure function of the tuple, so the un-win is decidable", () => {
    // `changeOpportunityStatus` asks this about the BEFORE state as well as the
    // after state — that comparison is what archives a project when a deal is
    // un-won, and it only works because the answer depends on nothing else.
    const won = projectStateForOpportunity("pre_sale_closed", "won");
    const unwon = projectStateForOpportunity("estimating", "estimating");
    expect(won.shouldExist && !unwon.shouldExist).toBe(true);
  });
});
