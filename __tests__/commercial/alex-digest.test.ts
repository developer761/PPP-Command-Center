import { describe, it, expect } from "vitest";
import {
  digestWindow,
  renderDigestEmail,
  DIGEST_DEFAULTS,
  type DigestData,
} from "@/lib/commercial/reports/alex-digest";

/**
 * The recurring report to Alex.
 *
 * Two things are worth pinning above everything else: that it is OFF until a
 * person turns it on, and that the three cadences differ only in their window.
 * A daily and a weekly that drift into different definitions of "collected"
 * would be reconciled against each other and cost trust in both.
 */

function data(over: Partial<DigestData> = {}): DigestData {
  return {
    cadence: "daily",
    windowLabel: "today",
    fromYmd: "2026-08-19",
    toYmd: "2026-08-19",
    outstandingCents: 5_006_88,
    collectibleCents: 4_764_38,
    overdueCents: 0,
    retainageCents: 242_50,
    openItemCount: 3,
    briefText: null,
    briefStale: false,
    inCents: 0,
    outCents: 0,
    netCents: 0,
    txnCount: 0,
    undepositedCents: 0,
    undepositedCount: 0,
    taxCollectedCents: 0,
    uncertifiedCount: 0,
    reimbursementsOwedCents: 0,
    reimbursementsOwedCount: 0,
    readyToBillCents: 0,
    overBilledProjects: 0,
    ...over,
  };
}

describe("it ships off", () => {
  it("no cadence is enabled by default", () => {
    // A recurring report to the CEO is not something to switch on and then
    // start checking.
    expect(DIGEST_DEFAULTS).toEqual({ daily: false, weekly: false, monthly: false });
  });
});

describe("digestWindow", () => {
  it("daily is today", () => {
    expect(digestWindow("daily", "2026-08-19")).toMatchObject({
      fromYmd: "2026-08-19",
      toYmd: "2026-08-19",
    });
  });

  it("weekly runs Monday-to-today, the same week payroll uses", () => {
    // 2026-08-19 is a Wednesday; the Monday is the 17th. Two definitions of
    // "this week" in one platform is how a Sunday shift lands in different
    // weeks on different screens.
    expect(digestWindow("weekly", "2026-08-19")).toMatchObject({
      fromYmd: "2026-08-17",
      toYmd: "2026-08-19",
    });
  });

  it("monthly starts on the 1st", () => {
    expect(digestWindow("monthly", "2026-08-19")).toMatchObject({
      fromYmd: "2026-08-01",
      toYmd: "2026-08-19",
    });
  });

  it("a week that starts on a Sunday still anchors to Monday", () => {
    // Sunday 2026-08-23 belongs to the week beginning Monday the 17th.
    expect(digestWindow("weekly", "2026-08-23").fromYmd).toBe("2026-08-17");
  });
});

describe("renderDigestEmail", () => {
  it("leads the subject with the number he opens it for", () => {
    const { subject } = renderDigestEmail(data());
    expect(subject).toContain("Daily");
    expect(subject).toContain("$5,006.88 outstanding");
  });

  it("says in the subject when something is late", () => {
    const { subject } = renderDigestEmail(data({ overdueCents: 1_500_00 }));
    expect(subject).toContain("$1,500.00 late");
  });

  // A digest that says the same eight things every morning stops being read.
  it("raises only what actually needs attention", () => {
    const quiet = renderDigestEmail(data());
    expect(quiet.text).not.toContain("WORTH A LOOK");
    expect(quiet.html).toContain("Nothing needs attention");

    const noisy = renderDigestEmail(
      data({
        overdueCents: 1_000_00,
        undepositedCents: 2_000_00,
        undepositedCount: 2,
        readyToBillCents: 30_000_00,
        uncertifiedCount: 1,
      })
    );
    expect(noisy.text).toContain("WORTH A LOOK");
    expect(noisy.text).toContain("past due");
    expect(noisy.text).toContain("not deposited");
    expect(noisy.text).toContain("earned and not yet billed");
    expect(noisy.text).toContain("no certificate on file");
  });

  it("labels the period figures with the window they cover", () => {
    const weekly = renderDigestEmail(data({ cadence: "weekly", windowLabel: "this week", inCents: 40_000_00 }));
    expect(weekly.text).toContain("MONEY THIS WEEK");
    expect(weekly.html).toContain("In this week");
  });

  it("carries the brief when one has been written, and says when it's old", () => {
    const fresh = renderDigestEmail(data({ briefText: "Two GCs hold 80% of it." }));
    expect(fresh.text).toContain("Two GCs hold 80% of it.");
    expect(fresh.html).not.toContain("Written before the latest changes");

    const stale = renderDigestEmail(data({ briefText: "Old read.", briefStale: true }));
    expect(stale.html).toContain("Written before the latest changes");
  });

  it("escapes the brief — it is model output landing in an inbox", () => {
    const { html } = renderDigestEmail(data({ briefText: '<script>alert("x")</script>' }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
