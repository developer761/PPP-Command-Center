import { describe, it, expect } from "vitest";
import { resolveToolBack } from "@/components/commercial/tool-back-header";

/**
 * `?back=` is an open-redirect surface — it becomes an href — so it is a
 * whitelist, and the whitelist has to actually contain the places people come
 * from. It didn't contain the deal drill-in, which is where a deal's tools
 * live, so every link carrying it was silently dropped.
 */
const DEAL = "/commercial/accounts/11111111-2222-3333-4444-555555555555";
const DRILL_IN = `${DEAL}?tab=projects&project=66666666-7777-8888-9999-000000000000`;

describe("resolveToolBack", () => {
  it("accepts the deal drill-in, with and without a tool tab", () => {
    expect(resolveToolBack(DRILL_IN)?.path).toBe(DRILL_IN);
    expect(resolveToolBack(`${DRILL_IN}&dt=submittals`)?.path).toBe(`${DRILL_IN}&dt=submittals`);
    // …and with the anchor used to land back on the right section.
    expect(resolveToolBack(`${DRILL_IN}&dt=invoices#deal-invoices`)).not.toBeNull();
  });

  it("still accepts the existing whitelisted targets", () => {
    expect(resolveToolBack("/commercial/post-job/submittals")?.label).toBe("Submittals");
    expect(
      resolveToolBack("/commercial/invoices/new?opp=66666666-7777-8888-9999-000000000000")?.label
    ).toBe("Invoices");
  });

  it("refuses anything that isn't a place in this app", () => {
    // The reason this is a whitelist and not a passthrough: `back` is rendered
    // as an href, so an attacker-supplied value is an open redirect.
    for (const bad of [
      "https://evil.example.com",
      "//evil.example.com",
      "/commercial/accounts/../../etc/passwd",
      "javascript:alert(1)",
      `${DEAL}?tab=projects&project=not-a-uuid`,
      `${DRILL_IN}&dt=submittals&next=https://evil.example.com`,
      "",
      undefined,
    ]) {
      expect(resolveToolBack(bad as string | undefined), String(bad)).toBeNull();
    }
  });

  it("does not accept a drill-in URL with extra query junk appended", () => {
    // Anchored regex — otherwise "…&project=<uuid>&redirect=…" would pass and
    // the guard would be decorative.
    expect(resolveToolBack(`${DRILL_IN}&evil=1`)).toBeNull();
  });
});
