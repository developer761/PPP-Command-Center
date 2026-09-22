import { describe, it, expect } from "vitest";
import { stageForIntent } from "@/lib/messaging/stage";
import { stageFromIntents, FLOW_ORDER } from "@/lib/messaging/agent-output";
import { qualificationFunnel } from "@/lib/messaging/metrics";

/**
 * The funnel read 0 at every stage and rendered -100% at stage one, which says
 * every customer drops at the first question. qualification_stage has existed
 * since migration 193 and nothing has ever written it.
 */
describe("the stage a single intent implies", () => {
  it("is zero for an intent that is not a step in the flow", () => {
    expect(stageForIntent("bailout")).toBe(0);
    expect(stageForIntent("answer_question")).toBe(0);
  });

  it("is zero for nothing at all, rather than throwing", () => {
    expect(stageForIntent(null)).toBe(0);
    expect(stageForIntent(undefined)).toBe(0);
    expect(stageForIntent("")).toBe(0);
  });

  it("agrees with stageFromIntents on a single intent", () => {
    // Two ways of asking the same question must not drift: bumpStage takes the
    // greater of the stored value and this, which is equivalent to recomputing
    // the whole history only while these agree.
    for (const intent of FLOW_ORDER.flat()) {
      expect(stageForIntent(intent), intent).toBe(stageFromIntents([intent]));
    }
  });

  it("moves forward one step per group of the flow", () => {
    // FLOW_ORDER is groups — asking for the address and confirming it are the
    // same step — so the stage rises per GROUP, not per intent.
    const perGroup = FLOW_ORDER.map((g) => stageForIntent(g[0]));
    for (let i = 1; i < perGroup.length; i++) {
      expect(perGroup[i], String(FLOW_ORDER[i])).toBeGreaterThan(perGroup[i - 1]);
    }
    expect(perGroup[0]).toBe(1);
  });

  it("puts an ask and its confirm on the same step", () => {
    // "Ask for the address" and "read the address back" are one stage, so a
    // conversation that confirms rather than asks is not counted as further on.
    for (const group of FLOW_ORDER) {
      const stages = group.map((i) => stageForIntent(i));
      expect(new Set(stages).size, String(group)).toBe(1);
    }
  });
});

/**
 * What the report actually renders. These are the numbers Karan reads.
 */
describe("the funnel, once stages are recorded", () => {
  const rows = (stages: number[]) =>
    stages.map((qualification_stage, i) => ({
      id: `c${i}`, state: "ended", outcome: "success", qualification_stage,
      takeover_reason: null, created_at: "2026-09-22T12:00:00Z", ended_at: null,
      first_outbound_at: null, first_inbound_at: null, last_message_at: null,
      campaign_version_id: null,
    })) as unknown as Parameters<typeof qualificationFunnel>[0];

  it("no longer says everybody drops at the first question", () => {
    // The live shape before this: every row at stage 0.
    const broken = qualificationFunnel(rows([0, 0, 0, 0]));
    expect(broken[0].reached).toBe(0);
    expect(broken[0].droppedHerePct).toBe(100);

    // With stages actually written, the report describes the conversations.
    const real = qualificationFunnel(rows([1, 2, 2, 3]));
    expect(real[0].reached).toBe(4);
    expect(real[0].droppedHerePct).toBe(0);
  });

  it("counts everyone who got at least this far", () => {
    const f = qualificationFunnel(rows([1, 2, 3]));
    expect(f[0].reached).toBe(3);
    expect(f[1].reached).toBe(2);
    expect(f[2].reached).toBe(1);
  });

  it("names where people actually stop", () => {
    // Three of four reached stage 1, and two of those went no further.
    const f = qualificationFunnel(rows([1, 1, 2, 0]));
    expect(f[1].reached).toBe(1);
    expect(f[1].droppedHerePct).toBeGreaterThan(0);
  });
});
