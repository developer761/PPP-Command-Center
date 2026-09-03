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
  it("names the job by its ADDRESS when it has one", () => {
    // Brendan 2026-09-03, asked what the customer-facing name should be:
    // "I'd say it's should be the the address."
    //
    // This reverses Katie's 2026-07-20 order (the Tomco "JD Sports"
    // convention — end-customer label alone). The two only disagree on a job
    // carrying BOTH, and a GC's own records key on the site more often than on
    // the end tenant. Katie's rule survives as the fallback below.
    const name = proposalProjectName(
      { client_name: "JD Sports", property_street: "123 Main St", title: "08-13-2026 Tomco - JD Sports - 123 Main St" },
      ACCOUNT
    );
    expect(name).toBe("123 Main St");
    expect(name).not.toContain(ACCOUNT);
  });

  it("still uses the end-customer name when there is no address", () => {
    // Katie's convention, now the fallback rather than the lead.
    expect(
      proposalProjectName({ client_name: "JD Sports", property_street: null }, ACCOUNT)
    ).toBe("JD Sports");
  });

  it("names the job by address when there is no customer label", () => {
    // Stephanie 2026-08-13. This is the case that used to fall through to the
    // composed "{account} - {client} - {street}" and open with the builder.
    const name = proposalProjectName({ property_street: "123 Main St" }, ACCOUNT);
    expect(name).toBe("123 Main St");
    expect(name).not.toContain(ACCOUNT);
  });

  it("keeps the NICKNAME off the customer's copy", () => {
    // Brendan 2026-09-03: "Let's not use the nickname customer facing. It
    // should always be the most formal name customer facing." His proposal
    // went out titled "Main" — office shorthand — for Plainview at 115
    // Connetquot Avenue. The live nicknames make the case: "Ste A1",
    // "Exterior", "Tomco Office".
    //
    // This supersedes Katie 2026-07-20 ("an explicit title_override must win"),
    // and the two do not actually conflict: her field was "Custom display
    // name", a formal name someone typed. Migration 170 turned it into
    // "Project nickname · what the team calls it". Same column, different
    // meaning, so the rule that governs it changed with it.
    expect(
      proposalProjectName(
        { title_override: "Main", client_name: "Plainview", property_street: "115 Connetquot Ave" },
        ACCOUNT
      )
    ).toBe("115 Connetquot Ave");
  });

  it("does not let the nickname back in through the fallback", () => {
    // derivedOppName APPENDS the nickname since migration 170, so the
    // last-resort branch would smuggle it onto the document by the back door.
    const name = proposalProjectName(
      { title: "", title_override: "Exterior", client_name: null, property_street: null },
      ACCOUNT
    );
    expect(name).not.toContain("Exterior");
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
