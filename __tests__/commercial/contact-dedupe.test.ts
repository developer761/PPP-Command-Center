import { describe, it, expect } from "vitest";
import { normalizeName } from "@/lib/commercial/accounts/contacts";

/**
 * Brendan 2026-08-26: "I made three contacts when I created the account and
 * only one saved."
 *
 * All three saved. `addContactToAccount` deduped on EMAIL alone, reused the
 * first contact row, and dropped the names typed on the other two — so the
 * account came back showing one person under three roles. That reads as
 * "they didn't save", and it is worse than a duplicate: it puts the owner's
 * name on the billing contact.
 *
 * A shared inbox is the ordinary case. At a small GC the estimator, the owner
 * and the AP clerk all sit behind one info@ address — one mailbox, three
 * people. So identity is email AND name; when the names differ, they are
 * different humans and each gets a record.
 */
describe("contact identity", () => {
  it("is forgiving about case and spacing", () => {
    expect(normalizeName("Bob Smith")).toBe(normalizeName("bob  SMITH"));
    expect(normalizeName("  Kim Lee ")).toBe(normalizeName("Kim Lee"));
  });

  it("does NOT merge two different people behind one shared inbox", () => {
    // The exact shape Brendan hit: three rows, one info@ address.
    expect(normalizeName("Brendan Dwyer")).not.toBe(normalizeName("Stephanie Ruiz"));
    expect(normalizeName("Bob Smith")).not.toBe(normalizeName("Bob Smith Jr"));
  });

  it("treats a missing name as its own value, not a wildcard", () => {
    // If blank matched everything, one nameless legacy row would swallow every
    // future contact sharing that address.
    expect(normalizeName(null)).toBe("");
    expect(normalizeName(null)).not.toBe(normalizeName("Kim Lee"));
  });
});
