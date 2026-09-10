"use server";

/**
 * Replaying saved scenarios against the bot as it is now.
 *
 * Migration 195 decided a graded sandbox run becomes a REGRESSION TEST rather
 * than training data. This is the half that makes that true: send the same
 * customer messages again, compare turn by turn, and say what changed.
 *
 * WHY IT REPLAYS THE WHOLE CONVERSATION rather than asking about one turn in
 * isolation: what the bot says at turn four depends on turns one to three. A
 * turn-by-turn replay that fed it the ORIGINAL history would be testing a
 * conversation that no longer exists — if turn two now asks a different
 * question, turn three is answering something it was never asked. So each
 * replay builds its own history as it goes, which is what actually happens in
 * a live conversation.
 *
 * The consequence is worth stating: one changed turn early on can legitimately
 * change everything after it, and that is a real result rather than noise.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";
import { runSimTurn } from "./simulator";
import { stageFromIntents } from "./agent-output";
import { compareTurn, summarise, verdictLine, type SavedTurn, type ReplaySummary } from "./replay";

export type ScenarioSummary = {
  id: string;
  name: string;
  tagKey: string | null;
  turns: number;
  lastRunAt: string | null;
  lastRunPassed: boolean | null;
};

export async function savedScenarios(): Promise<ScenarioSummary[]> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { data } = await sb.from("sms_scenarios")
    .select("id, name, tag_key, last_run_at, last_run_passed, sms_scenario_turns(id)")
    .order("created_at", { ascending: false });
  return (data ?? []).map((s) => ({
    id: s.id, name: s.name, tagKey: s.tag_key,
    turns: (s.sms_scenario_turns as unknown as unknown[])?.length ?? 0,
    lastRunAt: s.last_run_at, lastRunPassed: s.last_run_passed,
  }));
}

export type ReplayResult =
  | { ok: true; name: string; summary: ReplaySummary; line: string }
  | { ok: false; error: string };

export async function replayScenario(input: { scenarioId: string }): Promise<ReplayResult> {
  await assertMessagingAccess();
  const sb = messagingDb();

  const { data: scenario } = await sb.from("sms_scenarios")
    .select("id, name, workspace_id").eq("id", input.scenarioId).maybeSingle();
  if (!scenario) return { ok: false, error: "That scenario no longer exists." };

  const { data: rows } = await sb.from("sms_scenario_turns")
    .select("ordinal, customer_text, bot_intent, bot_message, verdict, verdict_note, expected_intent")
    .eq("scenario_id", scenario.id).order("ordinal");
  if (!rows?.length) return { ok: false, error: "That scenario has no turns to replay." };

  const saved: SavedTurn[] = rows.map((r) => ({
    ordinal: r.ordinal, customerText: r.customer_text,
    intent: r.bot_intent, message: r.bot_message ?? "",
    verdict: r.verdict as SavedTurn["verdict"], verdictNote: r.verdict_note,
    expectedIntent: r.expected_intent,
  }));

  // History built as the replay goes, not taken from the recording — see the
  // note at the top of this file.
  const history: { role: "customer" | "assistant"; text: string }[] = [];
  const intents: (string | null)[] = [];
  const now: { ordinal: number; intent: string | null; message: string }[] = [];

  for (const t of saved) {
    const res = await runSimTurn({
      workspaceId: scenario.workspace_id ?? undefined,
      history: [...history],
      customerText: t.customerText,
      stage: stageFromIntents(intents),
      lastIntent: intents[intents.length - 1] ?? undefined,
    });

    if (!res.ok) {
      // A replay that cannot run is not a passing replay. Saying "the model
      // could not be reached" is very different from "nothing changed", and
      // conflating them is how a broken key looks like a green run.
      return { ok: false, error: `Could not replay turn ${t.ordinal}: ${res.error}` };
    }

    now.push({ ordinal: t.ordinal, intent: res.turn.intent, message: res.turn.message });
    history.push({ role: "customer", text: t.customerText });
    if (res.turn.message) history.push({ role: "assistant", text: res.turn.message });
    intents.push(res.turn.intent);
  }

  const comparisons = saved.map((t) => compareTurn(t, now.find((n) => n.ordinal === t.ordinal)));
  const summary = summarise(comparisons);

  await sb.from("sms_scenarios").update({
    last_run_at: new Date().toISOString(),
    last_run_passed: summary.clean,
    updated_at: new Date().toISOString(),
  }).eq("id", scenario.id);

  return { ok: true, name: scenario.name, summary, line: verdictLine(summary) };
}
