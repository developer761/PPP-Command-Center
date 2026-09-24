import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../helpers/strip-comments";

/**
 * Karan 2026-09-23: *"just to make sure that when we add someone in teams or
 * estimator for an account or opp then it like notifies them and they're
 * technically tied to the job, and when I click like estimator or add team
 * then a dropdown should pop up with the respective estimator or teams."*
 *
 * Two halves of one defect on the PIPELINE's New Opportunity form.
 *
 *   · Team had a dropdown. Estimator was a bare text box, so what you typed
 *     became `estimator_name` — a string on the deal. Nobody was assigned,
 *     nobody was emailed, and the Team tab answered "who is on this?" wrong.
 *   · Even picking a real person only worked on EDIT. `createOpportunity`
 *     wrote the column and stopped, so a deal created with the estimator
 *     already filled in — which is how the form is actually used — notified
 *     nobody.
 *
 * These are seam assertions: form ↔ action ↔ mutation. The unit suite here is
 * pure-logic by design and cannot see a field a form posts and an action never
 * reads, which is exactly the shape of this bug. Source is read with comments
 * stripped — five tests in this repo have matched their own prose.
 */

const read = (p: string) => stripComments(readFileSync(p, "utf8"));

describe("naming an estimator assigns a person", () => {
  const PIPELINE = read("app/commercial/opportunities/page.tsx");
  const ACCOUNT = read("app/commercial/accounts/[id]/page.tsx");
  const MUTATIONS = read("lib/commercial/opportunities/mutations.ts");

  it("the pipeline's new-opportunity form offers the roster, not a blank box", () => {
    expect(PIPELINE).toContain('name="estimator_user_id"');
    expect(PIPELINE).toContain("listPlatformEstimators");
  });

  it("the action that receives it reads the id, and hands it to the mutation", () => {
    expect(PIPELINE).toContain('formData.get("estimator_user_id")');
    // The field a form posts and an action never reads is this repo's most
    // repeated bug; both sides asserted, not just the input.
    expect(PIPELINE).toMatch(/\n\s+estimator_user_id,/);
  });

  it("both account forms still offer it too", () => {
    // Parity: the pipeline form drifted behind this one once already.
    expect(ACCOUNT).toContain('name="estimator_user_id"');
    expect(ACCOUNT).toContain("listEstimatorChoices");
  });

  it("creating a deal with an estimator assigns and notifies them", () => {
    // The fix. Both paths call the SAME function — one way to become an
    // assignment, one notification, nothing to keep in step.
    const create = MUTATIONS.slice(
      MUTATIONS.indexOf("export async function createCommercialOpportunity"),
      MUTATIONS.indexOf("export async function updateCommercialOpportunity"),
    );
    expect(create.length).toBeGreaterThan(0);
    expect(create).toContain("addOpportunityAssignment");
    expect(create).toContain('role: "estimator"');
  });

  it("editing a deal to change the estimator still does", () => {
    const update = MUTATIONS.slice(MUTATIONS.indexOf("export async function updateCommercialOpportunity"));
    expect(update).toContain("addOpportunityAssignment");
    expect(update).toContain('role: "estimator"');
  });
});
