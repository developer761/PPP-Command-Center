"use server";

/**
 * The sandbox.
 *
 * Kate plays a customer, the real agent logic answers, she grades it.
 *
 * SAFETY: this file never imports the transport and never calls the gate. Not
 * a disabled send path — no send path. The simulator has no phone number, no
 * conversation row and no scheduled action; it calls the model and returns
 * what it said. There is nothing here that could reach a person even if every
 * other guard were removed.
 */
import { messagingDb } from "./db";
import { classifyInbound } from "./compliance";
import { selectExamples, situationFrom } from "./retrieval";
import { resolveServices } from "./services";
import { agentConfigFor } from "./agent-config-for";
import { normalizeInbound } from "./inbound-normalize";
import { loadRetrievalCorpus, loadWorkspaceServices } from "./db";
import type { Track } from "./agent-output";
import type { KnownCustomer } from "./known-customer";
import { runAgentTurn, agentAvailable, type Turn } from "./agent-run";
import { assertMessagingAccess } from "./auth";

export type SimTurn = {
  ordinal: number;
  customerText: string;
  intent: string | null;
  confidence: number | null;
  message: string;
  escalate: boolean;
  error?: string;
  rejected?: string;
  /** Rapport that broke a tone rule and was not sent, with the reason. Shown
   *  rather than swallowed: a reply that reads oddly terse is confusing until
   *  you know a sentence was removed from it, and that is exactly the kind of
   *  thing somebody grading needs to see. */
  droppedRapport?: string;
  /** The intent produced no words at all and was handed to a person. */
  saysNothing?: boolean;
};

export type SimResult =
  | { ok: true; turn: SimTurn }
  | { ok: false; error: string };


/** Whether the simulator can run at all, and why not if it cannot. */
export async function simulatorStatus(): Promise<{ ready: boolean; reason?: string }> {
  await assertMessagingAccess();
  if (!agentAvailable()) {
    return { ready: false, reason: "No Anthropic API key is set on this environment, so the bot cannot be asked anything." };
  }
  const cfg = await agentConfigFor();
  if (!cfg) return { ready: false, reason: "No agent configuration has been seeded yet — run migration 185." };
  return { ready: true };
}

