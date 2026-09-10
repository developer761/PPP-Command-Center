import { describe, it, expect } from "vitest";
import { resolveFinishValue } from "@/lib/salesforce/picklists";
import { normalizeFinishToSf } from "@/lib/customer-form/surface-mapping";

/**
 * Katie is adding Velvet, High-Gloss and the five stain opacities to the
 * restricted Finish*__c picklists (2026-09-10).
 *
 * Finish*__c REJECT a value they do not hold — the write fails outright. So the
 * app cannot hardcode a value before the admin adds it, and must not need a
 * deploy after. It asks the org.
 */
const withoutNew = new Set(["Flat","Matte","Eggshell","Satin","Pearl","Semigloss","Gloss","Low Lustre","Soft Gloss"]);
const withNew = new Set([...withoutNew, "Velvet", "High-Gloss", "Transparent", "Translucent", "Semi-Transparent", "Semi-Solid", "Solid"]);
const resolve = (label: string, allowed: Set<string> | null) =>
  resolveFinishValue(label, normalizeFinishToSf(label), allowed);

describe("a finish is written only if the org accepts it", () => {
  it("BEFORE Katie adds them: not written, so the write cannot fail", () => {
    for (const f of ["Velvet", "High-Gloss", "Semi-Transparent", "Solid"]) {
      expect(resolve(f, withoutNew), f).toBeNull();
    }
  });

  it("AFTER Katie adds them: written, with no deploy", () => {
    expect(resolve("Velvet", withNew)).toBe("Velvet");
    expect(resolve("High-Gloss", withNew)).toBe("High-Gloss");
    expect(resolve("Semi-Transparent", withNew)).toBe("Semi-Transparent");
    expect(resolve("Solid", withNew)).toBe("Solid");
  });

  it("keeps the translation where the org spells it differently", () => {
    // The org stores Semi-Gloss as one word; that mapping still wins.
    expect(resolve("Semi-Gloss", withNew)).toBe("Semigloss");
    expect(resolve("Semi-Gloss", withoutNew)).toBe("Semigloss");
  });

  it("matches case-insensitively — an admin may type 'velvet'", () => {
    expect(resolve("Velvet", new Set([...withoutNew, "velvet"]))).toBe("velvet");
  });

  it("never invents a value the org does not hold", () => {
    expect(resolve("Chartreuse Sparkle", withNew)).toBeNull();
  });

  it("when the org is UNREACHABLE, trusts only the hardcoded mapping", () => {
    // null means "unknown", not "empty". Treating an outage as an empty
    // picklist would silently stop writing every finish on every job.
    expect(resolve("Eggshell", null)).toBe("Eggshell");
    expect(resolve("Semi-Gloss", null)).toBe("Semigloss");
    // ...and still refuses to guess an unmapped one into a restricted field.
    expect(resolve("Velvet", null)).toBeNull();
  });
});
