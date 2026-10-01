import { describe, it, expect } from "vitest";
import { finishSeedPolicy } from "@/lib/customer-form/finish-seed-policy";

/**
 * "Alex doesn't want the finish to auto-populate for customers" (2026-10-01).
 *
 * This file exists because that took two passes. The first fix stopped the
 * form CHOOSING a finish when a color was picked, the suite went green, and
 * Kate came back with "Finish still auto-populates for customers" — because
 * the finish a customer actually sees comes from Salesforce's saved value on
 * the work order line item, which is a different code path entirely.
 *
 * So the test is written against the QUESTION ("may a finish be sitting in the
 * box before they answer, and whose is it?") rather than against any one of
 * the three places an answer can come from.
 */

const CUSTOMER = { isStaffEntry: false, hasOwnSubmission: false };
const CUSTOMER_REEDIT = { isStaffEntry: false, hasOwnSubmission: true };
const STAFF = { isStaffEntry: true, hasOwnSubmission: false };

describe("a customer never meets a finish they did not choose", () => {
  it("does not pre-fill Salesforce's saved finish", () => {
    // THE ONE THAT SHIPPED BROKEN. Most work orders already carry a finish, so
    // this is the common case, not an edge one.
    expect(finishSeedPolicy(CUSTOMER).fromSalesforce).toBe(false);
    expect(finishSeedPolicy(CUSTOMER_REEDIT).fromSalesforce).toBe(false);
  });

  it("does not fill one when they pick a color", () => {
    expect(finishSeedPolicy(CUSTOMER).onColorPick).toBe(false);
    expect(finishSeedPolicy(CUSTOMER_REEDIT).onColorPick).toBe(false);
  });

  it("does not inherit a finish from somebody else's entry on the same job", () => {
    // priorSubmission falls back to the latest payload for the WORK ORDER, so
    // a staff internal entry can reach a customer's fresh form. Their colors
    // are useful; their sheen is not the customer's answer.
    expect(finishSeedPolicy(CUSTOMER).fromPriorSubmission).toBe(false);
  });

  it("DOES bring back the customer's own previous answer on a re-edit", () => {
    // The one pre-fill that is theirs. Without this, coming back to change one
    // room would blank every finish they had already chosen.
    expect(finishSeedPolicy(CUSTOMER_REEDIT).fromPriorSubmission).toBe(true);
  });
});

describe("staff entry keeps its shortcuts", () => {
  it("is not what Alex asked to change", () => {
    // An AM entering a whole house on the phone. Every source stays on.
    const p = finishSeedPolicy(STAFF);
    expect(p).toEqual({ fromSalesforce: true, fromPriorSubmission: true, onColorPick: true });
  });

  it("stays on for staff even without their own submission", () => {
    expect(finishSeedPolicy({ isStaffEntry: true, hasOwnSubmission: true }).fromSalesforce).toBe(true);
  });
});
