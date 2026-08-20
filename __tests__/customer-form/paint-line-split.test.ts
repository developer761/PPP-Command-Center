import { describe, it, expect } from "vitest";
import { paintLineListsFor, salesforceLineFor } from "@/lib/customer-form/material-types";

/**
 * R4.3 — "Benjamin Moore uses different product lines for interior and
 * exterior. On a job with both, one line can't cover it."
 */
const interiorJob = { workTypeName: "Interior Painting", lineItemProductNames: ["Interior Painting: Kitchen"] };
const exteriorJob = { workTypeName: "Exterior Painting", lineItemProductNames: ["Exterior Painting: Siding"] };
const mixedJob = {
  workTypeName: null,
  lineItemProductNames: ["Interior Painting: Kitchen", "Exterior Painting: Siding"],
};

const flat = (g: Array<{ options: string[] }> | null) => (g ?? []).flatMap((x) => x.options);

describe("paintLineListsFor", () => {
  it("shows only the interior list on an interior-only job", () => {
    const l = paintLineListsFor(interiorJob);
    expect(l.exterior).toBeNull();
    expect(l.isSplit).toBe(false);
    expect(flat(l.interior)).toContain("Regal Select");
    expect(flat(l.interior)).toContain("Ben");
    // Exterior-only lines must not appear.
    expect(flat(l.interior)).not.toContain("Mooreglo");
    expect(flat(l.interior)).not.toContain("Moore Life");
  });

  it("shows only the exterior list on an exterior-only job", () => {
    const l = paintLineListsFor(exteriorJob);
    expect(l.interior).toBeNull();
    expect(l.isSplit).toBe(false);
    expect(flat(l.exterior)).toContain("Mooreglo");
    expect(flat(l.exterior)).toContain("Mooregard");
    // Interior-only lines must not appear.
    expect(flat(l.exterior)).not.toContain("Regal Select");
    expect(flat(l.exterior)).not.toContain("Ben");
  });

  it("shows BOTH lists on a job with both — the case one line can't cover", () => {
    const l = paintLineListsFor(mixedJob);
    expect(l.isSplit).toBe(true);
    expect(flat(l.interior)).toContain("Regal Select");
    expect(flat(l.exterior)).toContain("Mooreglo");
    expect(flat(l.interior)).not.toContain("Mooreglo");
    expect(flat(l.exterior)).not.toContain("Regal Select");
  });

  it("puts dual-scope lines on both lists", () => {
    // Ultra Spec / Aura / the SW range ship in interior and exterior variants,
    // and Salesforce carries the scope separately — so it's ours to derive.
    const l = paintLineListsFor(mixedJob);
    for (const line of ["Ultra Spec", "Aura", "SW Emerald", "Other"]) {
      expect(flat(l.interior), `${line} missing from interior`).toContain(line);
      expect(flat(l.exterior), `${line} missing from exterior`).toContain(line);
    }
  });

  it("shows both rather than guessing when the job gives no signal", () => {
    const l = paintLineListsFor({ workTypeName: null, lineItemProductNames: [] });
    expect(l.interior).not.toBeNull();
    expect(l.exterior).not.toBeNull();
  });
});

describe("salesforceLineFor", () => {
  it("passes a single choice straight through", () => {
    expect(salesforceLineFor("Regal Select", null)).toEqual({ chosen: "Regal Select", dropped: null });
    expect(salesforceLineFor(null, "Mooreglo")).toEqual({ chosen: "Mooreglo", dropped: null });
    expect(salesforceLineFor("", "  ")).toEqual({ chosen: null, dropped: null });
  });

  it("reports what Salesforce cannot hold rather than dropping it silently", () => {
    // MaterialType__c is ONE restricted picklist per work order, so a job with
    // both lines can't be represented. Interior wins (the bulk of PPP's work)
    // and the caller surfaces what didn't fit.
    expect(salesforceLineFor("Regal Select", "Mooreglo")).toEqual({
      chosen: "Regal Select",
      dropped: "Mooreglo",
    });
  });
});

/**
 * Kate: "both lines need to be available in the Order Materials / line-item
 * picker." That picker is driven by filterMaterialTypesForWorkOrder (via the
 * draft's allowedMaterialTypeValues), which returns the UNION on a mixed job —
 * correct there, because the order screen expresses a mix through per-colour
 * overrides rather than two defaults, and the vendor email now groups the lines
 * (R4.32). Asserted so the two surfaces can't drift into disagreeing about
 * which lines exist on a job.
 */
import { filterMaterialTypesForWorkOrder } from "@/lib/customer-form/material-types";

describe("the order picker offers whatever the entry form could pick", () => {
  const cases = [
    ["interior-only", interiorJob],
    ["exterior-only", exteriorJob],
    ["mixed", mixedJob],
  ] as const;

  it.each(cases)("%s", (_name, job) => {
    const orderOptions = new Set(
      filterMaterialTypesForWorkOrder(job).flatMap((g) => g.options)
    );
    const lists = paintLineListsFor(job);
    const entryOptions = new Set([...flat(lists.interior), ...flat(lists.exterior)]);
    for (const v of entryOptions) {
      expect(orderOptions, `"${v}" pickable on entry but not on the order`).toContain(v);
    }
  });
});
