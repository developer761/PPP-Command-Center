import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The "Need help picking colors?" card on the customer form.
 *
 * Kate 2026-09-10 asked for an "Exterior Stains" button here, pointing at
 * Benjamin Moore's Woodluxe range — the same stain line that now exists in the
 * product picker, so a homeowner researches what the crew will actually buy.
 *
 * These links go to a customer, on their phone, mid-form. Two attributes are
 * not cosmetic: target=_blank so they do not lose a part-filled form, and
 * rel=noopener noreferrer so the opened tab cannot reach back into it.
 */
const view = readFileSync(join(process.cwd(), "components/customer-form-view.tsx"), "utf-8");

/** Pull each <a href="http..."> out of the help card with its attributes. */
function externalAnchors(): Array<{ href: string; attrs: string; label: string }> {
  const out: Array<{ href: string; attrs: string; label: string }> = [];
  for (const m of view.matchAll(/<a\s+([\s\S]*?)>([\s\S]*?)<\/a>/g)) {
    const attrs = m[1];
    const href = /href="(https?:\/\/[^"]+)"/.exec(attrs)?.[1];
    if (!href) continue;
    const label = m[2].replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/\s+/g, " ").trim();
    out.push({ href, attrs, label });
  }
  return out;
}

describe("customer-facing help links", () => {
  it("offers the exterior stain range Kate asked for", () => {
    const anchors = externalAnchors();
    const stains = anchors.find((a) => /woodluxe/i.test(a.href));
    expect(stains, "no Woodluxe link on the form").toBeTruthy();
    expect(stains!.href).toBe("https://www.benjaminmoore.com/en-us/b/woodluxe-exterior-wood-stain");
    expect(stains!.label).toBe("Exterior stains");
  });

  it("every external link opens safely in a new tab", () => {
    const anchors = externalAnchors();
    // Prove it measured something — palettes, visualizer, stains.
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    for (const a of anchors) {
      expect(a.attrs, `${a.href} must open in a new tab`).toMatch(/target="_blank"/);
      expect(a.attrs, `${a.href} needs rel=noopener noreferrer`).toMatch(/rel="noopener noreferrer"/);
    }
  });

  it("the stain button is styled and sized like the two beside it", () => {
    const anchors = externalAnchors();
    const stains = anchors.find((a) => /woodluxe/i.test(a.href))!;
    const palettes = anchors.find((a) => /color-palettes/i.test(a.href))!;
    const cls = (s: string) => /className="([^"]+)"/.exec(s)?.[1] ?? "";
    expect(cls(stains.attrs)).toBe(cls(palettes.attrs));
    // py-2.5 on mobile keeps it a thumb-sized target.
    expect(cls(stains.attrs)).toMatch(/py-2\.5/);
  });
});
