import { describe, it, expect, afterEach, vi } from "vitest";
import { applyPipelineChipFilters } from "@/lib/commercial/opportunities/pipeline-filters";
import { computeLifecycle, proposalDueVerdict } from "@/lib/commercial/opportunities/lifecycle";
import { closeoutDocumentDate } from "@/lib/commercial/closeout/pdf";
import { workOrderDocumentDate } from "@/lib/commercial/work-orders/pdf";
import {
  invoiceDunningPrefilterCutoffIso,
  isInvoicePastDunningThreshold,
} from "@/lib/commercial/cron/invoice-dunning";
import { daysFromTodayEt } from "@/lib/date-et";

/**
 * Dates that are a DAY, measured as a day in New York.
 *
 * Every case here was a real off-by-one (audit F28 / F29 / F37, 2026-10-16):
 * a DATE column parsed as UTC midnight (8pm the evening before, in ET), a
 * timestamptz sliced to its UTC day (tomorrow, after 8pm ET), or a calendar
 * rule stated in elapsed hours. Vercel runs in UTC, so the clock is FAKED in
 * each test — the suite must say the same thing at 9am and at 11pm.
 */

afterEach(() => {
  vi.useRealTimers();
});

/** 9:30pm on Oct 16 in New York — already Oct 17 in UTC. */
const EVENING_ET = new Date("2026-10-17T01:30:00Z");

const opp = (over: Record<string, unknown>) => ({
  status: "proposal",
  updated_at: "2026-10-16T15:00:00Z",
  created_at: "2026-10-01T15:00:00Z",
  bid_value_high_cents: null as number | null,
  proposal_due_at: null as string | null,
  rfp_received_at: null as string | null,
  follow_up_at: null as string | null,
  ...over,
});

describe("pipeline chip filters — the board and its CSV export share these", () => {
  const today = "2026-10-16";

  it("a proposal due TODAY is not overdue; one due yesterday is", () => {
    const dueToday = opp({ proposal_due_at: "2026-10-16" });
    const dueYesterday = opp({ proposal_due_at: "2026-10-15" });
    expect(applyPipelineChipFilters([dueToday, dueYesterday], { overdue: true }, today)).toEqual([dueYesterday]);
  });

  it("the hot window includes today and the last day of the window", () => {
    const big = { bid_value_high_cents: 10_000_000 };
    const dueToday = opp({ ...big, proposal_due_at: "2026-10-16" });
    const dueYesterday = opp({ ...big, proposal_due_at: "2026-10-15" });
    const got = applyPipelineChipFilters([dueToday, dueYesterday], { hot: true }, today);
    expect(got).toEqual([dueToday]);
  });

  it("an RFP is cold after 7 whole days, not at 8pm on the 7th", () => {
    const seven = opp({ status: "qualifying", rfp_received_at: "2026-10-09" });
    const eight = opp({ status: "qualifying", rfp_received_at: "2026-10-08" });
    const got = applyPipelineChipFilters([seven, eight], { coldRfp: true }, today);
    expect(got).toEqual([eight]);
  });

  it("'new in 7 days' files a deal by the Eastern day it was entered", () => {
    // 01:30Z on Oct 9 is 9:30pm on Oct 8 in New York — outside a window
    // that starts Oct 9. Slicing the timestamp put it inside.
    const lateEvening = opp({ created_at: "2026-10-09T01:30:00Z" });
    const morning = opp({ created_at: "2026-10-09T13:00:00Z" });
    expect(applyPipelineChipFilters([lateEvening, morning], { newDays: 7 }, today)).toEqual([morning]);
  });

  it("stale counts Eastern days since the last touch", () => {
    const touched = opp({ updated_at: "2026-09-02T01:00:00Z" }); // Sep 1, 9pm ET
    expect(applyPipelineChipFilters([touched], { stale: true }, "2026-10-01").length).toBe(1);
    expect(applyPipelineChipFilters([touched], { stale: true }, "2026-09-02").length).toBe(0);
  });
});

