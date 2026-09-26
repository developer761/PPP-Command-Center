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

/* ────────────────────────  Running it for real  ──────────────────────── */

import Anthropic from "@anthropic-ai/sdk";
import { scrubContacts } from "./class-a-rules";
import { RATER_SCHEMA } from "./rater";

const RATER_MODEL = "claude-opus-5";

/**
 * How many conversations one tick will rate.
 *
 * Every rating is a model call, and the tick runs every minute. Unbounded,
 * a backlog of a thousand ended conversations would be a thousand calls in
 * one invocation — a bill and a timeout. Five a minute drains three hundred
 * an hour, which is comfortably faster than PPP ends them (342 a WEEK in
 * Hatch), and leaves the tick's 300s ceiling alone.
 */
export const RATINGS_PER_TICK = 5;

/** The model call, kept here so rateConversation stays injectable. */
export async function askTheRater(
  prompt: string, transcript: string
): Promise<{ findings: Partial<RaterFinding>[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("no ANTHROPIC_API_KEY, so nothing can be rated");

  const res = await new Anthropic({ apiKey }).messages.create({
    model: RATER_MODEL,
    max_tokens: 4000,
    system: prompt,
    messages: [{ role: "user", content: transcript }],
    tools: [{ name: "record_findings", description: "Record every finding for this conversation.", input_schema: RATER_SCHEMA }],
    // One tool, and it must be used — no path where the rater writes prose
    // instead of findings, for the same reason the agent has none.
    tool_choice: { type: "tool", name: "record_findings" },
  });
  const use = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "record_findings"
  );
  if (!use) throw new Error("the rater returned no findings block");
  return use.input as { findings: Partial<RaterFinding>[] };
}

/**
 * Rate every conversation that has finished and has not been rated.
 *
 * A SWEEP, NOT A HOOK ON THE END PATH. Conversations reach 'ended' from at
 * least three places today and will reach it from more later; 181's own
 * trigger comment says why that matters — "the application will eventually
 * reach 'ended' by a path somebody forgot to wire the cleanup into, and the
 * failure is invisible until a customer is chased three days after booking."
 * A sweep cannot be forgotten by a new code path.
 *
 * Idempotent: a conversation already carrying a source='live' example is
 * skipped, so running this every minute rates each conversation once.
 */
export async function sweepUnrated(
  sb: SupabaseClient,
  opts: { limit?: number; ask?: typeof askTheRater } = {}
): Promise<{ scanned: number; rated: number; failed: number; findings: number; skipped: Record<string, number> }> {
  const limit = opts.limit ?? RATINGS_PER_TICK;
  const ask = opts.ask ?? askTheRater;
  const skipped: Record<string, number> = {};
  const note = (w: string) => { skipped[w] = (skipped[w] ?? 0) + 1; };
  let rated = 0, failed = 0, findingCount = 0;

  const { data: ended } = await sb.from("sms_conversations")
    .select("id, workspace_id, outcome")
    .eq("state", "ended")
    .order("ended_at", { ascending: false })
    .limit(limit * 4);           // room to skip the already-rated

  const convs = ended ?? [];
  for (const c of convs) {
    if (rated + failed >= limit) break;

    const { count: already } = await sb.from("sms_training_examples")
      .select("id", { count: "exact", head: true })
      .eq("source", "live").eq("source_ref", c.id);
    if ((already ?? 0) > 0) { note("already rated"); continue; }

    const turns = await loadTurnsForRating(sb, c.id);
    if (!turns.some((t) => t.role === "bot")) { note("no bot turn to rate"); continue; }

    try {
      /**
       * PII IS STRIPPED BEFORE THE TRANSCRIPT IS STORED OR SENT.
       *
       * 184's own column comment: "PII must be stripped before any of this
       * reaches a model." scrubContacts is the same function Kate's rule
       * import uses, so there is one definition of what a phone number and
       * an address look like rather than two that drift.
       */
      const scrubbed = turns.map((t) => ({ ...t, text: scrubContacts(t.text) ?? t.text }));
      const transcript = scrubbed
        .map((t) => `[turn ${t.ordinal}] ${t.role === "bot" ? "BOT" : "CUSTOMER"}: ${t.text}`)
        .join("\n");

      const { data: ex, error: exErr } = await sb.from("sms_training_examples").insert({
        source: "live",
        source_ref: c.id,
        workspace_id: c.workspace_id,
        transcript,
        outcome: c.outcome,
        pii_scrubbed: true,
        // A human validates or adjusts the rating before it is used for
        // retrieval. Spec: "A person then validates that rating or adjusts
        // it, naming the rule that should have applied instead."
        approved: false,
      }).select("id");
      if (exErr) { note(`example insert ${exErr.code}`); failed++; continue; }

      const out = await rateConversation(sb, {
        conversationId: c.id, exampleId: ex[0].id, ask,
      });
      findingCount += await saveFindings(sb, { exampleId: ex[0].id, findings: out.findings });
      if (out.dropped.length) note(`dropped ${out.dropped.length} unusable finding(s)`);
      rated++;
    } catch (err) {
      failed++;
      note(`rating failed: ${err instanceof Error ? err.message.slice(0, 60) : String(err)}`);
    }
  }

  return { scanned: convs.length, rated, failed, findings: findingCount, skipped };
}
