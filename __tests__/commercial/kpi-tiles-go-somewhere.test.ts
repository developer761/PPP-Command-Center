import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A number you can see but not act on is the Salesforce complaint.
 *
 * Karan 2026-08-22: *"Salesforce is too clicky to get to certain information,
 * we need to be better."*
 *
 * The deal page leads with a stage-aware KPI strip — the right facts change as
 * the job moves, which is the good half. But only 6 of 27 tiles linked
 * anywhere. The other 21 showed a figure and left you to work out which of the
 * eleven tabs owned it: see "Left to bill $42,000", then go hunting.
 *
 * Every tile that HAS an owning tool now goes there in one click. The ones that
 * don't — a date something happened, how long ago a deal was won — stay plain,
 * because a link that lands nowhere useful is worse than no link.
 */

const SRC = readFileSync("lib/commercial/opportunities/stage-kpis.ts", "utf8");
const STRIP = readFileSync("components/commercial/stage-kpi-strip.tsx", "utf8");

/** Every tab target the opportunity page's resolver accepts. */
const RESOLVER = readFileSync("app/commercial/opportunities/[id]/page.tsx", "utf8");

describe("stage KPI tiles", () => {
  it("the money tiles all lead to the tool that owns them", () => {
    // These are the ones somebody acts on: bill it, chase it, check the costs.
    for (const key of ["left_to_bill", "billed", "margin", "final_margin", "cos", "ar", "retainage"]) {
      const at = SRC.indexOf(`key: "${key}"`);
      expect(at, `tile "${key}" is gone`).toBeGreaterThan(-1);
      // Wide enough to clear the explanatory comments some tiles carry — a
      // window that stops short reports a linked tile as unlinked.
      const block = SRC.slice(at, SRC.indexOf("});", at) + 3);
      expect(block, `"${key}" shows a figure with nowhere to go`).toContain("href:");
    }
  });

  it("every href names a tab the resolver actually accepts", () => {
    // A tab value the resolver doesn't know silently lands on Overview — the
    // tile would look like it worked and quietly do nothing.
    const tabs = [...SRC.matchAll(/href: "\?tab=([a-z-]+)/g)].map((m) => m[1]);
    expect(tabs.length).toBeGreaterThan(4);
    for (const t of new Set(tabs)) {
      expect(RESOLVER, `?tab=${t} is not handled by resolveTabParam`).toContain(`raw === "${t}"`);
    }
  });

  it("an absolute href leaves the deal instead of being glued onto it", () => {
    // Crew hours live in Field Ops. Concatenating blindly produced
    // /commercial/opportunities/{id}/commercial/field-ops/hours.
    expect(STRIP).toContain('k.href?.startsWith("/") ? k.href : `${basePath}${k.href}`');
  });

  it("tiles that are just a fact stay unlinked", () => {
    // "Won 3 weeks ago" has no tool behind it. A link there would be a click
    // that teaches you not to trust the other tiles.
    const at = SRC.indexOf('key: "won_ago"');
    expect(SRC.slice(at, at + 200)).not.toContain("href:");
  });
});
