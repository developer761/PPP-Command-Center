import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R5.3 — "On a job with interior and exterior work the entry form correctly
 * asks twice, but neither answer reaches the order screen."
 *
 * The answers WERE reaching the vendor. R4.3 made the email apply the exterior
 * line to the colours that are exterior, and the job line resolves from the
 * work order even when the order screen's own saved payload is empty. What was
 * missing is that none of it was visible to the person doing the sending — the
 * screen knew only its own payload, so it showed an empty dropdown and an
 * orange "Paint line not set" warning while the email underneath carried both
 * lines.
 *
 * The fix reports what the builder DECIDED rather than adding a source. Which
 * of the three sources should win is a separate question (R5.2) and is held
 * pending Katie, so nothing here changes the priority chain — that would be
 * building a held item by the back door.
 */
const builder = readFileSync(join(process.cwd(), "lib/supplier-order/builder.ts"), "utf8");
const view = readFileSync(join(process.cwd(), "components/order-builder-view.tsx"), "utf8");
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const B = codeOnly(builder);
const V = codeOnly(view);

describe("the draft reports the lines the email will use", () => {
  it("returns the resolved job line", () => {
    expect(B).toMatch(/resolvedMaterialType: materialType,/);
  });

  it("returns the per-colour lines, including the derived exterior ones", () => {
    // Same map the email renders from, so the screen cannot disagree with it.
    expect(B).toMatch(/resolvedMaterialTypeOverrides: Object\.fromEntries\(derivedMaterialTypeOverrides\)/);
  });

  it("returns the exterior line so a mixed job can be explained", () => {
    expect(B).toMatch(/exteriorMaterialType: exteriorLine \|\| null/);
  });

  it("does NOT change where the default comes from — that is held (R5.2)", () => {
    // The priority chain must still be: order builder → submitted payload →
    // Salesforce. Reordering it, or adding a source, is the held item.
    const chain = B.slice(B.indexOf("const materialType ="), B.indexOf("const materialType =") + 400);
    expect(chain).toMatch(/input\.materialType/);
    expect(chain).toMatch(/customerSubmittedPayload\?\.materialType/);
    expect(chain).toMatch(/input\.workOrder\.materialType/);
  });
});

describe("the order screen shows them", () => {
  it("names the line the email will use instead of warning it is unset", () => {
    expect(V).toMatch(/!payload\.mainMaterialType && currentDraft\?\.resolvedMaterialType/);
    // The orange warning survives ONLY when there is genuinely no line.
    expect(V).toMatch(/!payload\.mainMaterialType && !currentDraft\?\.resolvedMaterialType/);
  });

  it("explains the exterior line on a mixed job", () => {
    expect(V).toMatch(/currentDraft\?\.exteriorMaterialType &&/);
  });

  it("names a derived per-colour line rather than calling it the default", () => {
    // "— use default —" was wrong twice: it isn't the default, and it hid that
    // the email had an answer the screen didn't.
    expect(V).toMatch(/resolvedMaterialTypeOverrides\?\.\[key\]/);
    expect(V).toMatch(/\(from the job\)/);
  });
});
