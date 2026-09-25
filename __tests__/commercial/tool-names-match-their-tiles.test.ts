import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A TOOL IS CALLED THE SAME THING AS THE TILE THAT OPENS IT.
 *
 * The Project tab is a grid of tiles. Pressing one opens that tool with a
 * heading — and on two of them the heading was a different word:
 *
 *   tile "Costs"               → heading "Transactions"
 *   tile "Closeout & Warranty" → heading "Closeout"
 *
 * and the standalone Costs page was headed "Transactions & Job P&L", a third
 * name for the same thing.
 *
 * Stephanie's handbook carried a standing note about it — "Two tiles are named
 * differently from the tool they open" — which is the wrong shape of answer.
 * It only reaches the people who read it before they need it, and somebody
 * following a written step that says Transactions still goes hunting for a
 * tile that says Costs. Documenting a trap is not the same as not having one.
 *
 * Source assertions, because these are string literals in a server component
 * this suite cannot render. What was wrong was the literals, which is exactly
 * what is pinned. Proven to fail by putting either old name back.
 */

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const DEAL_PAGE = "app/commercial/opportunities/[id]/page.tsx";

/** `{ key: "x", label: "Y" }` pairs out of a named const array. */
function labelsOf(src: string, constName: string): Record<string, string> {
  const block = new RegExp(`const ${constName}[\\s\\S]*?\\n\\];`).exec(src)?.[0] ?? "";
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/\{\s*key:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

describe("the Project tools and their tiles agree", () => {
  const src = read(DEAL_PAGE);
  const subTabs = labelsOf(src, "PROJECT_SUB_TABS");

  it("found the list rather than an empty match", () => {
    // An audit must prove it measured: a regex that matched nothing would make
    // every assertion below vacuous.
    expect(Object.keys(subTabs).length).toBeGreaterThanOrEqual(7);
  });

  it("names the two that used to differ after their tiles", () => {
    expect(subTabs.transactions).toBe("Costs");
    expect(subTabs.closeout).toBe("Closeout & Warranty");
  });

  it("every tool heading is also a tile label", () => {
    // The tiles are built in their own block further down the same file. Every
    // heading has to appear there, or somebody arrives at a name they did not
    // press.
    const tileLabels = new Set(
      [...src.matchAll(/\blabel:\s*"([^"]+)"/g)].map((m) => m[1]),
    );
    for (const [key, label] of Object.entries(subTabs)) {
      expect(tileLabels.has(label), `${key} is headed "${label}", which no tile says`).toBe(
        true,
      );
    }
  });

  it("the standalone Costs page is headed Costs too", () => {
    const tool = read("app/commercial/accounts/[id]/costs/[dealId]/costs-tool.tsx");
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(tool)?.[1]?.trim() ?? "";
    expect(h1).toBe("Costs");
    // What it holds is still said, just under the name people arrived by.
    expect(tool).toMatch(/transactions and job P&amp;L/);
  });

  it("the Closeout tool is headed Closeout & Warranty", () => {
    const tool = read("app/commercial/accounts/[id]/closeout/[dealId]/closeout-tool.tsx");
    expect(tool).toMatch(/<h1[^>]*>Closeout &amp; Warranty<\/h1>/);
  });
});

describe("the handbook no longer explains a mismatch that is fixed", () => {
  /*
   * COMMENTS STRIPPED. The code comment above PROJECT_TILES deliberately still
   * records the old names and why they changed — that is history worth
   * keeping, and it is not what Stephanie reads. A ban that matched the
   * docblock explaining the ban is a mistake this repo has made four times in
   * one day; scope it to the prose.
   */
  const guide = read("lib/commercial/guide/roles-delivery.ts");

  it("drops the standing note from the chapter blurb", () => {
    // Kept out of the PROSE only — the code comment above PROJECT_TILES still
    // records what happened and why, which is the part worth keeping.
    const blurb = /blurb:\s*\n?\s*"Open a job and press Project[^"]*"/.exec(guide)?.[0] ?? "";
    expect(blurb, "the Project tab chapter blurb is gone or renamed").not.toBe("");
    expect(blurb).not.toMatch(/named differently/i);
    expect(blurb).toMatch(/same name you pressed/i);
  });

  it("does not tell Stephanie the Costs tool is headed something else", () => {
    expect(guide).not.toMatch(/headed .Transactions & Job P&L./);
  });
});
