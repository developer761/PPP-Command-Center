/**
 * Kate's rules, with the evidence attached.
 *
 * Her ask, 2026-09-22: "a section in the connect hub for the established bot
 * rules + having a change/decision history for them… and we could have a
 * section for tagged conversations to see the good vs the bad of that rule +
 * determine if it needs updating."
 *
 * The pieces already existed separately and had never been joined: the rules
 * in sms_class_a_rules, her per-turn findings in sms_example_findings, and the
 * conversations behind them in sms_training_examples. A rule code is the join.
 *
 * ── THE RATER-ONLY COLUMN, ON A HUMAN SCREEN ────────────────────────────
 *
 * Her guidance column is headed "RATER ONLY — NEVER give this to a bot". That
 * is about the MODEL, not about people: she is the rater, and the guidance is
 * written for whoever is grading. It belongs here and nowhere near a prompt.
 *
 * The separation holds because it is structural rather than remembered — the
 * notes live in their own table, class-a-rules-db.ts (which feeds the prompt)
 * does not know that table exists, and this module reads both on purpose.
 * Two loaders, two audiences, no field anybody has to remember to omit.
 */
import { messagingDb, selectAll, selectAllIn } from "./db";
import type { ClassARule } from "./class-a-rules";

export type RuleCounts = { fellShort: number; didWell: number; conversations: number };

export type RuleOverview = ClassARule & {
  shortName: string | null;
  counts: RuleCounts;
};

type FindingRow = {
  code: string | null;
  kind: string | null;
  example_id: string;
};

/**
 * Both halves of the change stamp, or neither. See the note at its use.
 */
function stampOrNothing(lastModified: string | null, changeType: string | null): {
  lastModified: string | null; changeType: string | null;
} {
  if (!lastModified || !changeType) return { lastModified: null, changeType: null };
  return { lastModified, changeType };
}

const asRule = (r: Record<string, unknown>): ClassARule & { shortName: string | null } => ({
  code: r.code as string,
  statement: r.statement as string,
  ruleCard: (r.rule_card as string | null) ?? null,
  correctiveAction: (r.corrective_action as string | null) ?? null,
  severity: (r.severity as "critical" | "mild" | null) ?? null,
  status: (r.status as "live" | "retired") ?? "live",
  phrasingOnly: !!r.phrasing_only,
  binds: r.binds !== false,
  source: (r.source as string | null) ?? null,
  measuredBreaches: (r.measured_breaches as string | null) ?? null,
  /**
   * THE STAMP IS BOTH HALVES OR NEITHER.
   *
   * Spec: "Render both the date and the change type, or neither. Last
   * modified and Change type are written together by the same call on every
   * edit to rule text, so they cannot disagree. The stamp is not decoration:
   * BINDING is what tells us which rated batches have gone stale under a rule
   * change, and it means nothing without its date."
   *
   * In Kate's shipped export they DO disagree, twice: A28 and A38 carry a
   * last_modified of 2026-09-11 and no change_type. A date with no change
   * type cannot say whether a batch went stale, so showing it invites
   * somebody to read a meaning that is not there. Both halves are dropped
   * together, which is the "or neither" the criterion allows, and the two
   * rows are logged for Kate.
   */
  ...stampOrNothing(r.last_modified as string | null, r.change_type as string | null),
  lastReRated: (r.last_re_rated as string | null) ?? null,
  shortName: (r.short_name as string | null) ?? null,
});

const RULE_COLUMNS =
  "code, statement, rule_card, corrective_action, severity, status, phrasing_only, " +
  "binds, source, measured_breaches, change_type, last_modified, last_re_rated, short_name";

/**
 * Every rule, with how often it has actually been broken.
 *
 * Counted across ALL findings rather than only approved conversations: this is
 * a measure of the bot's behaviour, not a corpus the bot learns from, and
 * excluding unapproved gradings would undercount the very thing Kate graded.
 */
