import { describe, it, expect } from "vitest";
import { normalizeToolOrigin, toolOriginQs } from "@/lib/commercial/tool-origin";

describe("tool-origin", () => {
  it("accepts the three strip tabs", () => {
    expect(normalizeToolOrigin("overview")).toBe("overview");
    expect(normalizeToolOrigin("docs")).toBe("docs");
    expect(normalizeToolOrigin("activity")).toBe("activity");
  });

  it("rejects anything else so the back arrow falls back to the tool list", () => {
    // project is the fallback target itself — never a legal `from`
    expect(normalizeToolOrigin("project")).toBeNull();
    expect(normalizeToolOrigin("invoices")).toBeNull();
    expect(normalizeToolOrigin("")).toBeNull();
    expect(normalizeToolOrigin(undefined)).toBeNull();
    expect(normalizeToolOrigin(null)).toBeNull();
    // No injection of a foreign path/param through the origin slot.
    expect(normalizeToolOrigin("overview&x=1")).toBeNull();
    expect(normalizeToolOrigin("/commercial/accounts")).toBeNull();
  });

  it("serialises a valid origin as an appendable query fragment", () => {
    expect(toolOriginQs("overview")).toBe("&from=overview");
    expect(toolOriginQs("docs")).toBe("&from=docs");
  });

  it("serialises an invalid/absent origin as empty (safe to concat)", () => {
    expect(toolOriginQs("project")).toBe("");
    expect(toolOriginQs("")).toBe("");
    expect(toolOriginQs(undefined)).toBe("");
    expect(toolOriginQs(null)).toBe("");
  });
});
