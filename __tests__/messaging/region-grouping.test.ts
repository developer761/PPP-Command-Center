import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Region grouping for the messaging rail, checked against PPP's REAL workspace
 * names (pulled from sms_sub_accounts on 2026-09-08, 32 rows, 15 active).
 *
 * The bug this pins: "AM - SoFlo" matched the /SoFlo/ branch and grouped under
 * Florida, while "AM - NY" and "AM - NJ" grouped under Account management —
 * three workspaces doing the same job split across two places. The intent was
 * already written down where `order` is defined ("AM workspaces are a different
 * job from lead inboxes, so they sit in their own group"); the branch order
 * quietly contradicted it.
 *
 * regionOf is module-private, so the rules are mirrored here and pinned to the
 * source below. Mirroring alone would let the two drift, which is why the
 * ordering assertion reads the real file.
 */
function regionOf(name: string): string {
  if (/^AM - /i.test(name)) return "Account management";
  if (/^NY |^NYC |\bLI |Queens|Wstch/i.test(name)) return "New York";
  if (/^NJ /i.test(name)) return "New Jersey";
  if (/^FL |SoFlo/i.test(name)) return "Florida";
  if (/^CT |WC CT/i.test(name)) return "Connecticut";
  if (/^CA /i.test(name)) return "California";
  if (/^CO /i.test(name)) return "Colorado";
  if (/^TX /i.test(name)) return "Texas";
  if (/^NC /i.test(name)) return "North Carolina";
  if (/^LA /i.test(name)) return "Louisiana";
  return "Other";
}

/** Every ACTIVE workspace in production on 2026-09-08. */
const ACTIVE = [
  "AM - NJ", "AM - NY", "AM - SoFlo",
  "FL Broward Leads", "FL Miami Leads", "SoFlo Meta",
  "NJ Leads", "NJ Meta",
  "NY LI Meta", "NY LI Nassau Leads", "NY LI Suffolk Leads",
  "NY NYC Leads", "NY Queens Leads", "NY Wstch Leads", "NYC Meta",
];

/** Inactive today, but they are what the rail shows the day someone flips one on. */
const INACTIVE = [
  "AM - CA LA", "AM - CT", "AM - Dallas TX",
  "CA LA Leads", "CA Meta", "CA San Diego Leads",
  "CO Denver Leads", "CT Leads", "FL Orlando Leads",
  "TX Dallas Leads", "TX Meta 2", "WC CT Meta", "NC Leads",
  "LA Baton Rouge Leads", "Google LSA", "Thumbtack", "Elevate Paint Co",
];

describe("region grouping, against real workspace names", () => {
  it("all three AM workspaces land together", () => {
    for (const n of ["AM - NY", "AM - NJ", "AM - SoFlo"]) {
      expect(regionOf(n), n).toBe("Account management");
    }
  });

  it("the AM branch runs FIRST in the shipped source", () => {
    // The defect was branch ORDER, which the mirrored copy above cannot catch.
    //
    // COMMENTS ARE STRIPPED FIRST. The initial version of this test measured
    // indexOf("Account management") against indexOf("SoFlo") on the raw slice
    // and passed with the branches swapped — because the explanatory comment
    // sitting at the top of regionOf contains BOTH phrases, so it was reading
    // prose, not code. Verified by swapping them and watching it stay green.
    const src = readFileSync(join(process.cwd(), "lib/messaging/db.ts"), "utf8");
    const body = src
      .slice(src.indexOf("function regionOf("), src.indexOf("export async function sidebarWorkspaces"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    // Anchor on the RETURN statements — the thing that actually decides.
    const am = body.indexOf('return "Account management"');
    const florida = body.indexOf('return "Florida"');
    expect(am, "no Account management branch").toBeGreaterThan(-1);
    expect(florida, "no Florida branch").toBeGreaterThan(-1);
    expect(am, "AM must be tested before Florida or AM - SoFlo grabs Florida").toBeLessThan(florida);
  });

  it("groups every active workspace the way the rail shows it", () => {
    const counts: Record<string, number> = {};
    for (const n of ACTIVE) counts[regionOf(n)] = (counts[regionOf(n)] ?? 0) + 1;
    expect(counts).toEqual({
      "Account management": 3,
      "New York": 7,
      "New Jersey": 2,
      Florida: 3,
    });
  });

  it("leaves nothing in Other — active or inactive", () => {
    // "Other" is a silent dumping ground: a workspace lands there and nobody
    // notices until someone asks why their inbox is at the bottom.
    const orphans = [...ACTIVE, ...INACTIVE].filter((n) => regionOf(n) === "Other");
    // Only lead SOURCES may land here. Four real state workspaces (TX Dallas
    // Leads, TX Meta 2, NC Leads, LA Baton Rouge Leads) used to, and were
    // invisible because all four are inactive — the day someone switched Texas
    // on it would have appeared at the bottom under a heading reading like a bug.
    expect(orphans, "these need a rule in regionOf").toEqual([
      "Google LSA", "Thumbtack", "Elevate Paint Co",
    ]);
  });

  it("state prefixes survive being a substring of another word", () => {
    // "LI" mid-name is deliberate (NY LI Nassau) but must be word-bounded:
    // unanchored, "CALI Leads" filed under New York.
    expect(regionOf("Client Leads")).not.toBe("New York");
    expect(regionOf("CALI Leads")).not.toBe("New York");
    expect(regionOf("NY LI Nassau Leads")).toBe("New York");
  });

  it("the states with no rule are now covered", () => {
    expect(regionOf("TX Dallas Leads")).toBe("Texas");
    expect(regionOf("TX Meta 2")).toBe("Texas");
    expect(regionOf("NC Leads")).toBe("North Carolina");
    // LA is Louisiana here; Los Angeles arrives as "CA LA" and stays California.
    expect(regionOf("LA Baton Rouge Leads")).toBe("Louisiana");
    expect(regionOf("CA LA Leads")).toBe("California");
  });

  it("every region a name can produce has a slot in the display order", () => {
    // A region missing from `order` sorts to indexOf -1 and silently jumps to
    // the TOP of the rail, above New York.
    const src = readFileSync(join(process.cwd(), "lib/messaging/db.ts"), "utf8");
    const order = src.slice(src.indexOf("const order = ["));
    for (const r of ["Texas", "North Carolina", "Louisiana", "Account management", "Other"]) {
      expect(order.slice(0, order.indexOf("]")), r).toContain(`"${r}"`);
    }
  });
});