export async function loadRuleOverview(): Promise<RuleOverview[]> {
  const sb = messagingDb();

  const [rules, findings] = await Promise.all([
    selectAll<Record<string, unknown>>(
      // Cast at the boundary: RULE_COLUMNS is a variable rather than a
      // literal, so supabase-js cannot infer the row shape from it. asRule
      // below is where the shape is actually asserted.
      (a, b) => sb.from("sms_class_a_rules").select(RULE_COLUMNS).order("code").range(a, b) as never,
      "reading the rules"
    ),
    selectAll<FindingRow>(
      (a, b) => sb.from("sms_example_findings")
        .select("code, kind, example_id").not("code", "is", null).order("id").range(a, b),
      "reading findings"
    ),
  ]);

  const counts = new Map<string, { fellShort: number; didWell: number; convos: Set<string> }>();
  for (const f of findings) {
    if (!f.code) continue;
    const c = counts.get(f.code) ?? { fellShort: 0, didWell: 0, convos: new Set<string>() };
    if (f.kind === "did_well") c.didWell++;
    else c.fellShort++;
    c.convos.add(f.example_id);
    counts.set(f.code, c);
  }

  return rules.map((r) => {
    const rule = asRule(r);
    const c = counts.get(rule.code);
    return {
      ...rule,
      counts: {
        fellShort: c?.fellShort ?? 0,
        didWell: c?.didWell ?? 0,
        conversations: c?.convos.size ?? 0,
      },
    };
  });
}

/**
 * MOST BROKEN FIRST.
 *
 * A list of 44 rules in code order is a reference document. Ordered by how
 * often the bot actually breaks each one, it is a to-do list — and A23 sitting
 * at the top with 618 breaches is the single most useful sentence on the page.
 * Retired rules go last whatever their history, because nobody is fixing them.
 */
export function rankRules(rules: RuleOverview[]): RuleOverview[] {
  return [...rules].sort((a, b) => {
    if ((a.status === "retired") !== (b.status === "retired")) return a.status === "retired" ? 1 : -1;
    if (b.counts.fellShort !== a.counts.fellShort) return b.counts.fellShort - a.counts.fellShort;
    return a.code.localeCompare(b.code, undefined, { numeric: true });
  });
}

export type RuleFinding = {
  id: string;
  exampleId: string;
  turnOrdinal: number | null;
  /** Kate's own label, "T2.2". A fractional turn cannot live in turn_ordinal. */
  turnLabel: string | null;
  /** The bot's own words, as rated. The thing a reader actually wants. */
  turnText: string | null;
  /** How the finding was reached: read, detector, lookup, carve. Separates a
   *  judgement from a measurement. */
  basis: string | null;
  kind: "fell_short" | "did_well";
  severity: "mild" | "medium" | "critical" | null;
  what: string;
  shouldHave: string | null;
  /** The conversation's overall grade, for context on a single finding. */
  conduct: "good" | "mixed" | "bad" | null;
};

export type RuleChangeEntry = {
  id: string;
  field: string;
  before: string | null;
  after: string | null;
  changeType: string | null;
  note: string | null;
  changedBy: string;
  changedAt: string;
};

export type RuleDetail = {
  rule: RuleOverview;
  /** Newest first. Written by the import when Kate re-issues her sheet. */
  changes: RuleChangeEntry[];
  /** RATER ONLY — never passed to a model. See the note at the top. */
  ratingGuidance: string | null;
  history: string | null;
  fellShort: RuleFinding[];
  didWell: RuleFinding[];
};

/** How many examples of each kind one rule page shows. */
export const EXAMPLES_PER_KIND = 25;

