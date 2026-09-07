import { describe, it, expect } from "vitest";
import {
  qualificationFunnel, workspaceHealth, speedSummary, agingConversations,
  takeoverBreakdown, median, percentile, humanSeconds, secondsBetween,
  HATCH_POLL_SECONDS, type ConversationRow,
} from "@/lib/messaging/metrics";

const conv = (over: Partial<ConversationRow> = {}): ConversationRow => ({
  workspace_name: "NY LI Nassau Leads",
  state: "ended", outcome: "lost", qualification_stage: 0,
  takeover_reason: null,
  created_at: "2026-09-07T10:00:00Z", ended_at: "2026-09-07T11:00:00Z",
  first_outbound_at: "2026-09-07T10:00:30Z", first_inbound_at: null,
  ...over,
});

describe("qualificationFunnel — the insight Hatch cannot give", () => {
  it("names the question people stop at", () => {
    // Ten leads. All answer the project question, only two give an address.
    // A success rate says "20%". This says "the address question loses 80%".
    const rows = [
      ...Array.from({ length: 8 }, () => conv({ qualification_stage: 1 })),
      ...Array.from({ length: 2 }, () => conv({ qualification_stage: 4 })),
    ];
    const f = qualificationFunnel(rows);
    expect(f[0]).toMatchObject({ label: "Project details", reached: 10, reachedPct: 100 });
    expect(f[1]).toMatchObject({ label: "Full address", reached: 2 });
    expect(f[1].droppedHerePct).toBe(80);
  });

  it("counts a stage as reached when the conversation went further", () => {
    // Stage 4 means all four were collected. Counting only exact matches would
    // report that nobody gave an address.
    const f = qualificationFunnel([conv({ qualification_stage: 4 })]);
    expect(f.every((s) => s.reached === 1)).toBe(true);
  });

  it("returns zeroes rather than NaN for no conversations", () => {
    const f = qualificationFunnel([]);
    expect(f).toHaveLength(4);
    expect(f.every((s) => s.reachedPct === 0 && !Number.isNaN(s.droppedHerePct))).toBe(true);
  });

  it("does not divide by zero when nobody reached the prior stage", () => {
    // Everyone leaves at stage 0. Stages 2-4 have an empty denominator.
    const f = qualificationFunnel([conv({ qualification_stage: 0 }), conv({ qualification_stage: 0 })]);
    expect(f.every((s) => Number.isFinite(s.droppedHerePct))).toBe(true);
  });
});

describe("workspaceHealth — matches Hatch, then says why", () => {
  it("reproduces Hatch's five measures", () => {
    const rows = [
      conv({ state: "ai_active" }),
      conv({ outcome: "success", qualification_stage: 4 }),
      conv({ outcome: "lost" }),
      conv({ outcome: "discard" }),
      conv({ outcome: "transferred", takeover_reason: "customer_asked_human" }),
    ];
    const [h] = workspaceHealth(rows);
    expect(h.active).toBe(1);
    expect(h.completed).toBe(4);
    expect(h.successPct).toBe(25);
    expect(h.dropOffPct).toBe(50);
    expect(h.takeOverPct).toBe(20);
  });

  it("names the worst stage, which is the actionable part", () => {
    const rows = [
      ...Array.from({ length: 9 }, () => conv({ qualification_stage: 1 })),
      conv({ qualification_stage: 4, outcome: "success" }),
    ];
    const [h] = workspaceHealth(rows);
    expect(h.worstStage?.label).toBe("Full address");
    expect(h.worstStage?.droppedPct).toBe(90);
  });

  it("uses the MEDIAN first reply, not the mean", () => {
    // One conversation that sat over a weekend drags a mean into uselessness
    // while the median still describes a normal lead.
    const rows = [
      conv({ created_at: "2026-09-07T10:00:00Z", first_outbound_at: "2026-09-07T10:00:30Z" }),
      conv({ created_at: "2026-09-07T10:00:00Z", first_outbound_at: "2026-09-07T10:00:40Z" }),
      conv({ created_at: "2026-09-07T10:00:00Z", first_outbound_at: "2026-09-09T10:00:00Z" }),
    ];
    const [h] = workspaceHealth(rows);
    expect(h.medianFirstReplySeconds).toBe(40);
  });

  it("splits by workspace and sorts by volume", () => {
    const rows = [
      conv({ workspace_name: "NY Queens Leads" }),
      conv({ workspace_name: "NJ Leads" }),
      conv({ workspace_name: "NJ Leads" }),
    ];
    const h = workspaceHealth(rows);
    expect(h.map((x) => x.workspace)).toEqual(["NJ Leads", "NY Queens Leads"]);
  });

  it("reports 0% rather than NaN when nothing has completed", () => {
    const [h] = workspaceHealth([conv({ state: "ai_active" })]);
    expect(h.successPct).toBe(0);
    expect(Number.isNaN(h.successPct)).toBe(false);
  });
});

