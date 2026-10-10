/**
 * Kate 2026-10-09: "add a new button called 'Save and email customer'. Once
 * clicked, allow the AM to enter the customer's name and email in the same
 * way they do to send the color form to the customer."
 *
 * The BUTTON already existed — Katie asked for it on 2026-10-01 and it
 * resolves the address from the work order, which is the right default. What
 * it had no answer for was a work order with no email: the route replied
 * "Add one in Salesforce, then send the receipt", a dead end at the moment
 * somebody is trying to finish a job. So the AM can now type one.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMAIL_RE } from "@/lib/customer-form/receipt-lines";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const route = () => strip(read("app/api/admin/customer-form/send-receipt/route.ts"));
const button = () => strip(read("components/send-receipt-button.tsx"));

describe("a recipient the AM typed", () => {
  it("overrides the one resolved from the work order", () => {
    const r = route();
    expect(r).toMatch(/const to = typedEmail \|\| resolved\.email/);
    expect(r).toMatch(/toEmail\?: string; toName\?: string/);
  });

  it("is validated with the SAME regex the resolver uses", () => {
    // Two notions of a valid address is how one path sends and the other
    // refuses the identical string.
    expect(route()).toMatch(/EMAIL_RE\.test\(typedEmail\)/);
    expect(EMAIL_RE.test("jane@example.com")).toBe(true);
    expect(EMAIL_RE.test("jane@example")).toBe(false);
    expect(EMAIL_RE.test("not an email")).toBe(false);
  });

  it("logs that a person's address reached a customer", () => {
    // Outbound mail to an address nothing in Salesforce vouches for.
    expect(route()).toMatch(/\[send-receipt\] typed recipient/);
  });

  it("keeps the resolved name when only an email is typed", () => {
    expect(route()).toMatch(/customerName = typedEmail \? \(typedName \|\| resolved\.name\) : resolved\.name/);
  });

  it("still refuses when there is no address at all", () => {
    const r = route();
    expect(r).toMatch(/if \(!to\) \{/);
    expect(r).toMatch(/no_customer_email/);
  });

  it("no longer sends the AM to Salesforce as the only way out", () => {
    expect(route()).toMatch(/type an address below and send it now/);
  });
});

describe("the button", () => {
  it("hides the fields until they are wanted", () => {
    const b = button();
    expect(b).toMatch(/useState\(""\)/);
    expect(b).toMatch(/\{showTo && \(/);
    expect(b).toMatch(/setShowTo\(\(v\) => !v\)/);
  });

  it("opens them by itself when the send fails for want of an address", () => {
    // The dead end becomes the fix, not a message about one.
    expect(button()).toMatch(
      /body\.error === "no_customer_email" \|\| body\.error === "invalid_email"\) setShowTo\(true\)/
    );
  });

  it("omits the override entirely when nothing was typed", () => {
    // An empty string must not be posted as a recipient — the route would
    // treat "" as falsy today, but a future `!== undefined` check would not.
    expect(button()).toMatch(/\.\.\.\(toEmail\.trim\(\) \? \{ toEmail: toEmail\.trim\(\)/);
  });

  it("does not pretend the typed address was saved anywhere", () => {
    expect(button()).toMatch(/not saved back\s+to Salesforce/);
  });

  it("uses 16px inputs so iOS does not zoom the page", () => {
    // Split rather than match a closing "/>" — these elements run well past
    // any fixed window because of the className, and a regex that silently
    // matched one of the two would have passed while half the form zoomed.
    const chunks = button().split("<input").slice(1);
    expect(chunks.length, "expected both recipient inputs").toBe(2);
    for (const c of chunks) {
      expect(c.slice(0, 600)).toMatch(/text-base/);
    }
  });
});
