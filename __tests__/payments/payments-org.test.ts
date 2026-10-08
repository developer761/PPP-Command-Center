import { describe, expect, it } from "vitest";
import { isSandboxInstanceUrl, paymentsOrgFromEnv } from "@/lib/salesforce/payments-org";

describe("isSandboxInstanceUrl — the guard that keeps test payments out of production", () => {
  it.each([
    ["https://precisionplus--dev.sandbox.my.salesforce.com", true],
    ["https://precisionplus--dev.sandbox.lightning.force.com", true],
    ["https://test.salesforce.com", true],
    ["https://cs42.salesforce.com", true],
    ["https://precisionplus.my.salesforce.com", false], // PPP production
    ["https://login.salesforce.com", false],
    ["https://evil.example.com/.sandbox.", false],
    ["not a url", false],
  ])("%s → %s", (url, ok) => expect(isSandboxInstanceUrl(url)).toBe(ok));
});

describe("paymentsOrgFromEnv", () => {
  it("only exactly 'sandbox' switches the payments code off production", () => {
    expect(paymentsOrgFromEnv({ PAYMENTS_SF_ORG: "sandbox" })).toBe("sandbox");
    expect(paymentsOrgFromEnv({ PAYMENTS_SF_ORG: " sandbox\n" })).toBe("sandbox");
    expect(paymentsOrgFromEnv({ PAYMENTS_SF_ORG: "production" })).toBe("production");
    expect(paymentsOrgFromEnv({})).toBe("production");
  });
});
