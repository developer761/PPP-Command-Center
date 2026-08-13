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
  it("keeps Katie's end-customer convention: client name alone", () => {
    // Katie 2026-07-20, the Tomco JD-Sports convention. An earlier version of
    // Stephanie's fix appended the street here, which quietly changed the
    // printed name on every deal Katie's rule covers. Her complaint was about
    // the FALLBACK, not about these.
    const name = proposalProjectName(
      { client_name: "JD Sports", property_street: "123 Main St", title: "08-13-2026 Tomco - JD Sports - 123 Main St" },
      ACCOUNT
    );
    expect(name).toBe("JD Sports");
    expect(name).not.toContain(ACCOUNT);
  });

  it("names the job by address when there is no customer label", () => {
    // Stephanie 2026-08-13. This is the case that used to fall through to the
    // composed "{account} - {client} - {street}" and open with the builder.
    const name = proposalProjectName({ property_street: "123 Main St" }, ACCOUNT);
    expect(name).toBe("123 Main St");
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