describe("speedSummary — the number Hatch does not measure", () => {
  it("summarises against the one-minute target", () => {
    const s = speedSummary([10, 30, 45, 90, 120]);
    expect(s.measured).toBe(5);
    expect(s.medianSeconds).toBe(45);
    expect(s.withinTargetPct).toBe(60); // three of five under 60s
  });

  it("counts how many beat Hatch's 15-minute poll floor", () => {
    // 900s is the best Hatch can do even when everything else is instant.
    const s = speedSummary([60, 300, HATCH_POLL_SECONDS, 1200]);
    expect(s.beatingHatchPct).toBe(50);
  });

  it("ignores unmeasured conversations rather than counting them as instant", () => {
    // A null is a missing measurement. Treating it as 0 would report a
    // flattering median that nothing earned.
    const s = speedSummary([null, null, 100]);
    expect(s.measured).toBe(1);
    expect(s.medianSeconds).toBe(100);
  });

  it("returns nulls, not zeroes, when nothing is measured", () => {
    const s = speedSummary([]);
    expect(s.medianSeconds).toBeNull();
    expect(s.p90Seconds).toBeNull();
  });
});

describe("agingConversations — a number on a dashboard is not an alert", () => {
  const now = new Date("2026-09-07T12:00:00Z");
  const base = { id: "c1", workspace: "NJ Leads", state: "ai_active" };

  it("flags a customer waiting past the threshold", () => {
    const a = agingConversations(
      [{ ...base, lastInboundAt: "2026-09-07T11:00:00Z", lastOutboundAt: "2026-09-07T10:00:00Z" }],
      now, 30
    );
    expect(a).toHaveLength(1);
    expect(a[0].waitingSeconds).toBe(3600);
  });

  it("does NOT flag a conversation we already answered", () => {
    // Our reply came after theirs. Nobody is waiting.
    const a = agingConversations(
      [{ ...base, lastInboundAt: "2026-09-07T11:00:00Z", lastOutboundAt: "2026-09-07T11:05:00Z" }],
      now, 30
    );
    expect(a).toEqual([]);
  });

  it("does not flag an ended conversation", () => {
    const a = agingConversations(
      [{ ...base, state: "ended", lastInboundAt: "2026-09-07T09:00:00Z", lastOutboundAt: null }],
      now, 30
    );
    expect(a).toEqual([]);
  });

  it("does not flag one where the customer never spoke", () => {
    const a = agingConversations([{ ...base, lastInboundAt: null, lastOutboundAt: "2026-09-07T09:00:00Z" }], now, 30);
    expect(a).toEqual([]);
  });

  it("sorts longest-waiting first", () => {
    const a = agingConversations([
      { ...base, id: "new", lastInboundAt: "2026-09-07T11:00:00Z", lastOutboundAt: null },
      { ...base, id: "old", lastInboundAt: "2026-09-07T08:00:00Z", lastOutboundAt: null },
    ], now, 30);
    expect(a.map((x) => x.id)).toEqual(["old", "new"]);
  });
});

describe("takeoverBreakdown — a count becomes a to-do list", () => {
  it("ranks the reasons humans stepped in", () => {
    const rows = [
      conv({ takeover_reason: "language" }),
      conv({ takeover_reason: "language" }),
      conv({ takeover_reason: "pricing_pressure" }),
      conv({ takeover_reason: null }),
    ];
    const b = takeoverBreakdown(rows);
    expect(b[0]).toEqual({ reason: "language", count: 2, pct: 66.7 });
    expect(b).toHaveLength(2); // the untaken conversation is not a reason
  });

  it("returns nothing when nobody took over", () => {
    expect(takeoverBreakdown([conv()])).toEqual([]);
  });
});

describe("helpers", () => {
  it("median handles even and odd lengths, and empty", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3); // rounded from 2.5
    expect(median([])).toBeNull();
  });

  it("percentile never indexes past the end", () => {
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(percentile([1], 0.9)).toBe(1);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("secondsBetween clamps skew and rejects rubbish", () => {
    expect(secondsBetween("2026-09-07T10:00:00Z", "2026-09-07T10:00:30Z")).toBe(30);
    expect(secondsBetween("2026-09-07T10:00:30Z", "2026-09-07T10:00:00Z")).toBe(0);
    expect(secondsBetween("nope", "2026-09-07T10:00:00Z")).toBeNull();
    expect(secondsBetween(null, null)).toBeNull();
  });

  it("humanSeconds stays short enough for a column", () => {
    expect(humanSeconds(45)).toBe("45s");
    expect(humanSeconds(240)).toBe("4m");
    expect(humanSeconds(7800)).toBe("2h 10m");
    expect(humanSeconds(180000)).toBe("2d");
    expect(humanSeconds(null)).toBe("—");
  });
});
