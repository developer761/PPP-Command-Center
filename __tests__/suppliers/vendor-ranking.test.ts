import { describe, it, expect } from "vitest";
import { rankVendors, vendorGroupLabel } from "@/lib/supplier-order/vendor-ranking";

/**
 * Katie, 2026-10-01, on the vendor list: favorites, then the vendors near the
 * job. The thing these tests are really guarding is the decision NOT to
 * filter: three of PPP's fourteen vendors have no state at all, and a vendor
 * that vanishes from the picker is somebody unable to order.
 */

// PPP's real list, in the order the server already returns it.
const VENDORS = [
  { accountId: "aboffs", name: "Aboffs", state: "NY", sortOrder: 10 },
  { accountId: "janovic", name: "Janovic", state: "NY", sortOrder: 20 },
  { accountId: "ricciardi", name: "Ricciardi Brothers Paint", state: "NJ", sortOrder: 30 },
  { accountId: "stein", name: "Stein Paint", state: "FL", sortOrder: 40 },
  { accountId: "medallions", name: "Medallions Paint World", state: "FL", sortOrder: 50 },
  { accountId: "sunbelt", name: "Sunbelt Rentals", state: null, sortOrder: 999 },
];
const ids = (r: ReturnType<typeof rankVendors>) => r.map((x) => x.vendor.accountId);

describe("nothing is ever removed", () => {
  it("returns every vendor, whatever the job state", () => {
    for (const jobState of ["FL", "NY", "ZZ", "", null, undefined]) {
      const out = rankVendors({ vendors: VENDORS, jobState });
      expect(out, String(jobState)).toHaveLength(VENDORS.length);
    }
  });

  it("keeps a vendor with NO state in the list", () => {
    // Sunbelt and Eco Wall Coatings have addresses with no state in them, and
    // an admin adding a vendor types a free-text address. They sort last; they
    // do not disappear.
    const out = rankVendors({ vendors: VENDORS, jobState: "FL" });
    expect(ids(out)).toContain("sunbelt");
    expect(out.find((x) => x.vendor.accountId === "sunbelt")?.group).toBe("other");
  });
});

describe("what comes first", () => {
  it("puts the job's state above the rest", () => {
    const out = rankVendors({ vendors: VENDORS, jobState: "FL" });
    expect(ids(out).slice(0, 2)).toEqual(["stein", "medallions"]);
  });

  it("puts favorites above even the job's state", () => {
    // A starred vendor is an explicit human answer; geography is an inference.
    const out = rankVendors({ vendors: VENDORS, favoriteIds: ["aboffs"], jobState: "FL" });
    expect(ids(out)[0]).toBe("aboffs");
    expect(ids(out).slice(1, 3)).toEqual(["stein", "medallions"]);
  });

  it("does not list a favorite twice when it is also in state", () => {
    const out = rankVendors({ vendors: VENDORS, favoriteIds: ["stein"], jobState: "FL" });
    expect(ids(out).filter((i) => i === "stein")).toHaveLength(1);
    expect(out.find((x) => x.vendor.accountId === "stein")?.group).toBe("favorite");
  });
});

describe("with nothing to go on it changes nothing", () => {
  it("is a no-op with no job state and no favorites", () => {
    // The safety net: the feature can only reorder, and with no signal it does
    // not even do that. Today's list, exactly.
    expect(ids(rankVendors({ vendors: VENDORS }))).toEqual(VENDORS.map((v) => v.accountId));
  });

  it("is a no-op when the job state matches nobody", () => {
    expect(ids(rankVendors({ vendors: VENDORS, jobState: "TX" }))).toEqual(VENDORS.map((v) => v.accountId));
  });

  it("preserves the server's order inside each group", () => {
    // The server already sorted active → sort_order → alpha. Re-deriving it
    // here is how the two would disagree.
    const out = rankVendors({ vendors: VENDORS, jobState: "NY" });
    expect(ids(out)).toEqual(["aboffs", "janovic", "ricciardi", "stein", "medallions", "sunbelt"]);
  });
});

describe("matching is forgiving about how a state is typed", () => {
  it("ignores case and surrounding space", () => {
    const v = [{ accountId: "a", name: "A", state: " fl " }];
    expect(rankVendors({ vendors: v, jobState: "FL" })[0].group).toBe("in-state");
    expect(rankVendors({ vendors: v, jobState: "fl" })[0].group).toBe("in-state");
  });

  it("does not match a full state name against a code", () => {
    // "Florida" is not "FL" — a loose match here would group the wrong branch.
    const v = [{ accountId: "a", name: "A", state: "Florida" }];
    expect(rankVendors({ vendors: v, jobState: "FL" })[0].group).toBe("other");
  });

  it("never treats two blanks as a match", () => {
    const v = [{ accountId: "a", name: "A", state: null }];
    expect(rankVendors({ vendors: v, jobState: null })[0].group).toBe("other");
    expect(rankVendors({ vendors: v, jobState: "" })[0].group).toBe("other");
  });
});

describe("the headings", () => {
  it("names the state when there is one", () => {
    expect(vendorGroupLabel("in-state", "FL")).toBe("In FL — where the job is");
    expect(vendorGroupLabel("favorite")).toBe("Your favorites");
    expect(vendorGroupLabel("other")).toBe("All other vendors");
  });

  it("falls back when the job state is unknown", () => {
    expect(vendorGroupLabel("in-state", null)).toBe("Near the job");
  });
});
