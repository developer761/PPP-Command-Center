import { describe, it, expect } from "vitest";
import { tagCoverage, coverageSummary, exampleProblems, THIN_THRESHOLD, type TagDef, type TaggedExample } from "@/lib/messaging/training-coverage";

const tag = (key: string, sort = 10): TagDef =>
  ({ key, section: "flow", label: key, what_to_look_for: "…", sort_order: sort });

const ex = (over: Partial<TaggedExample> = {}): TaggedExample =>
  ({ id: "e1", conduct: "good", approved: true, pii_scrubbed: true, tags: [], ...over });

describe("tagCoverage — the question is which rule has nothing", () => {
  it("marks a rule covered once it has enough usable good examples", () => {
    const es = Array.from({ length: THIN_THRESHOLD }, (_, i) => ex({ id: `e${i}`, tags: ["one_question"] }));
    const [c] = tagCoverage([tag("one_question")], es);
    expect(c.status).toBe("covered");
    expect(c.usableGood).toBe(THIN_THRESHOLD);
  });

  it("marks a rule THIN when it has some but not enough", () => {
    const [c] = tagCoverage([tag("one_question")], [ex({ tags: ["one_question"] })]);
    expect(c.status).toBe("thin");
  });

  it("marks a rule MISSING when nothing demonstrates it", () => {
    const [c] = tagCoverage([tag("offsite_required")], [ex({ tags: ["one_question"] })]);
    expect(c.status).toBe("missing");
    expect(c.usableGood).toBe(0);
  });

  it("distinguishes ONLY COUNTEREXAMPLES from missing entirely", () => {
    // A different problem: somebody found violations and never found a
    // conversation that got it right. Worth knowing before the bot is asked
    // to imitate anything.
    const [c] = tagCoverage([tag("price_refused")], [ex({ conduct: "bad", tags: ["price_refused"] })]);
    expect(c.status).toBe("only_counterexamples");
    expect(c.bad).toBe(1);
  });

  it("does not count an unapproved example as usable", () => {
    // An unreviewed transcript is a customer's conversation, not training data.
    const es = Array.from({ length: 5 }, (_, i) => ex({ id: `e${i}`, approved: false, tags: ["one_question"] }));
    const [c] = tagCoverage([tag("one_question")], es);
    expect(c.good).toBe(5);
    expect(c.usableGood).toBe(0);
    expect(c.status).toBe("missing");
  });

  it("does not count an unscrubbed example as usable", () => {
    const es = Array.from({ length: 5 }, (_, i) => ex({ id: `e${i}`, pii_scrubbed: false, tags: ["one_question"] }));
    const [c] = tagCoverage([tag("one_question")], es);
    expect(c.usableGood).toBe(0);
  });

  it("counts one example against every rule it demonstrates", () => {
    // A single strong conversation can cover several rules at once, and
    // counting it only once would understate the corpus.
    const cov = tagCoverage(
      [tag("flow_order", 1), tag("one_question", 2)],
      [ex({ tags: ["flow_order", "one_question"] })]
    );
    expect(cov.every((c) => c.good === 1)).toBe(true);
  });

  it("returns every tag even with no examples at all", () => {
    const cov = tagCoverage([tag("a", 1), tag("b", 2)], []);
    expect(cov).toHaveLength(2);
    expect(cov.every((c) => c.status === "missing")).toBe(true);
  });

  it("orders by the prompt's own ordering, not by name", () => {
    const cov = tagCoverage([tag("zzz", 1), tag("aaa", 2)], []);
    expect(cov.map((c) => c.tag.key)).toEqual(["zzz", "aaa"]);
  });
});

describe("coverageSummary — what to go and find", () => {
  it("puts missing rules ahead of thin ones", () => {
    const cov = tagCoverage(
      [tag("thin_one", 1), tag("missing_one", 2)],
      [ex({ tags: ["thin_one"] })]
    );
    const s = coverageSummary(cov);
    expect(s.gaps[0].tag.key).toBe("missing_one");
    expect(s.missing).toBe(1);
    expect(s.thin).toBe(1);
  });

  it("leaves covered rules out of the gap list", () => {
    const es = Array.from({ length: THIN_THRESHOLD }, (_, i) => ex({ id: `e${i}`, tags: ["ok"] }));
    const s = coverageSummary(tagCoverage([tag("ok")], es));
    expect(s.gaps).toEqual([]);
    expect(s.covered).toBe(1);
  });

  it("counts every status", () => {
    const cov = tagCoverage(
      [tag("a", 1), tag("b", 2), tag("c", 3)],
      [ex({ id: "1", tags: ["a"] }), ex({ id: "2", conduct: "bad", tags: ["b"] })]
    );
    const s = coverageSummary(cov);
    expect(s).toMatchObject({ total: 3, thin: 1, onlyCounterexamples: 1, missing: 1 });
  });
});

describe("exampleProblems — a grade with no reason is the thing to prevent", () => {
  it("flags a grade with no tags", () => {
    // "Good at something" is not a signal retrieval can use.
    expect(exampleProblems(ex({ tags: [] }))).toContain(
      "graded but no reason given — says nothing about why"
    );
  });

  it("does not ask for reasons on an ungraded example", () => {
    // It needs grading first; complaining about both at once is noise.
    const p = exampleProblems(ex({ conduct: null, tags: [] }));
    expect(p).toContain("not graded");
    expect(p.some((x) => x.includes("no reason"))).toBe(false);
  });

  it("flags unscrubbed and unapproved separately", () => {
    const p = exampleProblems(ex({ pii_scrubbed: false, approved: false, tags: ["a"] }));
    expect(p).toContain("PII not scrubbed");
    expect(p).toContain("not approved by a person");
  });

  it("is silent on a complete example", () => {
    expect(exampleProblems(ex({ tags: ["one_question"] }))).toEqual([]);
  });
});
