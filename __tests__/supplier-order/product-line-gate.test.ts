import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Kate, 2026-10-06: "when 'Use default no override' is selected it acts as if
 * no product line has been selected and the product line required error
 * shows."
 *
 * It did, and the option was not the problem. The EMAIL resolves a line's
 * product as
 *
 *     readProductOverride(materialTypeOverrides, e) ?? materialType
 *
 * — falling back to the JOB's product line (the estimator's pick, then the
 * entry form, then Salesforce's Product_Lines__c). The screen's "Product line
 * required" gate only consulted the per-color overrides. So clearing an
 * override, which is exactly how you ask for the job default, left a line that
 * would have emailed correctly and was refused anyway.
 *
 * A gate that refuses what the email would have sent correctly is the failure
 * mode here, so these pin the two to the same sources.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Comments stripped, so a rule can never be satisfied by prose describing it. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

describe("the screen refuses exactly what the email cannot send", () => {
  it("falls back to the job's product line, like the email does", () => {
    const view = code("components/order-builder-view.tsx");
    const gate = view.slice(view.indexOf("const needProductLine"), view.indexOf("const customNeedProductLine"));
    expect(gate).toBeTruthy();

    // The three sources, in the order the email consults them.
    expect(gate).toMatch(/readProductOverride\(payload\.materialTypeOverrides, e\)/);
    expect(gate).toMatch(/resolvedMaterialTypeOverrides/);
    // The one that was missing.
    expect(gate).toMatch(/jobMaterialType/);
  });

  it("reads the job line from the resolved draft, not a second guess", () => {
    // builder.ts already resolved estimator → entry form → Salesforce and
    // reports the answer as `resolvedMaterialType`. Re-deriving it here is how
    // the screen and the email would come to disagree again.
    const view = code("components/order-builder-view.tsx");
    expect(view).toMatch(/jobMaterialType\s*=\s*\(currentDraft\?\.resolvedMaterialType\s*\?\?\s*""\)/);
  });

  it("still treats a bare 'Other' as unanswered", () => {
    // Katie item 11: "Other" with nothing typed looks answered and prints
    // "[NOT SET]". Widening the fallback must not have let that back through.
    const gate = code("components/order-builder-view.tsx");
    expect(gate).toMatch(/materialTypeForVendor\(resolved\)/);
  });

  it("keeps the email's own fallback intact", () => {
    // The other half of the pair. If this ever stops falling back to the job
    // line, the gate above becomes too permissive instead of too strict.
    const builder = code("lib/supplier-order/builder.ts");
    expect(builder).toMatch(/readProductOverride\(materialTypeOverrides, e\)\s*\?\?\s*materialType/);
  });
});

describe("custom color items are answered individually", () => {
  it("has no job fallback, and is gated on its own", () => {
    // A hand-typed line has no work-order scope to read a default from —
    // builder.ts prints materialTypeForVendor(c.materialType) with no `??
    // materialType` behind it. So these genuinely must be answered, and before
    // today nothing asked: they sailed past the gate and printed "[NOT SET]"
    // to the vendor, which is the line in Kate's screenshot.
    const builder = code("lib/supplier-order/builder.ts");
    const custom = builder.slice(builder.indexOf("for (const c of customColorItems)"));
    expect(custom).toMatch(/materialTypeForVendor\(c\.materialType\)/);
    expect(custom.slice(0, 600)).not.toMatch(/\?\?\s*materialType\b/);

    const view = code("components/order-builder-view.tsx");
    expect(view).toMatch(/customNeedProductLine/);
    expect(view).toMatch(/totalNeedProductLine\s*=\s*needProductLine\.length\s*\+\s*customNeedProductLine\.length/);
    // And the button is gated on the total, not just the buy rows.
    expect(view).toMatch(/if \(totalNeedProductLine > 0\)/);
  });
});
