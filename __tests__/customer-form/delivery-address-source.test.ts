/**
 * Kate 2026-10-09: "Display the customer's address instead of 'We have your
 * address on file with our team.'"
 *
 * The form already displayed it whenever it had one — the placeholder renders
 * only when it does not. So this was never a missing feature; it was a blank,
 * and the blank was the source. The form read the OPPORTUNITY'S ACCOUNT's
 * BILLING address, when the work order carries the SERVICE address.
 *
 * Measured over 500 work orders from the last year: 372 had a WO address and
 * no account billing address, 124 had both, 0 had account-only, 4 had
 * neither. Three quarters of jobs showed the placeholder for no reason.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const src = () => strip(read("lib/customer-form/render-data.ts"));

describe("which address the form shows", () => {
  it("asks Salesforce for the work order's own address", () => {
    const s = src();
    // Both field lists — the rich one and the fallback used when
    // MaterialType__c is missing from the org. Adding it to only one means
    // the address vanishes exactly when the fallback fires.
    const lists = s.match(/const (?:rich|base)Fields = `[^`]*`/g) ?? [];
    expect(lists).toHaveLength(2);
    for (const l of lists) {
      expect(l, `missing WO address in: ${l.slice(0, 40)}…`).toMatch(
        /\bStreet, City, State, PostalCode\b/
      );
    }
  });

  it("prefers the service address over the billing address", () => {
    const s = src();
    expect(s).toMatch(/street:\s*\(w\.Street as string \| null\)\s*\|\|\s*oppAccount\?\.BillingStreet/);
    expect(s).toMatch(/city:\s*\(w\.City as string \| null\)\s*\|\|\s*oppAccount\?\.BillingCity/);
    expect(s).toMatch(/state:\s*\(w\.State as string \| null\)\s*\|\|\s*oppAccount\?\.BillingState/);
    expect(s).toMatch(/postalCode:\s*\(w\.PostalCode as string \| null\)\s*\|\|\s*oppAccount\?\.BillingPostalCode/);
  });

  it("falls back rather than replacing — the 124 with both still work", () => {
    // `||` not `??`: Salesforce returns "" for an empty text field as often
    // as null, and `??` would pass the empty string through and show a blank
    // address instead of the account's.
    const s = src();
    expect(s).not.toMatch(/\(w\.Street as string \| null\)\s*\?\?/);
  });

  it("still keeps the placeholder for the handful with no address at all", () => {
    // 4 of 500. The form must not print an empty box for them.
    const form = strip(read("components/customer-form-view.tsx"));
    expect(form).toMatch(/const hasAddress = !!\(addr\.street \|\| addrCityStateZip\)/);
    expect(form).toContain("We have your address on file with our team.");
  });
});
