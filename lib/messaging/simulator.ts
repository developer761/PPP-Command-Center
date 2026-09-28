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
import { officeIsOpen } from "./sending-window";
import { classifyInbound } from "./compliance";
import { selectExamples, situationFrom } from "./retrieval";
import { resolveServices } from "./services";
import { agentConfigFor } from "./agent-config-for";
import { normalizeInbound } from "./inbound-normalize";
import { knownFromThread } from "./known-from-thread";
import { loadRetrievalCorpus, loadWorkspaceServices } from "./db";
import type { Track } from "./agent-output";
import type { KnownCustomer } from "./known-customer";
import { runAgentTurn, agentAvailable, type Turn } from "./agent-run";
import { forPrompt } from "./class-a-rules";
import { loadClassARules } from "./class-a-rules-db";
import { loadWorkspaceFaqs } from "./workspace-faq-db";
import { faqsForPrompt } from "./workspace-faq";
import { addressParts } from "./address";
import { serviceZipCheck } from "./service-zip";
import { customerZone } from "./customer-clock";
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
  /**
   * Every intent this conversation has used, oldest first.
   *
   * THE STAGE IS NOT A SUBSTITUTE FOR THIS, which is why the sandbox let a
   * close through that production refuses. `stage` is a number and answers
   * "how far along are we"; four guards in validateAction ask a different
   * question — "what was actually asked and confirmed" — and every one of
   * them is written `if (ctx.priorIntents && ...)`, so an absent field skips
   * the check rather than failing it:
   *
   *   A3 legs      `success` when a step was never asked for at all
   *   the record   `success` holding nothing, after a customer answered "ok"
   *                to all four questions
   *   A4           `success` on "Weekdays are better" — a day with no window,
   *                which Kate says is NOT availability collected
   *   A40          closing the conversation over a field the customer parked
   *
   * Seen 2026-09-28 in the sandbox: the full onsite flow, then "Weekdays are
   * better", and the bot replied "Perfect, you're all set. Someone from the
   * office will confirm the details with you." Production refuses that turn.
   * The sandbox is where Kate and Karan GRADE the bot, so it was showing them
   * a more permissive bot than the one that ships — and a reply marked "Good"
   * there becomes an example the next model imitates.
   *
   * The caller already has the array: the panel renders an intent chip per
   * turn and collapses the same list into `stage` on the line above.
   */
  priorIntents?: readonly string[];
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
  const [resolved, corpus, svc, faqs] = await Promise.all([
    agentConfigFor(input.workspaceId, track),
    loadRetrievalCorpus(),
    loadWorkspaceServices(input.workspaceId),
    /**
     * Parity gap 9: this workspace's standing answers.
     *
     * scheduler-db loads these every live turn and the sandbox loaded none, so
     * the FAQ store could not be exercised in the one screen built for
     * exercising the bot: a workspace could have an answer configured, the
     * tester could ask the exact question it answers, and the sandbox would
     * escalate — while production answers it.
     *
     * Only when a workspace is actually selected. "All workspaces" is a
     * sandbox-only state with no counterpart in production, and standing
     * answers belong to one workspace; loading nothing there is correct rather
     * than a gap.
     */
    input.workspaceId ? loadWorkspaceFaqs(messagingDb(), input.workspaceId) : Promise.resolve([]),
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

  /**
   * THE SAME STAGE THE LIVE PATH WOULD COMPUTE.
   *
   * The stage arriving here is stageFromIntents over the BOT's past intents,
   * so on turn one it is 0 whatever the customer said. The live path does not
   * stop there — it raises the floor when the customer has already described
   * the job, because that step is done and only the bookkeeping disagrees.
   *
   * Without this, a customer opening with "I need my living room and hallway
   * painted, about 600 sq ft, walls and ceilings" gets their next step
   * refused here as out_of_order while production answers it. That is the
   * sandbox lying to the person using it to decide whether the bot works —
   * the exact failure the comment below already warns about twice.
   *
   * Scope is read from the customer's OWN words: a reaction arrives as
   * `Liked "<our message>"` and would otherwise resolve our sentence as their
   * project.
   */
  // The SAME derivation the live path runs. See known-from-thread.ts: these
  // two drifted apart four times in a day before it existed.
  const derived = knownFromThread({
    onFile: { inquiryScope: input.known?.inquiryScope, address: input.known?.address },
    messages: [
      ...input.history.filter((t) => t.role === "customer").map((t) => ({ body: t.text })),
      { body: input.customerText, mediaCount: input.mediaCount ?? 0 },
    ],
    stage: input.stage ?? 0,
  });
  const stage = derived.stage;
  const resolvedScope = derived.inquiryScope;
  const saidAddress = derived.address;

  /**
   * A2, WHICH THE SANDBOX COULD NOT TEST AT ALL.
   *
   * scheduler-db re-runs the zip check every live turn and passes the verdict;
   * nothing passed it here, so `serviceArea` was permanently null and every
   * rule hanging off it was inert in the one screen built to exercise them:
   *
   *   - the guard that refuses `area_not_serviced` when the zip IS serviced
   *     never fired, so the sandbox could show a tester the bot turning away a
   *     customer we cover — a reply production refuses to send;
   *   - the out-of-state message had no state to name, so A2's second script
   *     could not be checked;
   *   - `needs_a_person` — an unreadable map — could not be reproduced.
   *
   * Read from the address we hold, which is the record's when there is one and
   * the thread's otherwise, exactly as the rest of this function resolves it.
   * Only when a zip is actually present: production leaves the verdict null
   * when the conversation carries no zip, and a bare serviceZipCheck(null)
   * answers "needs_a_person", which would hand over conversations that should
   * simply carry on asking.
   */
  const heldZip = addressParts(input.known?.address || saidAddress).zip;
  const service = heldZip ? await serviceZipCheck(messagingDb(), heldZip) : null;

  const res = await runAgentTurn(resolved.cfg, input.history, input.customerText, {
    hardNos: resolved.hardNos,
    /**
     * A46, WHICH COULD NOT FIRE HERE AT ALL.
     *
     * scheduler-db passes `outOfHours: !officeIsOpen(...)`, and this passed
     * nothing — so disclosureMove always saw `false` and the out-of-hours
     * PREFIX never appeared in the sandbox. Checked at 10 PM Eastern with the
     * office shut: the simulator replied "Got it! What's the address for the
     * project?" where production would have led with "I'm an AI assistant, but
     * I can take your project details and pass them along once we open."
     *
     * Approved compliance copy, invisible in the one screen somebody would
     * use to check it — and the same divergence this file's own header warns
     * about twice: "a bot that behaves differently in the sandbox than in
     * production is a bot nobody has actually tested."
     *
     * The office zone is left at A36's default, which is Eastern because that
     * is where PPP's office sits, and every workspace currently runs on
     * America/New_York (Settings). A workspace in another zone would need its
     * time_zone threaded here, and that is one more round trip than this is
     * worth until one exists.
     */
    outOfHours: !officeIsOpen({ now: new Date() }),
    // THE SAME RULES THE LIVE PATH GETS. A bot that behaves differently in the
    // sandbox than in production is a bot nobody has actually tested, and this
    // file already carries that lesson twice.
    classARules: forPrompt(await loadClassARules()),
    // Parity gap 9: the same standing answers the live path gets.
    workspaceFaqs: faqsForPrompt(faqs),
    lastAskedForInfo: input.lastAskedForInfo,
    mediaCount: input.mediaCount,
    track,
    // THE RESOLVED SCOPE, NOT JUST THE PANEL, which is what the live path
    // passes (scheduler-db: `inquiryScope: resolved.scope`). Without it the
    // simulator renders as though nothing is known about the job even when
    // the customer just described it, and the turns that can only speak when
    // there IS a scope — confirm_scope, and the discard that turns work down
    // in words — came out silent here and talk in production.
    known: {
      ...input.known,
      inquiryScope: input.known?.inquiryScope || resolvedScope || undefined,
      // AND THE ADDRESS, for the same reason and the fourth time this file
      // has needed it. scheduler-db captures an address the customer typed
      // and persists it on the conversation; nothing did that here, so the
      // sandbox kept refusing the turn as commitment_in_free_text while
      // production went on to confirm the address.
      //
      // Read across the whole thread, not just this message: production reads
      // it from the conversation row, which remembers.
      address: input.known?.address || saidAddress || undefined,
    },
    services: resolveServices(svc.services, svc.exceptions),
    stage,
    // The ORDER and the CLOSE are two different rules and need two different
    // fields. `stage` above enforces the first; this enforces the second.
    priorIntents: input.priorIntents,
    // The project-details leg, for the customer who described the job
    // themselves. The same derivation the live path runs. See A3_LEGS.
    scopeFromCustomer: derived.scopeFrom === "customer",
    lastIntent: input.lastIntent,
    // A2's verdict, and the two fields its out-of-state script needs to name
    // where they actually are. See the block above.
    serviceArea: service?.outcome ?? null,
    zip: heldZip,
    stateName: service?.outcome === "out_of_state" ? service.state : null,
    /**
     * THE CUSTOMER'S CLOCK, for the week-aware availability ask.
     *
     * agent-run: "the day-dependent availability ask needs to know which side
     * of the CUSTOMER's Thursday we are on. Without both of these it falls
     * back to the generic wording" — so an absent zone did not fail, it
     * quietly rendered a different sentence than production would. The same
     * field, missing in the same way, already hid a wording bug in the
     * scenario harness.
     *
     * Resolved from the handset the tester filled in, and customerZone falls
     * back on its own when there is none, so this is safe with an empty panel.
     */
    customerZone: customerZone({ phone: input.known?.phone ?? null }).timeZone,
    // The whole point of the corpus. Selected per turn, because which rule is
    // live depends on where the conversation has got to.
    examples: selectExamples(corpus, {
      stage,
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
