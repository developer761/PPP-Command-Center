/**
 * Can one lead enter two workflows at once?
 *
 * Karan's rule from the 2026-09-02 meeting: if a workspace holds more than one
 * campaign, the entry criteria must not overlap AT ALL, or a lead qualifies for
 * both and the customer is messaged twice from the same number. That is not
 * hypothetical — it is the failure Hatch already produces, and the reason PPP
 * splits its audiences by source today.
 *
 * This answers the question conservatively, and the direction of the caution
 * matters: it reports OVERLAP unless the two rule sets are PROVABLY disjoint.
 * A false "these overlap" costs somebody reading a warning. A false "these are
 * fine" costs a customer two texts and PPP an apology. So anything this cannot
 * prove separate, it flags.
 *
 * Proof of disjointness needs only ONE field the two sets constrain in ways
 * that cannot both hold. Everything else about the rules can be identical.
 */

export type RuleOperator =
  | "equals" | "not_equals" | "in" | "not_in"
  | "contains" | "not_contains"
  | "is_blank" | "is_not_blank" | "is_true" | "is_false"
  | "on_date" | "within_days";

export type Rule = {
  field: string;
  operator: RuleOperator;
  values: (string | number)[];
};

export type OverlapVerdict =
  | { disjoint: true; because: string }
  | { disjoint: false; reason: "no_separating_field" | "empty_ruleset" };

const norm = (v: string | number) => String(v).trim().toLowerCase();
const setOf = (r: Rule) => new Set(r.values.map(norm));
const intersects = (a: Set<string>, b: Set<string>) => [...a].some((v) => b.has(v));
/** Every member of `a` is excluded by `b`. */
const allExcluded = (a: Set<string>, b: Set<string>) => [...a].every((v) => b.has(v));

const POSITIVE = new Set<RuleOperator>(["equals", "in"]);
const NEGATIVE = new Set<RuleOperator>(["not_equals", "not_in"]);

/**
 * Do these two rules, on the SAME field, contradict each other outright?
 * Only returns true when no value can satisfy both.
 */
function contradict(a: Rule, b: Rule): string | null {
  // Presence: blank and not-blank cannot both hold.
  if (a.operator === "is_blank" && b.operator === "is_not_blank") return `${a.field} cannot be both blank and not blank`;
  if (a.operator === "is_not_blank" && b.operator === "is_blank") return `${a.field} cannot be both blank and not blank`;

  // Booleans.
  if (a.operator === "is_true" && b.operator === "is_false") return `${a.field} cannot be both true and false`;
  if (a.operator === "is_false" && b.operator === "is_true") return `${a.field} cannot be both true and false`;

  const av = setOf(a), bv = setOf(b);

  // Two positive constraints with nothing in common. "Record Type is Web
  // Inquiry" against "Record Type is Referral" — a lead is one or the other.
  if (POSITIVE.has(a.operator) && POSITIVE.has(b.operator) && !intersects(av, bv)) {
    return `${a.field} must be one of [${[...av].join(", ")}] and also one of [${[...bv].join(", ")}]`;
  }

  // Positive against negative, where everything the first allows the second
  // forbids. This is the shape PPP's own audiences use: one workflow says
  // "Lead Source in (Angi)" while another says "Lead Source not in (Angi, ...)".
  if (POSITIVE.has(a.operator) && NEGATIVE.has(b.operator) && allExcluded(av, bv)) {
    return `${a.field} must be in [${[...av].join(", ")}], which the other set excludes`;
  }
  if (NEGATIVE.has(a.operator) && POSITIVE.has(b.operator) && allExcluded(bv, av)) {
    return `${a.field} must be in [${[...bv].join(", ")}], which the other set excludes`;
  }

  // Deliberately NOT claiming disjointness for contains / not_contains,
  // within_days or on_date. Substring and date-window logic can look separate
  // and overlap in practice, and a wrong "safe" here texts somebody twice.
  return null;
}

/** Are these two entry rule sets provably unable to match the same lead? */
export function rulesAreDisjoint(a: Rule[], b: Rule[]): OverlapVerdict {
  // An empty rule set matches EVERY lead, so it overlaps with anything. That
  // is worth stating rather than treating as trivially safe.
  if (a.length === 0 || b.length === 0) return { disjoint: false, reason: "empty_ruleset" };

  for (const ra of a) {
    for (const rb of b) {
      if (ra.field.toLowerCase() !== rb.field.toLowerCase()) continue;
      const why = contradict(ra, rb);
      if (why) return { disjoint: true, because: why };
    }
  }
  return { disjoint: false, reason: "no_separating_field" };
}

export type WorkflowEntry = { id: string; name: string; rules: Rule[] };
export type OverlapPair = { a: WorkflowEntry; b: WorkflowEntry; reason: string };

/**
 * Every pair of active workflows in one workspace that could take the same
 * lead. Empty result means the configuration is safe.
 */
export function findOverlaps(workflows: WorkflowEntry[]): OverlapPair[] {
  const out: OverlapPair[] = [];
  for (let i = 0; i < workflows.length; i++) {
    for (let j = i + 1; j < workflows.length; j++) {
      const v = rulesAreDisjoint(workflows[i].rules, workflows[j].rules);
      if (v.disjoint) continue;
      out.push({
        a: workflows[i],
        b: workflows[j],
        reason: v.reason === "empty_ruleset"
          ? "one of these has no entry criteria, so it matches every lead"
          : "no field separates them — a lead could qualify for both",
      });
    }
  }
  return out;
}
