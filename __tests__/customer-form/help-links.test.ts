import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COLOR_BRANDS } from "@/lib/customer-form/color-brands";
import { stripComments } from "../helpers/strip-comments";

/**
 * The "Need help picking colors?" card on the customer form.
 *
 * Kate 2026-09-10 asked for an "Exterior Stains" button here, pointing at
 * Benjamin Moore's Woodluxe range — the same stain line that exists in the
 * product picker, so a homeowner researches what the crew will actually buy.
 *
 * These links go to a customer, on their phone, mid-form. Two attributes are
 * not cosmetic: target=_blank so they do not lose a part-filled form, and
 * rel=noopener noreferrer so the opened tab cannot reach back into it.
 *
 * ── REWRITTEN FOR FU.10 ─────────────────────────────────────────────────
 *
 * Kate's brand toggle (2026-10-15) moved the links out of hand-written
 * anchors and into COLOR_BRANDS, so one `<a>` renders all of them. Scanning
 * the JSX for literal hrefs therefore found nothing and these went red.
 *
 * The checks did not stop mattering, so they moved rather than went away:
 * the URL list is now asserted against the DATA, and the two safety
 * attributes against the single anchor every link is rendered through —
 * which is strictly stronger, because it cannot be satisfied for one link
 * and missed for another.
 */
const view = stripComments(readFileSync(join(process.cwd(), "components/customer-form-view.tsx"), "utf-8"));

/** The one anchor the brand links render through. */
function brandLinkAnchor(): string {
  const at = view.indexOf("{brand.links.map((l) => (");
  expect(at, "brand links are no longer rendered from COLOR_BRANDS").toBeGreaterThan(-1);
  return view.slice(at, at + 900);
}

describe("customer-facing help links", () => {
  it("offers the exterior stain range Kate asked for", () => {
    const bm = COLOR_BRANDS.find((b) => b.id === "benjamin-moore")!;
    const stains = bm.links.find((l) => /woodluxe/i.test(l.href));
    expect(stains, "no Woodluxe link on the form").toBeTruthy();
    expect(stains!.href).toBe("https://www.benjaminmoore.com/en-us/b/woodluxe-exterior-wood-stain");
    expect(stains!.label).toBe("Exterior stains");
  });

  it("every external link opens safely in a new tab", () => {
    // Prove it measured something.
    const all = COLOR_BRANDS.flatMap((b) => b.links);
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const l of all) expect(l.href, l.label).toMatch(/^https:\/\//);

    const anchor = brandLinkAnchor();
    expect(anchor, "brand links must open in a new tab").toMatch(/target="_blank"/);
    expect(anchor, "brand links need rel=noopener noreferrer").toMatch(/rel="noopener noreferrer"/);
  });

  it("the vinyl chart link is just as safe", () => {
    // It renders separately — it is a PDF, not a brand link.
    const at = view.indexOf("Vinyl Siding Colors");
    expect(at).toBeGreaterThan(-1);
    const block = view.slice(Math.max(0, at - 1400), at);
    expect(block).toMatch(/target="_blank"/);
    expect(block).toMatch(/rel="noopener noreferrer"/);
  });

  it("every button is a thumb-sized target on a phone", () => {
    expect(brandLinkAnchor()).toMatch(/py-2\.5/);
  });

  it("renders them from the data, not a hand-written list", () => {
    // The thing that let three links drift apart in the first place.
    for (const href of COLOR_BRANDS.flatMap((b) => b.links.map((l) => l.href))) {
      expect(view, `${href} is hardcoded in the JSX again`).not.toContain(`href="${href}"`);
    }
  });
});
