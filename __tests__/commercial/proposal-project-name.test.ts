import { describe, it, expect } from "vitest";
import { proposalProjectName } from "@/lib/commercial/proposals/project-name";

/**
 * What prints on the PROJECT line of a customer-facing proposal.
 *
 * Stephanie 2026-08-13: *"Proposals autofills the GC/Builders name, not the
 * opportunity/project name."* The builder is already printed above as
 * `gc_company`, so repeating it as PROJECT was both redundant and wrong.
 *
 * Worth real tests rather than a glance: this is on every PDF a GC receives,
 * and the old rule looked reasonable while producing the wrong line.
 */

const ACCOUNT = "Tomco Painting";

describe("proposalProjectName", () => {
  it("does not lead with the builder when a job is on file", () => {
    const name = proposalProjectName(
      { client_name: "JD Sports", property_street: "123 Main St", title: "08-13-2026 Tomco - JD Sports - 123 Main St" },
      ACCOUNT
    );
    expect(name).toBe("JD Sports - 123 Main St");
    expect(name).not.toContain(ACCOUNT);
  });

  it("an explicit custom name still wins over everything", () => {
    // Katie's 2026-07-20 rule. Regressing this puts "Jones Property" back on a
    // PDF where somebody deliberately typed something else.
    expect(
      proposalProjectName(
        { title_override: "The Big Job at Jones", client_name: "Jones", property_street: "5 Elm" },
        ACCOUNT
      )
    ).toBe("The Big Job at Jones");
  });

  it("uses whichever half of the job exists", () => {
    expect(proposalProjectName({ client_name: "JD Sports" }, ACCOUNT)).toBe("JD Sports");
    expect(proposalProjectName({ property_street: "123 Main St" }, ACCOUNT)).toBe("123 Main St");
  });

  it("falls back rather than printing an empty PROJECT line", () => {
    // A bare deal must still print something — a blank PROJECT on a customer
    // PDF reads as a broken document.
    const name = proposalProjectName({ title: "Walk-in enquiry" }, ACCOUNT);
    expect(name.trim().length).toBeGreaterThan(0);
  });

  it("ignores whitespace-only fields instead of printing a stray separator", () => {
    expect(
      proposalProjectName({ client_name: "   ", property_street: "123 Main St" }, ACCOUNT)
    ).toBe("123 Main St");
    expect(
      proposalProjectName({ title_override: "   ", client_name: "JD Sports" }, ACCOUNT)
    ).toBe("JD Sports");
  });
});
