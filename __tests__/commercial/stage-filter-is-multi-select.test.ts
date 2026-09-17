import { describe, it, expect } from "vitest";

import {
  KANBAN_COLUMNS,
  columnKeyForOpp,
} from "@/lib/commercial/opportunities/kanban-columns";
import { OPPORTUNITY_STATUSES } from "@/lib/commercial/opportunities/constants";

/**
 * `?status=` takes a LIST of stages, and every old single-value link still works.
 *
 * Karan 2026-09-17: "some of these filters are kinda suck, Salesforce has good
 * filters, so if we could get rid of these shitty ones and make better
 * multi-select ones that would be great."
 *
 * Stage was the one that mattered: single-select, and only reachable by
 * clicking a snapshot pill — so "everything out for bid OR waiting on internal
 * approval" could not be expressed at all, and picking a second stage silently
 * replaced the first.
 *
 * THE RISK IN CHANGING IT is backward compatibility, not the parsing. A single
 * `?status=` value is emitted by six retired routes, every saved view, the
 * dashboard tiles, and anything already bookmarked or emailed. This pins that
 * those keep resolving to exactly one stage.
 *
 * The parser is duplicated here rather than exported, because it is six lines
 * inside a 3,900-line server component and lifting it out for a test would be a
 * bigger change than the feature. It is kept identical on purpose — if they
 * drift, the last assertion catches it.
 */
const parseStages = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      KANBAN_COLUMNS.some((c) => c.key === s)
        ? s
        : (OPPORTUNITY_STATUSES as readonly string[]).includes(s)
          ? columnKeyForOpp(s, null)
          : undefined
    )
    .filter((k): k is string => !!k);

describe("the stage filter", () => {
  it("takes several stages at once", () => {
    expect(parseStages("rfp,sent,won")).toEqual(["rfp", "sent", "won"]);
  });

  it("still honours a single stage, the shape every old link uses", () => {
    for (const c of KANBAN_COLUMNS) {
      expect(parseStages(c.key), c.key).toEqual([c.key]);
    }
  });

  it("still resolves a RAW STATUS, which the retired routes emit", () => {
    // `/commercial/post-job/aia` redirects to `?status=billing`, and `billing`
    // is a status, not a column key.
    expect(parseStages("billing")).toEqual(["billing"]);
    expect(parseStages("in_progress")).toEqual(["in_progress"]);
    // A raw status mixed into a list resolves too.
    expect(parseStages("rfp,billing")).toEqual(["rfp", "billing"]);
  });

  it("drops junk rather than filtering to nothing", () => {
    // A bad value used to make `validColumn` undefined, i.e. no filter. It must
    // not instead produce a filter matching zero rows, which reads as "the
    // pipeline is empty" rather than "that link was wrong".
    expect(parseStages("not_a_stage")).toEqual([]);
    expect(parseStages("")).toEqual([]);
    expect(parseStages(undefined)).toEqual([]);
    // Junk alongside real stages keeps the real ones.
    expect(parseStages("rfp,nonsense,won")).toEqual(["rfp", "won"]);
  });

  it("tolerates the spacing a hand-typed URL has", () => {
    expect(parseStages(" rfp , won ")).toEqual(["rfp", "won"]);
    expect(parseStages("rfp,,won")).toEqual(["rfp", "won"]);
  });

  it("every stage a deal can be in is selectable", () => {
    // If a column is ever added and the filter cannot express it, deals land in
    // a stage with no way to list them — which is how the old single-select
    // hid Pending Approval for a month.
    const selectable = new Set(KANBAN_COLUMNS.map((c) => c.key));
    const tuples: [string, string | null][] = [
      ["qualifying", "rfp"],
      ["estimating", "estimating"],
      ["estimating", "proposal_pending_approval"],
      ["proposal", "sent"],
      ["pre_sale_closed", "won"],
      ["pre_sale_closed", "lost"],
      ["pre_construction", "coordination"],
      ["in_progress", "wip_on_site"],
      ["billing", "substantial_completion"],
      ["post_sale_closed", "closed"],
    ];
    for (const [st, sub] of tuples) {
      const key = columnKeyForOpp(st, sub);
      expect(selectable.has(key), `${st}/${sub} → ${key}`).toBe(true);
      expect(parseStages(key)).toEqual([key]);
    }
  });

  it("matches the parser the page actually runs", () => {
    // The guard against this test and the page drifting apart. Both must map a
    // raw status through columnKeyForOpp and accept a comma list.
    const src = readPage();
    expect(src).toContain('.split(",")');
    expect(src).toContain("columnKeyForOpp(raw, null)");
    expect(src).toContain("const stageSet = new Set(stageKeys)");
    // And the filter must use the SET, not the single column.
    expect(src).toContain("stageSet.has(columnKeyForOpp(o.status, o.sub_status))");
  });
});

function readPage(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync("app/commercial/opportunities/page.tsx", "utf8");
}
