import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finishOptionsFor, isStainProduct } from "@/lib/customer-form/material-types";

/**
 * Katie item 19, 2026-09-08: "one of the items was rear deck and it defaulted as
 * eggshell, and stain doesn't come in eggshell."
 *
 * Two separate faults produced that one screen:
 *
 *   · the finish list offered every interior sheen whatever the product;
 *   · defaultFinishForSurface fell through a chain of ceiling/trim/floor and
 *     returned "Eggshell" for everything else, a rear deck included.
 *
 * The fix REMOVES impossible options rather than inventing PPP's stain
 * vocabulary. The real list of stain products and their finishes is item 21,
 * coming from Jason; guessing it here would be a worse error than the one being
 * fixed.
 */
const ALL = ["Flat", "Matte", "Eggshell", "Satin", "Semi-Gloss", "Gloss", "High-Gloss"];

describe("stain does not offer interior sheens", () => {
  it("drops flat, matte and eggshell for a stain", () => {
    const out = finishOptionsFor(ALL, "Arborcoat Semi-Transparent Stain");
    expect(out).not.toContain("Eggshell");
    expect(out).not.toContain("Flat");
    expect(out).not.toContain("Matte");
  });

  it("keeps the sheens a stain IS sold in", () => {
    const out = finishOptionsFor(ALL, "Arborcoat Stain");
    expect(out).toContain("Satin");
    expect(out).toContain("Semi-Gloss");
  });

  it("leaves paint untouched", () => {
    // Ultra Spec now declares its own finishes (Jason 2026-09-09), so it is no
    // longer the generic list — interior is the no-scope default.
    expect(finishOptionsFor(ALL, "Ultra Spec")).toEqual(["Flat", "Eggshell", "Satin", "Semi-Gloss"]);
    expect(finishOptionsFor(ALL, "Ultra Spec", "exterior")).toEqual(["Low Lustre", "Satin", "Soft Gloss"]);
    expect(finishOptionsFor(ALL, null)).toEqual(ALL);
    expect(finishOptionsFor(ALL, "")).toEqual(ALL);
  });

  it("recognises the word, not a substring of another", () => {
    expect(isStainProduct("Deck Stain")).toBe(true);
    expect(isStainProduct("Solid Staining")).toBe(true);
    // "Stainless" and "Stain-Blocking Primer" are not stains.
    expect(isStainProduct("Stainless")).toBe(false);
  });
});

describe("a rear deck no longer defaults to eggshell", () => {
  const view = readFileSync(join(process.cwd(), "components/customer-form-view.tsx"), "utf8");

  it("exterior woodwork defaults to nothing, so a person chooses", () => {
    // An empty box costs a tap. An order a supplier cannot fill costs a job.
    expect(view).toMatch(/s\.includes\("deck"\)/);
    expect(view).toMatch(/s\.includes\("railing"\)/);
  });

  it("the product actually REACHES the finish dropdown", () => {
    // This test used to assert that the call `finishOptionsFor(FINISH_OPTIONS,
    // materialType)` appeared in the file. It did appear — and `materialType`
    // was `undefined` every single time, because <SurfaceRow> was rendered
    // without the prop. LineItemSection accepted materialType and dropped it.
    // So the filtering shipped, this test stayed green, and the dropdown went
    // on offering eggshell for a stain. Asserting a call exists says nothing
    // about what is passed to it.
    //
    // Check the SEAM instead: read the <SurfaceRow ...> element and require it
    // to be handed both props. Still structural — a unit suite with no DOM
    // cannot render this — but it fails on the actual defect rather than on a
    // rename.
    const open = view.indexOf("<SurfaceRow");
    expect(open, "<SurfaceRow> not found").toBeGreaterThan(-1);
    const close = view.indexOf("/>", open);
    expect(close, "unterminated <SurfaceRow>").toBeGreaterThan(open);
    const element = view.slice(open, close);

    expect(element, "SurfaceRow must be given materialType").toMatch(/\bmaterialType=\{/);
    expect(element, "SurfaceRow must be given scope").toMatch(/\bscope=\{/);
    // ...and only one SurfaceRow exists, so checking the first is checking all.
    expect(view.split("<SurfaceRow").length - 1).toBe(1);
  });

  it("an exterior line uses the EXTERIOR product line", () => {
    // A mixed job has two answers; filtering the deck's finishes by the
    // interior line would be the same class of error.
    expect(view).toMatch(/materialTypeExterior \|\| materialType/);
  });
});
