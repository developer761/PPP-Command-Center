/**
 * Kate, "Mods after AM Review Meet", 2026-10-09 — the customer-form items.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const form = () => strip(read("components/customer-form-view.tsx"));

describe("the Vinyl Siding Colors button", () => {
  it("sits in the 'Need help picking colors?' card with the others", () => {
    const s = form();
    const cardAt = s.indexOf("Need help picking colors?");
    const vinylAt = s.indexOf("Vinyl Siding Colors");
    const stainsAt = s.indexOf("Exterior stains");
    expect(cardAt).toBeGreaterThan(-1);
    expect(vinylAt).toBeGreaterThan(cardAt);
    // Next to its siblings, not stranded somewhere else on the page.
    expect(Math.abs(vinylAt - stainsAt)).toBeLessThan(1200);
  });

  it("points at the PDF she linked", () => {
    expect(form()).toContain("https://drive.google.com/file/d/1sPNen01-vP0WpGlhr6rJDuIXkE2ykC7z/view?usp=sharing");
  });

  it("opens safely in a new tab", () => {
    // Every external link in this card does; a customer mid-form must not
    // lose what they have typed.
    const s = form();
    const at = s.indexOf("Vinyl Siding Colors");
    const el = s.slice(Math.max(0, at - 700), at);
    expect(el).toMatch(/target="_blank"/);
    expect(el).toMatch(/rel="noopener noreferrer"/);
  });
});

describe("the submit verbiage", () => {
  it("uses her sentence", () => {
    expect(form()).toContain(
      "Once you submit, you'll get an email with your color choices."
    );
  });

  it("no longer opens with 'we'll order the materials'", () => {
    expect(form()).not.toMatch(/Once you submit, we'll order the materials/);
  });

  it("keeps telling the truth once the edit window has closed", () => {
    // Her example ends "you can still come back", which is false on a job
    // that starts tomorrow. Flattening every branch to her text would have
    // promised an edit window that does not exist.
    const s = form();
    expect(s).toMatch(/We'll order the materials right away/);
    expect(s).toMatch(/update your colors until \$\{editDeadline\.label\}/);
  });

  it("promises an email the submit route actually sends", () => {
    // Gated on a valid recipient and a non-empty submission; an empty one is
    // refused before it gets there, so the promise holds for a customer.
    const submit = strip(read("app/api/customer-form/submit/[token]/route.ts"));
    expect(submit).toMatch(/sendCustomerFormConfirmation\(/);
    expect(submit).toMatch(/recipient\.email && !receiptIsEmpty\(/);
  });
});
