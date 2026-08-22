import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * ⌘K finds PEOPLE, and answers the question in the row.
 *
 * Karan 2026-08-22: *"Salesforce is too clicky to get to certain information,
 * we need to be better."* Stephanie, twice: *"how do I access the contact
 * information from the opportunity?"* and *"Can we add contact information in
 * the Account headers and the Opportunity headers."*
 *
 * "What is this person's number" was the most expensive search on the
 * platform: you knew the name, and had to remember which account held them,
 * open it, and find the tab. The palette already searched five record types —
 * people were the one kind of thing you look up by name and it could not find.
 */

const ROUTE = readFileSync("app/api/commercial/palette-search/route.ts", "utf8");
const CLIENT = readFileSync("components/commercial/command-palette.tsx", "utf8");

describe("universal search covers people", () => {
  it("searches name, email AND phone", () => {
    // All three are things you arrive holding: a name from a conversation, an
    // address off an email, a number off a missed call.
    expect(ROUTE).toContain("full_name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern}");
  });

  it("puts the phone and email IN the result row", () => {
    // The hint is the answer for most of these searches — making someone click
    // through to see a number would keep the whole cost.
    expect(ROUTE).toContain("[c.title, c.phone, c.email, company].filter(Boolean).join(\" · \")");
  });

  it("lands on the account that holds them, not a dead end", () => {
    // A contact has no page of its own.
    expect(ROUTE).toContain("?tab=people");
  });

  it("tolerates the embedded account being an object OR an array", () => {
    // supabase-js types this to-one relation as an array; the live database
    // returns an object. Reading it one way silently drops the company name —
    // no error, no failing type, just an emptier row (verified 2026-08-22).
    expect(ROUTE).toContain("Array.isArray(acct) ? acct[0]?.company_name : acct?.company_name");
  });

  it("the client knows the kind, or results would be dropped on the floor", () => {
    // KIND_ORDER drives both the filter chips and the grouping: a kind missing
    // from it returns from the API and never renders.
    expect(CLIENT).toContain('"contact"');
    expect(CLIENT).toContain('contact: "People"');
    const order = /KIND_ORDER: PaletteKind\[\] = \[([^\]]*)\]/.exec(CLIENT);
    expect(order?.[1], "contact missing from KIND_ORDER").toContain("contact");
  });
});
