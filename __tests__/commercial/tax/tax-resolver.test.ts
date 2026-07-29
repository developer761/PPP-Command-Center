import { describe, it, expect } from "vitest";
import { resolveTaxForZip, thouToPct, normalizeZip, type TaxJurisdictionLite } from "@/lib/commercial/tax/constants";

const j = (name: string, bps: number, prefixes: string[], active = true): TaxJurisdictionLite => ({
  id: name,
  name,
  combined_rate_thou: bps,
  zip_prefixes: prefixes,
  verified: true,
  active,
});

describe("normalizeZip", () => {
  it("takes the 5-digit base", () => {
    expect(normalizeZip("11201-1234")).toBe("11201");
    expect(normalizeZip("11201")).toBe("11201");
  });
  it("null for too-short / empty", () => {
    expect(normalizeZip("112")).toBeNull();
    expect(normalizeZip(null)).toBeNull();
  });
});

describe("thouToPct", () => {
  it("8625 → 8.625", () => expect(thouToPct(8625)).toBe(8.625));
  it("8875 → 8.875", () => expect(thouToPct(8875)).toBe(8.875));
});

describe("resolveTaxForZip", () => {
  const jurs = [
    j("NYC", 8875, ["100", "112", "114"]),
    j("Nassau", 8625, ["115", "116"]),
    j("Suffolk", 8625, ["117", "119"]),
  ];
  it("matches a Brooklyn ZIP to NYC", () => {
    expect(resolveTaxForZip("11201", jurs)?.jurisdiction.name).toBe("NYC");
    expect(resolveTaxForZip("11201", jurs)?.rateThou).toBe(8875);
  });
  it("matches a Nassau + Suffolk ZIP", () => {
    expect(resolveTaxForZip("11530", jurs)?.jurisdiction.name).toBe("Nassau");
    expect(resolveTaxForZip("11901", jurs)?.jurisdiction.name).toBe("Suffolk");
  });
  it("longest prefix wins on overlap", () => {
    const overlap = [j("Broad", 800, ["11"]), j("Specific", 8875, ["112"])];
    expect(resolveTaxForZip("11201", overlap)?.jurisdiction.name).toBe("Specific");
  });
  it("skips inactive jurisdictions", () => {
    const withInactive = [j("Old NYC", 8875, ["112"], false)];
    expect(resolveTaxForZip("11201", withInactive)).toBeNull();
  });
  it("null when nothing matches (→ manual entry)", () => {
    expect(resolveTaxForZip("90210", jurs)).toBeNull();
    expect(resolveTaxForZip(null, jurs)).toBeNull();
  });
});
