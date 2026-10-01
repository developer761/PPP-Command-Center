import { describe, it, expect } from "vitest";
import { finishOptionsFor, isExteriorProduct, ALL_FINISH_VALUES } from "@/lib/customer-form/material-types";
import { normalizeFinishToSf, denormalizeFinishFromSf } from "@/lib/customer-form/surface-mapping";

/**
 * Kate 2026-09-09: "the team need Low Lustre and Soft Gloss as available
 * finishes for exterior line items."
 *
 * Both were already ACTIVE on Salesforce's restricted Finish*__c picklists —
 * verified against the live describe — so this is the app catching up, not a
 * Salesforce change. The finish fields are `restricted: true`, which means an
 * option the picker offers but Salesforce does not accept is not a cosmetic
 * mismatch: the write is REJECTED and the colors silently fail to land.
 */
/** The generic sheens as the picker offers them. Gloss and High-Gloss left on
 *  2026-10-01 (Kate) — see RETIRED_FINISHES. */
const BASE = ["Flat", "Matte", "Eggshell", "Satin", "Semi-Gloss"];

/** What callers used to pass. Kept so the tests below can prove the withdrawn
 *  sheens are stripped even when a caller still hands them in. */
const BASE_BEFORE_2026_10_01 = [...BASE, "Gloss", "High-Gloss"];

