import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R4.3, second half — Kate tied the split picker to the round-2 ask that the
 * product line "default to the AM's Internal Entry pick".
 *
 * With TWO picks, carrying only the interior one to the order would put
 * exterior colours on an interior product — the exact failure splitting the
 * picker was meant to prevent. So the exterior pick is applied to the colours
 * that are actually exterior, as per-colour overrides: that's the shape the
 * rest of the order already speaks (the builder renders them per line and the
 * vendor email groups by line, R4.32), so a mixed job arrives as two clearly
 * separated groups.
 */
const src = readFileSync(join(process.cwd(), "lib/supplier-order/builder.ts"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the exterior paint line reaches the order", () => {
  it("reads the AM's exterior pick from the submitted payload", () => {
    expect(code).toMatch(/customerSubmittedPayload\?\.materialTypeExterior/);
  });

  it("tags each colour with the scope it is painted on", () => {
    expect(code).toContain("scopesByColorKey");
    // Scope comes from the LINE ITEM's product name, not the work order's
    // type — a mixed WO has no single type to read.
    expect(code).toMatch(/lineItemProductNames:\s*\[woli\.productName\]/);
  });

  it("applies it only to colours used EXCLUSIVELY on exterior work", () => {
    // A colour on both scopes is ambiguous; guessing there is worse than
    // leaving the job default for the estimator to correct.
    expect(code).toMatch(/scopes\.size === 1 && scopes\.has\("exterior"\)/);
  });

  it("never overrides an explicit choice by the estimator", () => {
    const block = code.slice(code.indexOf("derivedMaterialTypeOverrides"));
    expect(block).toMatch(/if \(derivedMaterialTypeOverrides\.has\(key\)\) continue;/);
    // Seeded FROM the estimator's overrides, so theirs are present to begin with.
    expect(code).toMatch(/derivedMaterialTypeOverrides = new Map<string, string>\(\s*input\.materialTypeOverrides/);
  });

  it("feeds the same map to the vendor email", () => {
    // Two maps would let the screen and the email disagree about a colour's line.
    expect(code).toMatch(/materialTypeOverridesMap =\s*derivedMaterialTypeOverrides\.size > 0 \? derivedMaterialTypeOverrides : undefined/);
  });
});
