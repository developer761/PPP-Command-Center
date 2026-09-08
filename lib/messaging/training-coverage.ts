/**
 * Is the corpus actually good enough?
 *
 * Row count is a bad answer. Five hundred conversations that all demonstrate
 * the same three rules teach less than fifty that cover twenty, because
 * retrieval picks examples by similarity — an untagged corpus surfaces
 * whatever LOOKS like the current conversation rather than whatever
 * demonstrates the rule it needs.
 *
 * So the question this answers is not "how many" but "which of Emily's rules
 * has nothing to show for it". Pure — rows in, gaps out.
 */

export type TagDef = {
  key: string;
  section: string;
  label: string;
  what_to_look_for: string;
  sort_order: number;
};

export type TaggedExample = {
  id: string;
  conduct: "good" | "mixed" | "bad" | null;
  approved: boolean;
  pii_scrubbed: boolean;
  tags: string[];
};

export type TagCoverage = {
  tag: TagDef;
  good: number;
  bad: number;
  /** Ready to be retrieved: graded, scrubbed and approved. */
  usableGood: number;
  status: "covered" | "thin" | "missing" | "only_counterexamples";
};

/** Below this a rule has examples but not enough to be reliably retrieved. */
export const THIN_THRESHOLD = 3;

export function tagCoverage(tags: TagDef[], examples: TaggedExample[]): TagCoverage[] {
  return [...tags]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((tag) => {
      const withTag = examples.filter((e) => e.tags.includes(tag.key));
      const good = withTag.filter((e) => e.conduct === "good").length;
      const bad = withTag.filter((e) => e.conduct === "bad").length;
      const usableGood = withTag.filter(
        (e) => e.conduct === "good" && e.approved && e.pii_scrubbed
      ).length;

      // Order matters. A rule with only counter-examples is a different problem
      // from one with nothing at all: it means somebody found violations and
      // never found a conversation that got it right, which is worth knowing
      // before the bot is asked to imitate anything.
      const status: TagCoverage["status"] =
        usableGood >= THIN_THRESHOLD ? "covered"
        : usableGood > 0 ? "thin"
        : bad > 0 ? "only_counterexamples"
        : "missing";

      return { tag, good, bad, usableGood, status };
    });
}

export type CoverageSummary = {
  total: number;
  covered: number;
  thin: number;
  missing: number;
  onlyCounterexamples: number;
  /** The rules to go and find examples of, worst first. */
  gaps: TagCoverage[];
};

export function coverageSummary(coverage: TagCoverage[]): CoverageSummary {
  const by = (s: TagCoverage["status"]) => coverage.filter((c) => c.status === s);
  return {
    total: coverage.length,
    covered: by("covered").length,
    thin: by("thin").length,
    missing: by("missing").length,
    onlyCounterexamples: by("only_counterexamples").length,
    // Missing first — a rule with nothing is a bigger hole than one with two
    // examples. Within a status, the prompt's own ordering.
    gaps: [...coverage]
      .filter((c) => c.status !== "covered")
      .sort((a, b) => {
        const rank = { missing: 0, only_counterexamples: 1, thin: 2, covered: 3 };
        return rank[a.status] - rank[b.status] || a.tag.sort_order - b.tag.sort_order;
      }),
  };
}

/**
 * Does a single example carry enough to be worth keeping?
 *
 * A grade with no reason is the thing this whole file exists to prevent. An
 * example tagged "good" and nothing else tells retrieval that it was good at
 * SOMETHING, which is not a signal.
 */
export function exampleProblems(e: TaggedExample): string[] {
  const out: string[] = [];
  if (!e.conduct) out.push("not graded");
  if (e.conduct && e.tags.length === 0) out.push("graded but no reason given — says nothing about why");
  if (!e.pii_scrubbed) out.push("PII not scrubbed");
  if (!e.approved) out.push("not approved by a person");
  return out;
}