describe("exterior sheens", () => {
  it("offers Low Lustre and Soft Gloss on an exterior product", () => {
    const out = finishOptionsFor(BASE, "Ultra Spec Exterior Soft Gloss");
    expect(out).toContain("Low Lustre");
    expect(out).toContain("Soft Gloss");
  });

  it("offers exactly what Jason said each exterior product is sold in", () => {
    // 2026-09-09: he narrowed these to ONE sheen each. That is the point of
    // the exercise — before this every product offered all seven.
    expect(finishOptionsFor(BASE, "Mooreglo")).toEqual(["Soft Gloss"]);
    expect(finishOptionsFor(BASE, "Mooregard")).toEqual(["Low Lustre"]);
    expect(finishOptionsFor(BASE, "Moore Life")).toEqual(["Flat"]);
    expect(finishOptionsFor(BASE, "Regal Select High Build")).toEqual(["Flat", "Low Lustre", "Soft Gloss"]);
    for (const line of ["Mooreglo", "Mooregard", "Moore Life", "Regal Select High Build"]) {
      expect(isExteriorProduct(line), line).toBe(true);
    }
  });

  it("does NOT put them on interior lines — BM does not sell them there", () => {
    for (const line of ["Regal Select", "Aura Bath & Spa Matte", "Ben"]) {
      const out = finishOptionsFor(BASE, line);
      expect(out, line).not.toContain("Low Lustre");
      expect(out, line).not.toContain("Soft Gloss");
    }
    expect(finishOptionsFor(BASE, null)).toEqual(BASE);
  });

  it("drops Gloss from the GENERIC list but not from products that sell it", () => {
    // Katie, 2026-10-01, narrowing Kate's first instruction: "Leave Gloss and
    // High-Gloss as options to select but don't add to the recommended
    // finishes table. You can remove from Interior options to select."
    //
    // So the removal is about the generic fallback, not about products. An
    // ordinary interior wall paint no longer offers gloss…
    expect(finishOptionsFor(BASE, null, "interior")).not.toContain("Gloss");
    expect(finishOptionsFor(BASE, null, "interior")).not.toContain("High-Gloss");
    expect(finishOptionsFor(BASE, "Regal Select", "interior")).not.toContain("Gloss");

    // …while a product that is actually sold in it keeps it. Emerald Urethane
    // is Katie's OWN example in the same message ("works inside and outside …
    // satin, semi-gloss and gloss … their main trim, door and window
    // product"), so stripping it here would have deleted the sheen from the
    // one product she named while answering the question.
    expect(finishOptionsFor(BASE, "SW Emerald Urethane Trim/Cabinets", "interior")).toContain("Gloss");
    expect(finishOptionsFor(BASE, "SW Duration", "exterior")).toContain("Gloss");
    expect(finishOptionsFor(BASE, "SW Emerald", "exterior")).toContain("Gloss");

    // Semi-Gloss and Soft Gloss are NOT Gloss — different finishes, both stay.
    expect(finishOptionsFor(BASE, "Regal Select", "interior")).toContain("Semi-Gloss");
    expect(finishOptionsFor(BASE, "Mooreglo", "exterior")).toContain("Soft Gloss");
  });

  it("sells Kitchen & Bath in Satin, which is what the table recommends", () => {
    // Was "Pearl" — a guess, because the product was missing from Jason's
    // sheet. Katie checked Benjamin Moore's page and sent the can: SATIN.
    // The Satin row of the finishes table names this product by name, so a
    // mismatch here is the table recommending something the picker contradicts.
    expect(finishOptionsFor(BASE, "Regal Select Kitchen & Bath", "interior")).toEqual(["Satin"]);
  });

  it("still ACCEPTS a withdrawn sheen a saved form already holds", () => {
    // The property that matters: withdrawing a sheen from the picker must not
    // turn a form sent last week into a 400 when the customer comes back to
    // edit it. The submit route validates against ALL_FINISH_VALUES, so this
    // is the check standing between Kate's request and a broken edit link.
    //
    // ⚠ Deliberately NOT a tight mutation guard, and it should not be read as
    // one. Two independent things put these values in the set today — the
    // RETIRED_FINISHES spread, and Jason's per-product lists, which still name
    // Gloss on SW Duration exterior and both on SW Super Paint exterior.
    // Deleting either one alone leaves this green (verified by mutation on
    // 2026-10-01). That redundancy is the point: the spread is what keeps
    // acceptance working on the day somebody tidies the now-unofferable sheens
    // out of the product data.
    for (const retired of ["Gloss", "High-Gloss"]) {
      expect(ALL_FINISH_VALUES.has(retired), retired).toBe(true);
    }
  });

  it("still strips the interior-only sheens from an exterior STAIN", () => {
    // Katie item 19 — a rear deck ordered in eggshell. That rule has to keep
    // working now that exterior products append sheens rather than replace.
    const out = finishOptionsFor(BASE, "Arborcoat Semi-Transparent Stain");
    for (const gone of ["Flat", "Matte", "Eggshell"]) expect(out).not.toContain(gone);
  });

  it("survives the round trip to Salesforce and back", () => {
    for (const f of ["Low Lustre", "Soft Gloss"]) {
      // The exact strings Salesforce's picklist holds.
      expect(normalizeFinishToSf(f)).toBe(f);
      expect(denormalizeFinishFromSf(f)).toBe(f);
    }
  });

  it("every finish an exterior job can pick actually reaches Salesforce", () => {
    // The seam that matters: an option the picker shows but normalizeFinishToSf
    // maps to null is written as an EMPTY finish — the color lands, the sheen
    // vanishes, and nobody is told. "High-Gloss" is the known, deliberate
    // exception (no SF picklist value exists for it).
    // Mooreglo is Soft Gloss only now, so nothing is lost there.
    expect(finishOptionsFor(BASE, "Mooreglo").filter((f) => normalizeFinishToSf(f) === null)).toEqual([]);

    // SW Super Paint INTERIOR still loses one: "Velvet" has no value on
    // Salesforce's restricted picklist. Pinned so the day Katie adds it, this
    // test says so.
    expect(
      finishOptionsFor(BASE, "SW Super Paint", "interior").filter((f) => normalizeFinishToSf(f) === null)
    ).toEqual(["Velvet"]);

    // EXTERIOR loses "High-Gloss" the same way, and this is DELIBERATELY still
    // open. Withdrawing the sheen from every picker closed it for a few hours
    // on 2026-10-01; Katie then asked for Gloss and High-Gloss to stay
    // selectable on the products that sell them, which necessarily reopens it.
    //
    // The consequence is worth stating plainly: a customer who picks
    // High-Gloss on SW Super Paint exterior gets their COLOR saved and their
    // SHEEN dropped, because no such value exists on Salesforce's restricted
    // Finish__c picklist. The fix is in Salesforce, not here — flagged for
    // Katie. `npm run check:sf-picklists` names it on every run.
    expect(
      finishOptionsFor(BASE, "SW Super Paint", "exterior").filter((f) => normalizeFinishToSf(f) === null)
    ).toEqual(["High-Gloss"]);
  });
});
