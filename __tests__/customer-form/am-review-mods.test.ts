/**
 * Kate, "Mods after AM Review Meet", 2026-10-09 — the customer-form items.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const strip = (s: string) =>
  stripComments(s);
const form = () => strip(read("components/customer-form-view.tsx"));

describe("the Vinyl Siding Colors button", () => {
  it("sits in the 'Need help picking colors?' card with the others", () => {
    const s = form();
    const cardAt = s.indexOf("Need help picking colors?");
    const vinylAt = s.indexOf("Vinyl Siding Colors");
    // Kate FU.10 moved the brand links into COLOR_BRANDS, so "Exterior
    // stains" is no longer a literal in this file. Its siblings are now the
    // one anchor they all render through.
    const linksAt = s.indexOf("{brand.links.map((l) => (");
    expect(cardAt).toBeGreaterThan(-1);
    expect(linksAt, "brand links are not rendered from the data").toBeGreaterThan(-1);
    expect(vinylAt).toBeGreaterThan(cardAt);
    // Next to its siblings, not stranded somewhere else on the page.
    expect(Math.abs(vinylAt - linksAt)).toBeLessThan(2000);
  });

  it("points at the copy WE serve, not her Drive", () => {
    // Kate FU.3 (2026-10-15). The Drive share URL worked for anyone with
    // the address, but it was a file in PPP's Drive: the day its sharing
    // was tightened a customer would have hit a request-access screen
    // mid-form, with nowhere to go and no way to tell us.
    expect(form()).toContain('href="/colors-for-vinyl.pdf"');
    expect(form(), "the Drive link is back").not.toContain("drive.google.com");
  });

  it("the file is actually in public/, or the button 404s", () => {
    // A link to a file nobody shipped is worse than the Drive link it
    // replaced — it fails for everyone, immediately.
    const pdf = join(__dirname, "..", "..", "public", "colors-for-vinyl.pdf");
    expect(existsSync(pdf), "public/colors-for-vinyl.pdf is missing").toBe(true);
    const bytes = readFileSync(pdf);
    expect(bytes.subarray(0, 5).toString("latin1"), "not a PDF").toBe("%PDF-");
    // The real brochure is ~8 MB; a truncated or placeholder file is not.
    expect(bytes.length).toBeGreaterThan(1_000_000);
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
