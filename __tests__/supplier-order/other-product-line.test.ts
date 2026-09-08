import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isOtherValue,
  otherValueText,
  makeOtherValue,
  materialTypeForVendor,
  isValidMaterialTypeValue,
  OTHER_PREFIX,
} from "@/lib/customer-form/material-types";

/**
 * Katie item 11, 2026-09-08: "Default paint line — Other should always let me
 * manually put stuff in, it should never default as Other."
 *
 * Two halves. Nothing auto-selected Other (verified — no fallback exists), so
 * the real defect was the other half: picking it stored the literal word, and
 * THAT is what reached the supplier. A paint counter cannot fill an order for
 * "Other".
 */
describe("Other captures the actual product", () => {
  it("round-trips the typed product", () => {
    const v = makeOtherValue("Behr Premium Plus");
    expect(isOtherValue(v)).toBe(true);
    expect(otherValueText(v)).toBe("Behr Premium Plus");
  });

  it("a bare Other is recognised but has no text yet", () => {
    expect(isOtherValue("Other")).toBe(true);
    expect(otherValueText("Other")).toBe("");
  });

  it("a real paint line is untouched", () => {
    expect(isOtherValue("Ultra Spec")).toBe(false);
    expect(materialTypeForVendor("Ultra Spec")).toBe("Ultra Spec");
  });

  it("the VENDOR sees the product, never the prefix", () => {
    expect(materialTypeForVendor(makeOtherValue("Behr Premium Plus"))).toBe("Behr Premium Plus");
    expect(materialTypeForVendor(makeOtherValue("Behr"))).not.toContain(OTHER_PREFIX);
  });

  it("a bare Other prints NOTHING rather than the word", () => {
    // Empty means the line groups under [NOT SET] — honest — instead of telling
    // a supplier the product line is "Other".
    expect(materialTypeForVendor("Other")).toBe("");
  });

  it("the submit guard accepts a deliberate free-text value", () => {
    // It rejects anything not in the known set, so without this a typed
    // product is refused as a tampered payload.
    expect(isValidMaterialTypeValue(makeOtherValue("Behr Premium Plus"))).toBe(true);
    expect(isValidMaterialTypeValue("Ultra Spec")).toBe(true);
  });

  it("...but still rejects a bare hand-typed product and an empty Other", () => {
    expect(isValidMaterialTypeValue("Behr Premium Plus")).toBe(false);
    expect(isValidMaterialTypeValue(`${OTHER_PREFIX}   `)).toBe(false);
  });

  it("all three save routes use the same guard", () => {
    // draft / build / send each validated separately; one missing the new rule
    // would refuse an order the other two accepted.
    for (const r of ["draft", "build", "send"]) {
      const src = readFileSync(join(process.cwd(), `app/api/admin/supplier-order/${r}/route.ts`), "utf8");
      expect(src, r).toMatch(/isValidMaterialTypeValue/);
      expect(src, r).not.toMatch(/VALID_MATERIAL_TYPE_VALUES\.has/);
    }
  });

  it("the picker offers the free-text box", () => {
    const src = readFileSync(join(process.cwd(), "components/material-type-picker.tsx"), "utf8");
    expect(src).toMatch(/isOtherValue\(value\) &&/);
    expect(src).toMatch(/makeOtherValue\(ev\.target\.value\)/);
  });

  it("the top-of-form default selector is gone (item 14)", () => {
    const src = readFileSync(join(process.cwd(), "components/order-builder-view.tsx"), "utf8");
    const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code).not.toMatch(/Default paint product line/);
    // ...but the per-line picker stays: that is where the product lives now.
    expect(code).toMatch(/<MaterialTypePicker/);
  });
});
