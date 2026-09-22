import { describe, it, expect } from "vitest";
import { trackForWorkspace, isAccountManagement, asTrack } from "@/lib/messaging/track";

/**
 * Migration 196 built the nurture track and said which workspaces carry it:
 *
 *   "AM - NY, AM - NJ and AM - SoFlo are the account-management surfaces and
 *    carry nurture, while the Leads and Meta workspaces carry new leads."
 *
 * Then nothing set it. Every AM conversation ran the NEW LEAD prompt, which
 * asks for the project details, the address, the contact details and the
 * availability — of somebody who has already had an estimator at their house
 * and holds the quote in writing. Migration 196's own words: "the single most
 * obvious way to prove nobody is reading."
 */
describe("which track a workspace carries", () => {
  it("puts the real account-management workspaces on nurture", () => {
    for (const name of ["AM - NY", "AM - NJ", "AM - SoFlo", "AM - CA LA", "AM - CT", "AM - Dallas TX"]) {
      expect(trackForWorkspace(name), name).toBe("nurture");
    }
  });

  it("puts every lead and channel workspace on new_lead", () => {
    for (const name of [
      "NY LI Nassau Leads", "NY LI Suffolk Leads", "NY NYC Leads", "NJ Leads",
      "FL Broward Leads", "NY LI Meta", "NYC Meta", "SoFlo Meta", "Google LSA", "Thumbtack",
    ]) {
      expect(trackForWorkspace(name), name).toBe("new_lead");
    }
  });

  it("does not mistake a workspace that merely contains AM", () => {
    // "Miami" and "Birmingham" both contain the letters. The prefix is the
    // convention, not the substring.
    for (const name of ["FL Miami Leads", "AM Birmingham", "Amsterdam Leads"]) {
      expect(isAccountManagement(name), name).toBe(false);
    }
  });

  it("tolerates the spacing actually used in the names", () => {
    for (const name of ["AM - NY", "AM- NY", "AM -NY", "AM-NY", "am - ny"]) {
      expect(isAccountManagement(name), name).toBe(true);
    }
  });

  it("treats an unnamed workspace as a new lead", () => {
    // The safer default: asking a new lead for their address is correct, and
    // asking a nurture customer is the mistake worth avoiding. Anything we
    // cannot identify is far more likely to be a lead workspace.
    expect(trackForWorkspace(null)).toBe("new_lead");
    expect(trackForWorkspace("")).toBe("new_lead");
  });
});

describe("reading a stored track", () => {
  it("reads the two real values", () => {
    expect(asTrack("nurture")).toBe("nurture");
    expect(asTrack("new_lead")).toBe("new_lead");
  });

  it("falls back to new_lead for anything else", () => {
    // Every conversation created before this existed has the column default,
    // and a typo must not silently become nurture.
    expect(asTrack(null)).toBe("new_lead");
    expect(asTrack("")).toBe("new_lead");
    expect(asTrack("NURTURE")).toBe("new_lead");
    expect(asTrack("something")).toBe("new_lead");
  });
});