export async function runSimTurn(input: {
  workspaceId?: string;
  history: Turn[];
  customerText: string;
  /** The last thing the bot said asked the customer to PROVIDE something.
   *  Decides whether a reaction counts as an answer. */
  lastAskedForInfo?: boolean;
  /** Photos attached. No file is needed — what the bot reasons about is that
   *  photos EXIST, and normalizeInbound turns that into words. */
  mediaCount?: number;
  /** New lead, or following up a quote already sent. */
  track?: Track;
  /** How much of the required flow is already done. */
  stage?: number;
  /** What the bot said last, so a negative reaction is not answered with it. */
  lastIntent?: string;
  /** What the system already holds about this customer. Kate asked for this
   *  directly: Hatch let her fill a "Customer Data" section when sandbox
   *  testing, and without it the sandbox cannot reproduce the bug she is
   *  testing for — the bot asking for what it already has. */
  known?: KnownCustomer;
}): Promise<SimResult> {
  await assertMessagingAccess();
  const track: Track = input.track ?? "new_lead";
  // Both round trips at once. They were sequential, so every turn paid for the
  // config lookup and the corpus load one after the other before the model was
  // even asked anything.
  const inboundShape = normalizeInbound(input.customerText, input.mediaCount ?? 0);
  const [resolved, corpus, svc] = await Promise.all([
    agentConfigFor(input.workspaceId, track),
    loadRetrievalCorpus(),
    loadWorkspaceServices(input.workspaceId),
  ]);
  if (!resolved) {
    return { ok: false, error: track === "nurture"
      ? "No nurture configuration found — run migration 196 to seed it."
      : "No agent configuration found." };
  }

  // STOP / HELP are decided BEFORE the model is asked anything.
  //
  // Karan, 2026-09-08: "it's not following the opt-out rules." It was not,
  // and the reason is that opt-out lives in gatedSend, which the simulator is
  // forbidden to call — simulator-safety.test.ts exists to keep the sandbox
  // unable to reach a carrier. So the sandbox had no compliance behaviour at
  // all and cheerfully carried on past STOP.
  //
  // Reading the same pure classifier the live path reads costs nothing and
  // sends nothing. If it drifts from production behaviour, it drifts for both.
  const keyword = classifyInbound(input.customerText);
  if (keyword === "opt_out" || keyword === "help") {
    const ordinal = input.history.length + 1;
    return {
      ok: true,
      turn: {
        ordinal,
        customerText: input.customerText,
        intent: keyword === "opt_out" ? "opted_out" : "help",
        confidence: 1,
        // The carrier answers both of these. The bot must not add to it, and
        // must never send to this handset again.
        message: keyword === "opt_out"
          ? "(No reply is sent. The number is suppressed and nothing further can go out to it.)"
          : "(No reply is sent. The carrier answers HELP itself.)",
        escalate: false,
      },
    };
  }

  const res = await runAgentTurn(resolved.cfg, input.history, input.customerText, {
    hardNos: resolved.hardNos,
    lastAskedForInfo: input.lastAskedForInfo,
    mediaCount: input.mediaCount,
    track,
    known: input.known,
    services: resolveServices(svc.services, svc.exceptions),
    stage: input.stage,
    lastIntent: input.lastIntent,
    // The whole point of the corpus. Selected per turn, because which rule is
    // live depends on where the conversation has got to.
    examples: selectExamples(corpus, {
      stage: input.stage,
      track,
      // Which examples are worth showing depends on what the customer actually
      // sent, not only on how far the flow has got.
      // The CUSTOMER's own words, not the raw string.
      //
      // An iPhone reaction arrives as `Liked "<our message>"`, so scanning the
      // raw text reads OUR sentence and attributes it to them: a customer who
      // liked a message containing the phrase "real person" was recorded as
      // asking whether they were talking to a bot, and got examples about it.
      // normalizeInbound strips the wrapping; for a bare reaction there is no
      // text of their own, which is the correct thing to scan.
      ...situationFrom(inboundShape.text ?? (inboundShape.kind === "text" ? input.customerText : ""), {
        mediaCount: input.mediaCount,
        isReaction: inboundShape.kind === "reaction" || inboundShape.kind === "emoji_only",
        isNegative: inboundShape.reaction?.sentiment === "negative",
      }),
    }),
  });

  if (!res.ok) {
    return {
      ok: true,
      turn: {
        ordinal: input.history.length + 1,
        customerText: input.customerText,
        intent: null, confidence: null, message: "", escalate: true,
        error: res.error, rejected: res.rejected,
      },
    };
  }

  return {
    ok: true,
    turn: {
      ordinal: input.history.length + 1,
      customerText: input.customerText,
      intent: res.action.intent,
      confidence: res.action.confidence,
      message: res.rendered,
      escalate: res.escalate,
      droppedRapport: res.droppedRapport,
      saysNothing: res.saysNothing,
    },
  };
}

/** Persist a graded run so it can be replayed after a prompt change. */
export async function saveScenario(input: {
  name: string;
  customerBrief: string;
  tagKey?: string;
  workspaceId?: string;
  turns: (SimTurn & { verdict?: "good" | "acceptable" | "wrong"; verdictNote?: string; expectedIntent?: string })[];
}): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { data: scenario, error } = await sb.from("sms_scenarios").insert({
    name: input.name,
    customer_brief: input.customerBrief,
    tag_key: input.tagKey ?? null,
    workspace_id: input.workspaceId ?? null,
    // Only a run where every turn was judged acceptable becomes a test. A
    // scenario with a known-wrong turn is a bug report, not a baseline.
    is_regression_test: input.turns.length > 0 && input.turns.every((t) => t.verdict === "good" || t.verdict === "acceptable"),
  }).select().single();
  if (error) return { ok: false, error: error.message };

  const rows = input.turns.map((t) => ({
    scenario_id: scenario.id,
    ordinal: t.ordinal,
    customer_text: t.customerText,
    bot_intent: t.intent,
    bot_message: t.message,
    confidence: t.confidence,
    verdict: t.verdict ?? null,
    verdict_note: t.verdictNote ?? null,
    expected_intent: t.expectedIntent ?? null,
    graded_at: t.verdict ? new Date().toISOString() : null,
  }));
  const { error: turnErr } = await sb.from("sms_scenario_turns").insert(rows);
  if (turnErr) return { ok: false, error: turnErr.message };

  return { ok: true, id: scenario.id };
}
