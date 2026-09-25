import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * EVERY TAB READ "PPP Command Center".
 *
 * Eighty-eight of the eighty-nine pages under /commercial declared no title,
 * so every one of them inherited the root layout's. Accounting was the single
 * exception, and it had been that way since the platform was built.
 *
 * Not cosmetic for the people who use it. Stephanie works job paperwork across
 * several jobs at once; with six tabs open, every one was labelled the same and
 * picking the right one meant clicking through them. It is also the string the
 * browser writes into history and into a bookmark, so both were unusable —
 * ninety entries reading "PPP Command Center".
 *
 * The layout carries the template ("%s · Tomco Painting"), so a page declares
 * only its own name. A record page generates one that names the record, which
 * is the whole point on the deal and account pages.
 *
 * This is a source test because a title is metadata Next resolves at request
 * time — there is no rendered document in this suite to read it off. What it
 * pins is the thing that was missing: the declaration. Proven to fail by
 * deleting one.
 */

const ROOT = process.cwd();
const COMMERCIAL = join(ROOT, "app/commercial");

function pages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const f = join(dir, name);
    if (statSync(f).isDirectory()) pages(f, out);
    else if (name === "page.tsx") out.push(f);
  }
  return out;
}

const ALL = pages(COMMERCIAL);

/**
 * A page that only redirects never paints, so it has no tab to name. Listed by
 * shape rather than by path, so a new shim is covered and a shim that grows a
 * real render is caught the moment it does.
 */
const isRedirectOnly = (src: string) =>
  /\bredirect\(/.test(src) && !/return \(/.test(src);

describe("every commercial page names itself in the tab", () => {
  it("scanned a real number of pages", () => {
    // An audit must prove it measured — a glob that matched nothing would
    // otherwise pass this whole file.
    expect(ALL.length).toBeGreaterThan(80);
  });

  it("the layout carries the template, so a page declares only its own name", () => {
    const layout = readFileSync(join(COMMERCIAL, "layout.tsx"), "utf8");
    expect(layout).toMatch(/template:\s*"%s · Tomco Painting"/);
    expect(layout).toMatch(/default:/);
  });

  it("no rendering page is left without a title", () => {
    const missing: string[] = [];
    for (const f of ALL) {
      const src = readFileSync(f, "utf8");
      if (isRedirectOnly(src)) continue;
      if (/export (const metadata|async function generateMetadata)/.test(src)) continue;
      missing.push(relative(ROOT, f));
    }
    expect(
      missing,
      "these pages would show the layout's default instead of their own name",
    ).toEqual([]);
  });

  it("checked that some pages were actually skipped as redirects, not all of them", () => {
    // The inverse of the above: if `isRedirectOnly` ever matched everything,
    // the test above would pass while covering nothing.
    const skipped = ALL.filter((f) => isRedirectOnly(readFileSync(f, "utf8")));
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.length).toBeLessThan(ALL.length / 2);
  });

  /**
   * The pages where the title has to carry the RECORD, not the page type. Six
   * tabs reading "Opportunity" is the same problem as six reading "PPP Command
   * Center", one word further along.
   */
  it("the record pages name the record", () => {
    const record = {
      "app/commercial/opportunities/[id]/page.tsx": "jobDisplayName",
      "app/commercial/accounts/[id]/page.tsx": "company_name",
      "app/commercial/invoices/[id]/page.tsx": "invoice_number",
    };
    for (const [rel, token] of Object.entries(record)) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, `${rel} has no generateMetadata`).toMatch(
        /export async function generateMetadata/,
      );
      const fn = /export async function generateMetadata[\s\S]*?\n}/.exec(src)?.[0] ?? "";
      expect(fn, `${rel} does not put the record's name in the title`).toContain(token);
    }
  });

  it("a record page falls back rather than throwing", () => {
    // Metadata runs before the page. An exception here takes down a page that
    // would otherwise have rendered perfectly well.
    for (const rel of [
      "app/commercial/opportunities/[id]/page.tsx",
      "app/commercial/accounts/[id]/page.tsx",
      "app/commercial/invoices/[id]/page.tsx",
    ]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const fn = /export async function generateMetadata[\s\S]*?\n}/.exec(src)?.[0] ?? "";
      expect(fn, `${rel} has no catch around its lookup`).toMatch(/\bcatch\b/);
    }
  });

  it("no page re-states the suffix the template already adds", () => {
    // "Payroll · Tomco Painting · Tomco Painting" — the Accounting page used
    // to build the whole string itself.
    const doubled: string[] = [];
    for (const f of ALL) {
      const src = readFileSync(f, "utf8");
      if (/title:\s*[`"'][^`"']*Tomco Painting/.test(src)) doubled.push(relative(ROOT, f));
    }
    expect(doubled).toEqual([]);
  });
});
