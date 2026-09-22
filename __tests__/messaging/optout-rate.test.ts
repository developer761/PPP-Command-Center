import { describe, it, expect } from "vitest";
import {
  assess, rank, summarise, rateOf, verdictFor, formatRate,
  WATCH_RATE, HIGH_RATE, MIN_PEOPLE,
} from "@/lib/messaging/optout-rate";

const ws = (name: string, peopleTexted: number, optOuts: number) =>
  ({ workspaceId: name, name, peopleTexted, optOuts });

describe("the rate is per person, not per message", () => {
  it("is the share of people texted who asked it to stop", () => {
    expect(rateOf(ws("A", 200, 4))).toBe(0.02);
    expect(formatRate(rateOf(ws("A", 200, 4)))).toBe("2.0%");
  });

  it("has no rate at all when nobody was texted", () => {
    expect(rateOf(ws("A", 0, 0))).toBeNull();
    expect(formatRate(null)).toBe("—");
  });
});

describe("what counts as trouble", () => {
  it("calls a number quiet until enough people have been texted to judge", () => {
    // One opt-out in eight is 12.5% and means nothing.
    expect(verdictFor(ws("A", 8, 1))).toBe("quiet");
    expect(assess(ws("A", 8, 1)).note).toMatch(/too few/i);
  });

  it("is normal below the watch mark", () => {
    expect(verdictFor(ws("A", 500, 4))).toBe("ok"); // 0.8%
  });

  it("is worth watching at the watch mark, and trouble at the high mark", () => {
    expect(verdictFor(ws("A", 100, Math.ceil(WATCH_RATE * 100)))).toBe("watch");
    expect(verdictFor(ws("A", 100, Math.ceil(HIGH_RATE * 100)))).toBe("high");
  });

  it("judges a number the moment there are enough people, not before", () => {
    expect(verdictFor(ws("A", MIN_PEOPLE - 1, MIN_PEOPLE))).toBe("quiet");
    expect(verdictFor(ws("A", MIN_PEOPLE, MIN_PEOPLE))).toBe("high");
  });

  it("tells somebody what to do about a bad number", () => {
    const note = assess(ws("NY Queens Leads", 120, 12)).note;
    expect(note).toMatch(/10\.0%/);
    expect(note).toMatch(/pause/i);
  });
});

describe("the screen opens on the number in trouble", () => {
  const rows = [
    ws("Quiet", 3, 0),
    ws("Fine", 400, 2),
    ws("Watch", 200, 5),      // 2.5%
    ws("Trouble", 150, 15),   // 10%
  ];

  it("ranks trouble first, then watch, then normal, then too-quiet-to-judge", () => {
    expect(rank(rows).map((r) => r.name)).toEqual(["Trouble", "Watch", "Fine", "Quiet"]);
  });

  it("names the numbers in trouble in one line", () => {
    const s = summarise(rank(rows));
    expect(s.needsAttention).toBe(2);
    expect(s.headline).toMatch(/Trouble/);
    expect(s.headline).not.toMatch(/Fine/);
  });

  it("says so plainly when everything is normal", () => {
    const s = summarise(rank([ws("Fine", 400, 2), ws("Quiet", 3, 0)]));
    expect(s.needsAttention).toBe(0);
    expect(s.headline).toMatch(/normal range/i);
  });

  it("leads with the worst of several bad numbers", () => {
    const s = summarise(rank([ws("Bad", 100, 6), ws("Worse", 100, 20)]));
    expect(s.needsAttention).toBe(2);
    expect(s.headline).toMatch(/Bad/);
    expect(s.headline).toMatch(/Worse/);
  });
});

describe("it reads like a person wrote it", () => {
  it("says person, not people, for one", () => {
    expect(assess(ws("A", 1, 1)).note).toMatch(/Only 1 person texted/);
    expect(assess(ws("A", 2, 1)).note).toMatch(/Only 2 people texted/);
  });

  it("says nobody was texted rather than showing a zero", () => {
    expect(assess(ws("A", 0, 0)).note).toMatch(/Nobody texted/);
  });
});

import { selectAll } from "@/lib/messaging/db";

/**
 * PostgREST caps an unbounded select at 1,000 rows and says nothing — no
 * error, no flag, just a short array. loadOptOutRates read the whole
 * conversations table to build the DENOMINATOR of this rate, so past a
 * thousand conversations the denominator truncated while the numerator did
 * not, and the rate over-reported. On this screen that means telling somebody
 * to pause a number that is fine.
 */
describe("reading every row, not the first thousand", () => {
  const rows = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: i + offset }));

  it("returns a single short page as-is", async () => {
    const out = await selectAll<{ id: number }>(async () => ({ data: rows(42), error: null }), "t");
    expect(out).toHaveLength(42);
  });

  it("keeps paging while pages come back full", async () => {
    const pages = [rows(1000), rows(1000, 1000), rows(7, 2000)];
    let i = 0;
    const out = await selectAll<{ id: number }>(async () => ({ data: pages[i++] ?? [], error: null }), "t");
    expect(out).toHaveLength(2007);
    // Every row, in order, not just the first page.
    expect(out[0].id).toBe(0);
    expect(out[2006].id).toBe(2006);
  });

  it("stops on an exact multiple of the page size", async () => {
    // The off-by-one that loops forever: a full last page followed by an empty
    // one has to terminate.
    const pages = [rows(1000), []];
    let i = 0;
    const out = await selectAll<{ id: number }>(async () => ({ data: pages[i++] ?? [], error: null }), "t");
    expect(out).toHaveLength(1000);
  });

  it("asks for the right window each time", async () => {
    const seen: [number, number][] = [];
    let i = 0;
    await selectAll<{ id: number }>(async (a, b) => {
      seen.push([a, b]);
      return { data: i++ === 0 ? rows(1000) : [], error: null };
    }, "t");
    expect(seen).toEqual([[0, 999], [1000, 1999]]);
  });

  it("throws rather than returning a partial count", async () => {
    // A rate built from half the rows is worse than no rate.
    await expect(
      selectAll<{ id: number }>(async () => ({ data: null, error: { message: "timeout" } }), "reading conversations")
    ).rejects.toThrow(/reading conversations: timeout/);
  });

  it("refuses to loop forever against a paging bug", async () => {
    await expect(
      selectAll<{ id: number }>(async () => ({ data: rows(1000), error: null }), "t")
    ).rejects.toThrow(/200,000 rows/);
  });
});
