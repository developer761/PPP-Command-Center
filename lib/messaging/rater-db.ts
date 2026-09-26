/**
 * The auto-rater against the database.
 *
 * 🔴 THIS IS THE ONLY MODULE THAT LOADS RATING GUIDANCE ALONGSIDE THE RULES.
 *
 * Kate: "RATER ONLY — NEVER give this to a bot." The separation is structural
 * — sms_class_a_rule_notes is a different table, and the bot-facing loader in
 * class-a-rules-db.ts does not know it exists — so the thing to protect is
 * that NOTHING here is reachable from an agent turn. Nothing in this file is
 * imported by agent-run.ts, and rater.test.ts proves the guidance appears in
 * the rater's prompt and in no bot prompt.
 *
 * Kept apart from rater.ts for the usual reason: the rules about what counts
 * as a usable finding are worth testing without a database.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./paging";
import {
  keepUsableFindings, type RaterFinding, type RuleForRating, type RatableTurn,
} from "./rater";

/**
 * Every live rule WITH its rater-only guidance.
 *
 * Two reads rather than a join, because PostgREST's embedded select would
 * make the notes table reachable through a rules query — and the whole point
 * is that it takes a deliberate second ask.
 */
export async function loadRulesForRating(sb: SupabaseClient): Promise<RuleForRating[]> {
  const rules = await selectAll<Record<string, unknown>>(
    (from, to) => sb.from("sms_class_a_rules")
      .select("code, statement, rule_card, corrective_action, severity, status, phrasing_only, binds")
      .eq("status", "live").order("code").range(from, to),
    "sms_class_a_rules (rating)"
  );
  const notes = await selectAll<{ code: string; rating_guidance: string | null }>(
    (from, to) => sb.from("sms_class_a_rule_notes")
      .select("code, rating_guidance").order("code").range(from, to),
    "sms_class_a_rule_notes"
  );
  const byCode = new Map(notes.map((n) => [n.code, n.rating_guidance]));

  return rules.map((r) => ({
    code: r.code as string,
    statement: r.statement as string,
    ruleCard: (r.rule_card as string) ?? null,
    correctiveAction: (r.corrective_action as string) ?? null,
    severity: (r.severity as "critical" | "mild") ?? null,
    status: r.status as "live" | "retired",
    phrasingOnly: Boolean(r.phrasing_only),
    binds: Boolean(r.binds),
    ratingGuidance: byCode.get(r.code as string) ?? null,
  })) as RuleForRating[];
}

/** The conversation as turns, oldest first, numbered from 1. */
export async function loadTurnsForRating(
  sb: SupabaseClient, conversationId: string
): Promise<RatableTurn[]> {
  const msgs = await selectAll<{ direction: string; body: string | null }>(
    (from, to) => sb.from("sms_messages")
      .select("direction, body, created_at, id")
      .eq("conversation_id", conversationId)
      .order("created_at").order("id").range(from, to),
    "sms_messages (rating)"
  );
  return msgs.map((m, i) => ({
    ordinal: i + 1,
    role: m.direction === "outbound" ? ("bot" as const) : ("customer" as const),
    text: (m.body ?? "").trim(),
  })).filter((t) => t.text.length > 0);
}

/**
 * Write findings in the handover shape the Rule Hub's tagged view reads.
 *
 * `basis` is set to 'auto_rater' so these are distinguishable from Kate's
 * shipped corpus at a glance — the two must never be mixed when a baseline is
 * being checked. See verify-surfaces, which pins her figures to her own
 * import batch for exactly this reason.
 */
export async function saveFindings(
  sb: SupabaseClient,
  input: { exampleId: string; findings: readonly RaterFinding[] }
): Promise<number> {
  if (!input.findings.length) return 0;
  const { error } = await sb.from("sms_example_findings").insert(
    input.findings.map((f) => ({
      example_id: input.exampleId,
      turn_ordinal: f.turn,
      code: f.code,
      kind: f.kind,
      what: f.reason,
      basis: "auto_rater",
    }))
  );
  if (error) throw new Error(`could not save findings: ${error.code} ${error.message}`);
  return input.findings.length;
}

/**
 * Rate one conversation.
 *
 * `ask` is injected: the model call is the caller's, so this is testable
 * without a key and the rater can be run against a fixture.
 */
export async function rateConversation(
  sb: SupabaseClient,
  input: {
    conversationId: string;
    exampleId: string;
    ask(prompt: string, transcript: string): Promise<{ findings: Partial<RaterFinding>[] }>;
  }
): Promise<{ findings: RaterFinding[]; dropped: { reason: string; finding: unknown }[]; turns: number }> {
  const [rules, turns] = await Promise.all([
    loadRulesForRating(sb),
    loadTurnsForRating(sb, input.conversationId),
  ]);
  // A conversation with no bot turn has nothing to rate, and asking the model
  // anyway spends a call to be told so.
  if (!turns.some((t) => t.role === "bot")) return { findings: [], dropped: [], turns: turns.length };

  const { buildRaterPrompt, renderTurnsForRating } = await import("./rater");
  const out = await input.ask(buildRaterPrompt(rules), renderTurnsForRating(turns));

  const { findings, dropped } = keepUsableFindings(out.findings ?? [], {
    liveCodes: new Set(rules.map((r) => r.code)),
    turns,
  });
  return { findings, dropped, turns: turns.length };
}