describe("bid lifecycle — time to sale and the Due marker", () => {
  it("counts calendar days from a timestamptz send to a DATE close (the 4 live deals)", () => {
    // Values as measured on 2026-10-16. Each read one day short, or "—".
    const cases: Array<[string, string, number]> = [
      ["2026-10-07T18:16:21.126+00:00", "2026-10-13", 6],
      ["2026-10-07T18:40:09.422+00:00", "2026-10-07", 0],
      ["2026-10-07T18:59:57.291+00:00", "2026-10-13", 6],
      ["2026-10-07T19:07:49.725+00:00", "2026-10-07", 0],
    ];
    for (const [sent, decided, days] of cases) {
      const l = computeLifecycle({
        rfp_received_at: null,
        proposal_submitted_at: sent,
        proposal_due_at: null,
        decided_at: decided,
      });
      expect(l.time_to_sale_days).toBe(days);
    }
  });

  it("a send at 9:30pm ET is that day, not the next", () => {
    const l = computeLifecycle({
      rfp_received_at: "2026-10-16",
      proposal_submitted_at: "2026-10-17T01:30:00Z",
      proposal_due_at: null,
      decided_at: null,
    });
    expect(l.time_to_proposal_days).toBe(0);
  });

  it("a proposal sent ON its due day is on time, even in the evening", () => {
    const base = { proposal_due_at: "2026-10-07", decided_at: null };
    expect(proposalDueVerdict({ ...base, proposal_submitted_at: "2026-10-07T18:00:00Z" }, "2026-10-20")).toBe("on_time");
    expect(proposalDueVerdict({ ...base, proposal_submitted_at: "2026-10-08T01:30:00Z" }, "2026-10-20")).toBe("on_time");
    expect(proposalDueVerdict({ ...base, proposal_submitted_at: "2026-10-08T14:00:00Z" }, "2026-10-20")).toBe("late");
  });

  it("an unsent proposal is overdue only once its day has passed, and never once decided", () => {
    const unsent = { proposal_submitted_at: null, proposal_due_at: "2026-10-16", decided_at: null };
    expect(proposalDueVerdict(unsent, "2026-10-16")).toBeNull();
    expect(proposalDueVerdict(unsent, "2026-10-17")).toBe("overdue");
    expect(proposalDueVerdict({ ...unsent, decided_at: "2026-10-18" }, "2026-10-20")).toBeNull();
  });
});

describe("the account card's 'Bid due' and follow-up counts", () => {
  it("a bid due tomorrow reads 1 day at 9:30pm ET, and today's reads 0", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(EVENING_ET);
    expect(daysFromTodayEt("2026-10-17")).toBe(1);
    expect(daysFromTodayEt("2026-10-16")).toBe(0);
    expect(daysFromTodayEt("2026-10-15")).toBe(-1);
  });
});

describe("closeout and work-order PDFs print the Eastern day", () => {
  it("a TIMESTAMPTZ sent at 9:30pm ET prints that day, not tomorrow", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(EVENING_ET);
    const sent = EVENING_ET.toISOString();
    expect(closeoutDocumentDate({ sent_at: sent, created_at: "2026-10-01T15:00:00Z" })).toBe("October 16, 2026");
    expect(closeoutDocumentDate({ sent_at: null, created_at: sent })).toBe("October 16, 2026");
    expect(workOrderDocumentDate(sent)).toBe("October 16, 2026");
  });

  it("a date-only value prints as itself, not the day before (the 2026-08-19 direction)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(EVENING_ET);
    expect(closeoutDocumentDate({ sent_at: "2026-10-16", created_at: "2026-10-01T15:00:00Z" })).toBe("October 16, 2026");
    expect(workOrderDocumentDate("2026-10-16")).toBe("October 16, 2026");
  });

  it("a daytime timestamp is unaffected", () => {
    expect(workOrderDocumentDate("2026-10-16T15:00:00Z")).toBe("October 16, 2026");
  });
});

describe("invoice reminder fires on day 15, not day 16", () => {
  // The cron runs at 12:00 UTC; due dates are stored at noon ET (16:00Z).
  const CRON_RUN = new Date("2026-10-16T12:00:00Z");
  const fifteenDays = "2026-10-01T16:00:00+00:00";
  const fourteenDays = "2026-10-02T16:00:00+00:00";

  it("the query's bound lets the day-15 invoice through", () => {
    const cutoff = invoiceDunningPrefilterCutoffIso(CRON_RUN.getTime());
    expect(Date.parse(fifteenDays) < Date.parse(cutoff)).toBe(true);
  });

  it("the exact gate takes day 15 and holds day 14", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(CRON_RUN);
    expect(isInvoicePastDunningThreshold(fifteenDays)).toBe(true);
    expect(isInvoicePastDunningThreshold(fourteenDays)).toBe(false);
    expect(isInvoicePastDunningThreshold(null)).toBe(false);
  });
});
