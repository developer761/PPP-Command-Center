import { describe, it, expect } from "vitest";
import {
  qualificationFunnel, workspaceHealth, speedSummary, agingConversations,
  takeoverBreakdown, median, percentile, humanSeconds, secondsBetween,
  wasContained, wasBookableByPhone, wasBookableInPerson, wasBooked, HANDED_TO_A_PERSON,
  HATCH_POLL_SECONDS, MIN_MEASURED, agentPerformance, type ConversationRow,
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

/**
 * A FINDING NEEDS ENOUGH CONVERSATIONS TO BE ONE.
 *
 * The reporting screen printed "Most stop at project details — 100% of those
 * who got that far" for TEN workspaces at once, each computed from a single
 * conversation. Ten of those in a column reads as a systemic problem at the
 * first question, and there is no problem — there is one conversation each.
 *
 * The funnel already carries its own n for exactly this reason, and says so in
 * a comment: "'−100%' off ONE conversation was being shown in the same red as
 * a real funnel collapse." The per-workspace line is the one PHRASED as a
 * finding, and it was the one without the n.
 */
describe("the per-workspace summary carries its sample size", () => {
  const row = (workspace: string, stage: number) => ({
    workspace_name: workspace, state: "ended", outcome: "lost",
    takeover_reason: null, created_at: "2026-09-01T12:00:00Z",
    first_outbound_at: "2026-09-01T12:00:10Z", stage,
  });

  it("reports how many conversations each row is computed from", () => {
    const health = workspaceHealth([row("NY NYC Leads", 1)] as never);
    expect(health[0].measured).toBe(1);
  });

  it("counts every conversation in the workspace, not only the ended ones", () => {
    const health = workspaceHealth([
      row("NY NYC Leads", 1),
      { ...row("NY NYC Leads", 1), state: "active" },
    ] as never);
    expect(health[0].measured).toBe(2);
  });

  it("is below the floor that lets the screen call something a pattern", () => {
    // The screen phrases it as a finding only at or above MIN_MEASURED.
    expect(MIN_MEASURED).toBeGreaterThan(1);
    const health = workspaceHealth([row("NY NYC Leads", 1)] as never);
    expect(health[0].measured).toBeLessThan(MIN_MEASURED);
  });
});

/**
 * ── CONTAINMENT AND BOOKABLE-TO-BOOKED ──────────────────────────────────
 *
 * Hatch names both and populates neither — on 2026-09-26 every row showed
 * "–". So there is no implementation to match and the definitions are ours,
 * which is the reason they are pinned here rather than left to a SQL string
 * somebody rewrites in six months.
 */
describe("containment — finished with no person needed", () => {
  it("counts a conversation the bot finished alone", () => {
    expect(wasContained(conv({ state: "ended", outcome: "success" }))).toBe(true);
  });

  it("does not count one still running", () => {
    // Not contained AND not un-contained yet. Counting it either way moves
    // the number every time somebody refreshes the page.
    expect(wasContained(conv({ state: "ai_active", outcome: null }))).toBe(false);
  });

  it("does not count one a person took over", () => {
    expect(wasContained(conv({ outcome: "success", takeover_reason: "customer asked for a person" })))
      .toBe(false);
  });

  /**
   * THE ONE A NAIVE DEFINITION GETS WRONG.
   *
   * `takeover_reason` alone is not enough: a conversation can end
   * `transferred` or `bailout` with no takeover row ever written — the bot
   * decided it could not finish and handed on. Counting those as contained
   * reports the bot handling work it explicitly refused, which is the exact
   * opposite of what the metric is for.
   */
  it.each([...HANDED_TO_A_PERSON])(
    "does not count %j, even with no takeover recorded", (outcome) => {
      expect(wasContained(conv({ state: "ended", outcome, takeover_reason: null }))).toBe(false);
    }
  );

  it("reports it per workspace against FINISHED conversations only", () => {
    const [h] = workspaceHealth([
      conv({ state: "ended", outcome: "success" }),
      conv({ state: "ended", outcome: "success" }),
      conv({ state: "ended", outcome: "transferred" }),
      conv({ state: "ended", outcome: "lost", takeover_reason: "angry" }),
      // Still open — must not be in the denominator.
      conv({ state: "ai_active", outcome: null, ended_at: null }),
    ]);
    expect(h.containmentOf).toBe(4);
    expect(h.containmentPct).toBe(50);
  });

  it("shows nothing rather than 0% when nothing has finished", () => {
    const [h] = workspaceHealth([conv({ state: "ai_active", outcome: null, ended_at: null })]);
    expect(h.containmentOf).toBe(0);
  });
});

describe("bookable to booked — conversion where booking was possible", () => {
  /**
   * KATE SPLIT THIS ON 2026-10-05, and the split is the point:
   *
   *   "Bookable phone pricing = scope, address, contact = confirmed.
   *    Availability is needed to consider an in-person bookable."
   *
   * A lead holding scope, address and contact is already sellable — an
   * estimator can ring them and price it. Measuring everything against the
   * availability bar counted those as failures to book.
   */
  it("in-person needs availability, stage 4", () => {
    expect(wasBookableInPerson(conv({ qualification_stage: 4 }))).toBe(true);
    expect(wasBookableInPerson(conv({ qualification_stage: 3 }))).toBe(false);
  });

  it("phone pricing needs only scope, address and contact, stage 3", () => {
    expect(wasBookableByPhone(conv({ qualification_stage: 3 }))).toBe(true);
    expect(wasBookableByPhone(conv({ qualification_stage: 2 }))).toBe(false);
  });

  it("anything bookable in person is bookable by phone, never the reverse", () => {
    for (const stage of [0, 1, 2, 3, 4]) {
      const r = conv({ qualification_stage: stage });
      if (wasBookableInPerson(r)) expect(wasBookableByPhone(r), `stage ${stage}`).toBe(true);
    }
    expect(wasBookableByPhone(conv({ qualification_stage: 3 }))).toBe(true);
    expect(wasBookableInPerson(conv({ qualification_stage: 3 }))).toBe(false);
  });

  it("treats only a success as booked", () => {
    expect(wasBooked(conv({ outcome: "success" }))).toBe(true);
    expect(wasBooked(conv({ outcome: "schedule_follow_up" }))).toBe(false);
  });

  it("measures against those who got that far, not against everybody", () => {
    /**
     * The distinction the whole module exists for. Eight leads never answered
     * the address question; two reached availability and one booked. Against
     * all ten that is 10% and reads as a booking problem. Against the two who
     * could have booked it is 50%, and the real problem is the address.
     */
    const [h] = workspaceHealth([
      ...Array.from({ length: 8 }, () => conv({ qualification_stage: 1, outcome: "lost" })),
      conv({ qualification_stage: 4, outcome: "success" }),
      conv({ qualification_stage: 4, outcome: "lost" }),
    ]);
    expect(h.bookableOf).toBe(2);
    expect(h.bookableToBookedPct).toBe(50);
  });

  it("is NULL, not 0, when nobody got far enough to book", () => {
    // "Nobody converts" and "nobody was asked" are the same figure and
    // different problems.
    const [h] = workspaceHealth([conv({ qualification_stage: 1, outcome: "lost" })]);
    expect(h.bookableToBookedPct).toBeNull();
    expect(h.bookableOf).toBe(0);
  });
});

/**
 * TWO SCREENS, TWO ANSWERS, ONE WORD.
 *
 * "Success" on /messaging/dashboard counted `success` or `phone_pricing`;
 * "Success" on /messaging/reporting counted `success` alone. The same
 * conversations, two numbers, neither screen saying which it meant — and
 * db.ts carries the note recording that this exact disagreement was found and
 * fixed once already: "success excluded phone_pricing, which PPP's own end
 * states define as a success." That fix replaced the dashboard's copy and
 * left the other one.
 *
 * Asserted through the two functions the screens actually call, rather than
 * on the constants, because a shared constant that one of them stops using is
 * the same bug again.
 */
describe("both screens answer 'success' the same way", () => {
  const ended = (outcome: string, agent = "lead_nurture") => ({
    id: `c-${outcome}-${Math.random()}`, state: "ended", outcome, agent,
    workspace: "NY LI Nassau Leads", takeover_reason: null,
    created_at: "2026-10-01T12:00:00Z", first_outbound_at: "2026-10-01T12:01:00Z",
    last_message_at: "2026-10-01T12:30:00Z", stage: 4,
  });

  it("counts a phone-pricing exit as a success on both", () => {
    const rows = [ended("success"), ended("phone_pricing"), ended("lost")] as never[];
    const health = workspaceHealth(rows)[0];
    const agents = agentPerformance(rows)[0];
    expect(health.successPct).toBe(agents.successPct);
    // Two of three ended well. pct() keeps one decimal.
    expect(health.successPct).toBe(66.7);
  });

  it("counts a drop-off the same way on both", () => {
    const rows = [ended("success"), ended("bailout"), ended("area_not_serviced")] as never[];
    const health = workspaceHealth(rows)[0];
    const agents = agentPerformance(rows)[0];
    expect(health.dropOffPct).toBe(agents.dropOffPct);
    expect(health.dropOffPct).toBe(66.7);
  });
});
