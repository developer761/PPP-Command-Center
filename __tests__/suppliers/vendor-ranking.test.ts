import { describe, it, expect } from "vitest";
import { rankVendors, vendorGroupLabel, vendorIsInScope } from "@/lib/supplier-order/vendor-ranking";

/**
 * Katie, 2026-10-02: "NJ based guys see NJ Vendors, NY sees NY vendors, etc.
 * Then they can utilize the Favorites feature from that filtered list."
 *
 * The rule is the PERSON's state, not the job's. Her reason is the part worth
 * keeping: "The guys have relationships with specific stores and will order
 * from a further store because they use that store all the time, they carry
 * specific items, or maybe they're close to where they live."
 */

// PPP's real vendors, in the order the server returns them.
const VENDORS = [
  { accountId: "aboffs", name: "Aboffs", state: "NY" },
  { accountId: "janovic", name: "Janovic", state: "NY" },
  { accountId: "george", name: "Paints by George", state: "NY" },
  { accountId: "ricciardi-bloom", name: "Ricciardi Brothers Bloomfield", state: "NJ" },
  { accountId: "ricciardi-clifton", name: "Ricciardi Brothers Clifton", state: "NJ" },
  { accountId: "stein", name: "Stein Paint", state: "FL" },
  { accountId: "medallions", name: "Medallions Paint World", state: "FL" },
];
const ids = (r: ReturnType<typeof rankVendors>) => r.map((x) => x.vendor.accountId);

describe("a person sees their own state's vendors", () => {
  it("shows an NJ person only the NJ vendors", () => {
    expect(ids(rankVendors({ vendors: VENDORS, userState: "NJ" })))
      .toEqual(["ricciardi-bloom", "ricciardi-clifton"]);
  });

  it("shows an NY person only the NY vendors", () => {
    expect(ids(rankVendors({ vendors: VENDORS, userState: "NY" })))
      .toEqual(["aboffs", "janovic", "george"]);
  });

  it("shows a FL person only the FL vendors", () => {
    expect(ids(rankVendors({ vendors: VENDORS, userState: "FL" })))
      .toEqual(["stein", "medallions"]);
  });

  it("ignores how the state was typed", () => {
    expect(ids(rankVendors({ vendors: VENDORS, userState: " nj " })))
      .toEqual(["ricciardi-bloom", "ricciardi-clifton"]);
  });
});

describe("it never leaves somebody with nothing", () => {
  it("shows EVERY vendor to a person with no state set", () => {
    // Filtering on nothing would hand them an empty picker and no way to
    // understand why. An unset profile is the common case on day one.
    for (const st of [null, undefined, "", "   "]) {
      expect(ids(rankVendors({ vendors: VENDORS, userState: st })), String(st))
        .toEqual(VENDORS.map((v) => v.accountId));
    }
  });

  it("shows a vendor with NO state to everyone", () => {
    // "Unknown" is not a reason to make a vendor unreachable. Every ACTIVE
    // PPP vendor has a state today, so this is the safety net rather than the
    // normal path.
    const withUnknown = [...VENDORS, { accountId: "mystery", name: "Mystery Paint", state: null }];
    expect(ids(rankVendors({ vendors: withUnknown, userState: "NJ" }))).toContain("mystery");
  });

  it("is not fooled by a half-typed state", () => {
    // "N" is not a state. Treat it as unset rather than matching nothing.
    expect(ids(rankVendors({ vendors: VENDORS, userState: "N" })))
      .toEqual(VENDORS.map((v) => v.accountId));
  });
});

describe("favorites come from inside the filtered list", () => {
  it("floats a favorite to the top of the person's own state", () => {
    const out = rankVendors({ vendors: VENDORS, favoriteIds: ["janovic"], userState: "NY" });
    expect(ids(out)).toEqual(["janovic", "aboffs", "george"]);
    expect(out[0].group).toBe("favorite");
  });

  it("does NOT drag an out-of-state favorite back into view", () => {
    // Katie's own sequence — favorites are used "from that filtered list". A
    // starred NY vendor is still out of scope for an NJ person; clearing their
    // state is how they see everything.
    const out = rankVendors({ vendors: VENDORS, favoriteIds: ["aboffs"], userState: "NJ" });
    expect(ids(out)).not.toContain("aboffs");
  });

  it("keeps the server's order among non-favorites", () => {
    const out = rankVendors({ vendors: VENDORS, favoriteIds: ["george"], userState: "NY" });
    expect(ids(out)).toEqual(["george", "aboffs", "janovic"]);
  });
});

describe("the in-scope rule on its own", () => {
  it("matches, falls back, and never matches rubbish", () => {
    expect(vendorIsInScope("NJ", "NJ")).toBe(true);
    expect(vendorIsInScope("NY", "NJ")).toBe(false);
    expect(vendorIsInScope(null, "NJ")).toBe(true);   // unknown vendor state
    expect(vendorIsInScope("NY", null)).toBe(true);   // unset person
    // A vendor state that is not a 2-letter code counts as UNKNOWN, so it
    // shows to everyone rather than to nobody. The admin field is capped at
    // two characters and the API stores /^[A-Z]{2}$/ or null, so this is the
    // safety net rather than a path anyone can reach by typing.
    expect(vendorIsInScope("New York", "NY")).toBe(true);
  });
});

describe("the headings", () => {
  it("names the state the list is filtered to", () => {
    expect(vendorGroupLabel("other", "NJ")).toBe("NJ vendors");
    expect(vendorGroupLabel("favorite")).toBe("Your favorites");
  });

  it("says 'All vendors' when nothing is filtering", () => {
    expect(vendorGroupLabel("other", null)).toBe("All vendors");
  });
});
