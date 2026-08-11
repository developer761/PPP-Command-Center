import { describe, it, expect } from "vitest";
import { isCrewAllowedPath, CREW_HOME } from "@/lib/commercial/crew-access";

/**
 * The crew allowlist is a security boundary, so it gets tested like one: the
 * cases that matter are the ones that would let a crew login somewhere it
 * shouldn't be, and prefix matching is exactly where that goes wrong.
 */
describe("crew route allowlist", () => {
  it("allows the crew's own surfaces", () => {
    for (const p of [
      "/commercial/crew",
      "/commercial/crew/schedule",
      "/commercial/crew/hours",
      "/commercial/crew/jobs",
      "/commercial/field-ops/clock-station",
    ]) {
      expect(isCrewAllowedPath(p), p).toBe(true);
    }
  });

  it("allows nested paths under an allowed prefix", () => {
    expect(isCrewAllowedPath("/commercial/crew/schedule/2026-08-11")).toBe(true);
    expect(isCrewAllowedPath("/commercial/crew/hours/abc")).toBe(true);
  });

  it("DENIES the company-wide field-ops pages", () => {
    // These were briefly allowlisted, which granted access to pages that then
    // self-gate to admins — three tiles that bounced the crew member back with
    // no message. They're also company-wide (every employee, every job, all
    // hours), so allowlisting them is a leak waiting for one gate to relax.
    for (const p of [
      "/commercial/field-ops/schedule",
      "/commercial/field-ops/calendar",
      "/commercial/field-ops/hours",
    ]) {
      expect(isCrewAllowedPath(p), p).toBe(false);
    }
  });

  it("denies the money and admin surfaces", () => {
    for (const p of [
      "/commercial",
      "/commercial/opportunities",
      "/commercial/accounts",
      "/commercial/invoices",
      "/commercial/proposals",
      "/commercial/reports",
      "/commercial/settings",
      "/commercial/settings/access",
      "/commercial/field-ops/payroll",
      "/commercial/field-ops/employees",
      "/commercial/field-ops/approvals",
      "/commercial/field-ops/overview",
    ]) {
      expect(isCrewAllowedPath(p), p).toBe(false);
    }
  });

  it("does not let a lookalike path ride in on a prefix", () => {
    // The classic prefix-matching hole: startsWith("/commercial/crew") would
    // wave these through.
    expect(isCrewAllowedPath("/commercial/crewpayroll")).toBe(false);
    expect(isCrewAllowedPath("/commercial/crew-payroll")).toBe(false);
    expect(isCrewAllowedPath("/commercial/field-ops/clock-station-admin")).toBe(false);
  });

  it("ignores query strings, hashes and trailing slashes", () => {
    expect(isCrewAllowedPath("/commercial/crew/schedule?week=2026-08-11")).toBe(true);
    expect(isCrewAllowedPath("/commercial/crew/")).toBe(true);
    expect(isCrewAllowedPath("/commercial/crew/hours#today")).toBe(true);
    // …and can't be tricked into allowing a denied route via a query.
    expect(isCrewAllowedPath("/commercial/reports?x=/commercial/crew")).toBe(false);
  });

  it("denies an empty or unknown path", () => {
    for (const p of ["", "/", "/dashboard", "/commercial/", "/anything"]) {
      expect(isCrewAllowedPath(p), p).toBe(false);
    }
  });

  it("keeps the redirect target inside the allowlist", () => {
    // If CREW_HOME were ever denied, every crew request would redirect-loop.
    expect(isCrewAllowedPath(CREW_HOME)).toBe(true);
  });
});
