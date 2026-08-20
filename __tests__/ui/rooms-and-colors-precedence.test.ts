import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which source wins for a surface in Rooms & Colors (R4.9 / R4.10).
 *
 * The obvious fix — "the retained payload is the truth, always" — fixes Kate's
 * two symptoms and silently breaks something that works today: a rep correcting
 * a colour directly in Salesforce AFTER the customer submitted would stop
 * showing, with no error and no clue why. That's a worse bug than the one being
 * fixed, on a more common path.
 *
 * So the payload only wins where Salesforce is genuinely incapable of holding
 * the answer, and this pins that rule in place.
 */
const src = readFileSync(join(process.cwd(), "components/materials-view.tsx"), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const buildSlot = code.slice(code.indexOf("const salesforceCanHold"), code.indexOf("const slots: Slot[]"));

describe("Rooms & Colors source precedence", () => {
  it("lets Salesforce win where Salesforce is lossless", () => {
    // All four standard surfaces have their own SF field, and a LONE orphan
    // owns the shared ColorOther__c outright — a rep's edit must show.
    expect(buildSlot).toMatch(/if \(STANDARD_SURFACES\.includes\(surface\)\) return true;/);
    expect(buildSlot).toMatch(/orphanSurfaces\.length <= 1/);
    expect(buildSlot).toMatch(/if \(salesforceCanHold\(surface\) && sfColor\)/);
  });

  it("always honours a skip, on any surface", () => {
    // Salesforce has no way to record "don't paint this", so a blank field is
    // indistinguishable from "nobody picked yet". This is what put Super White
    // on the Kitchen cabinets the customer opted out of (WO 00308360).
    const skipLine = buildSlot.indexOf("own?.skipped");
    const sfWinsLine = buildSlot.indexOf("salesforceCanHold(surface) && sfColor");
    expect(skipLine).toBeGreaterThan(-1);
    // The skip check must come FIRST, or the shared slot's colour wins over it.
    expect(skipLine).toBeLessThan(sfWinsLine);
  });

  it("falls back to the payload when Salesforce could not hold the answer", () => {
    // 2+ orphans: ColorOther__c is deliberately blank and both colours went to
    // Color Notes (WO 00306643's Bathroom).
    const payloadBranch = buildSlot.indexOf("if (own) {");
    expect(payloadBranch).toBeGreaterThan(buildSlot.indexOf("salesforceCanHold(surface) && sfColor"));
    // …and Color Notes is the last resort, for submissions predating retention.
    expect(buildSlot.indexOf("notesBySurface.get(key)")).toBeGreaterThan(payloadBranch);
  });
});