export async function loadRuleDetail(code: string): Promise<RuleDetail | null> {
  const sb = messagingDb();

  const { data: row, error } = await sb
    .from("sms_class_a_rules").select(RULE_COLUMNS).eq("code", code.toUpperCase()).maybeSingle() as unknown as
      { data: Record<string, unknown> | null; error: { message: string } | null };
  if (error) throw new Error(`could not read rule ${code}: ${error.message}`);
  if (!row) return null;

  const [{ data: notes }, fellRes, wellRes, changesRes] = await Promise.all([
    sb.from("sms_class_a_rule_notes").select("rating_guidance, history").eq("code", row.code).maybeSingle(),
    // ONE QUERY PER KIND, not one query split afterwards.
    //
    // A single ordered read of 100 findings, split into two lists, empties the
    // "done well" section entirely whenever a rule's newest 100 findings all
    // happen to be breaches — which for A23 (618 breaches) is the norm. The
    // page then showed a non-zero "done well" tile above no examples at all,
    // and the explainer that would have said why is inside the section that
    // did not render. Asking each question separately means each answer is
    // about the thing it is displayed next to.
    sb.from("sms_example_findings")
      .select("id, example_id, turn_ordinal, turn_label, turn_text, basis, kind, severity, what, should_have, created_at")
      .eq("code", row.code).neq("kind", "did_well")
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .limit(EXAMPLES_PER_KIND),
    sb.from("sms_example_findings")
      .select("id, example_id, turn_ordinal, turn_label, turn_text, basis, kind, severity, what, should_have, created_at")
      .eq("code", row.code).eq("kind", "did_well")
      .order("created_at", { ascending: false }).order("id", { ascending: false })
      .limit(EXAMPLES_PER_KIND),
    sb.from("sms_class_a_rule_changes")
      .select("id, field, before, after, change_type, note, changed_by, changed_at")
      .eq("code", row.code).order("changed_at", { ascending: false }).limit(50),
  ]);
  const bad = fellRes.error ?? wellRes.error;
  if (bad) throw new Error(`could not read findings: ${bad.message}`);
  const findings = [...(fellRes.data ?? []), ...(wellRes.data ?? [])];

  // The grade of the conversation each finding came from, so a reader can tell
  // a lone slip in a good conversation from one of many in a bad one.
  const ids = [...new Set(findings.map((f) => f.example_id as string))];
  const conductOf = new Map<string, "good" | "mixed" | "bad" | null>();
  if (ids.length) {
    const exs = await selectAllIn<{ id: string; conduct: string | null }>(
      ids,
      (chunk, from, to) => sb.from("sms_training_examples").select("id, conduct")
        .in("id", chunk).order("id").range(from, to),
      "conduct per example"
    );
    for (const e of exs) conductOf.set(e.id as string, (e.conduct as "good" | "mixed" | "bad" | null) ?? null);
  }

  const shape = (f: Record<string, unknown>): RuleFinding => ({
    id: f.id as string,
    exampleId: f.example_id as string,
    turnOrdinal: (f.turn_ordinal as number | null) ?? null,
    turnLabel: (f.turn_label as string | null) ?? null,
    turnText: (f.turn_text as string | null) ?? null,
    basis: (f.basis as string | null) ?? null,
    kind: f.kind === "did_well" ? "did_well" : "fell_short",
    severity: (f.severity as RuleFinding["severity"]) ?? null,
    what: (f.what as string) ?? "",
    shouldHave: (f.should_have as string | null) ?? null,
    conduct: conductOf.get(f.example_id as string) ?? null,
  });

  const all = findings.map(shape);

  // COUNTED FOR THIS RULE ONLY. The first version called loadRuleOverview(),
  // which reads every rule and every one of the ~3,000 findings in order to
  // pick one row out of the result — the whole corpus fetched to render a
  // single page. Three head-counts instead.
  const [fell, well, convos] = await Promise.all([
    sb.from("sms_example_findings").select("id", { count: "exact", head: true })
      .eq("code", row.code).neq("kind", "did_well"),
    sb.from("sms_example_findings").select("id", { count: "exact", head: true })
      .eq("code", row.code).eq("kind", "did_well"),
    // Distinct conversations cannot be head-counted, so this reads the ids —
    // one narrow column for one rule, not the whole table.
    selectAll<{ example_id: string }>(
      (a, b) => sb.from("sms_example_findings").select("example_id")
        .eq("code", row.code).order("example_id").range(a, b),
      "counting conversations for this rule"
    ),
  ]);

  // Tolerates its migration not being applied: no table means no history
  // yet, which is true, rather than a page that will not render.
  const changes: RuleChangeEntry[] = (changesRes.error ? [] : (changesRes.data ?? [])).map((c) => ({
    id: c.id as string,
    field: c.field as string,
    before: (c.before as string | null) ?? null,
    after: (c.after as string | null) ?? null,
    changeType: (c.change_type as string | null) ?? null,
    note: (c.note as string | null) ?? null,
    changedBy: (c.changed_by as string) ?? "import",
    changedAt: c.changed_at as string,
  }));

  return {
    changes,
    rule: {
      ...asRule(row),
      counts: {
        fellShort: fell.count ?? 0,
        didWell: well.count ?? 0,
        conversations: new Set(convos.map((c) => c.example_id)).size,
      },
    },
    ratingGuidance: (notes?.rating_guidance as string | null) ?? null,
    history: (notes?.history as string | null) ?? null,
    fellShort: all.filter((f) => f.kind === "fell_short"),
    didWell: all.filter((f) => f.kind === "did_well"),
  };
}
