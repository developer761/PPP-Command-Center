import { describe, it, expect } from "vitest";
import {
  digestDueToday,
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
  topGcName: null,
    topGcCents: 0,
    topGcPct: 0,
    over90Cents: 0,
    over90Count: 0,
    oldestDays: 0,
    oldestName: null,
  pnl: { grossRevenueCents: 0, totalCostCents: 0, crewLaborCents: 0, netProfitCents: 0, marginPct: null, unratedHours: 0 },
    ar: [],
    arTotalCents: 0,
    arRetentionCents: 0,

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
  it("the owed band says four DIFFERENT things", () => {
    /**
     * The bug Karan hit reading a preview: Outstanding, Collectible now and
     * Past due all printed $1,369,044.37. On this book no retention is held
     * and every imported invoice carries Salesforce's "Upon Receipt" terms, so
     * those three are one number — three quarters of the band spent saying it
     * once. A total, a concentration, an age bucket and a worst case instead.
     */
    const { html } = renderDigestEmail(
      data({
        outstandingCents: 1_369_044_37,
        overdueCents: 1_369_044_37,
        collectibleCents: 1_369_044_37,
        retainageCents: 0,
        openItemCount: 35,
        topGcName: "LMJ Management",
        topGcCents: 1_134_798_61,
        topGcPct: 83,
        over90Cents: 916_847_86,
        over90Count: 19,
        oldestDays: 381,
        oldestName: "5150 Veterans",
      })
    );
    const band = html.slice(html.indexOf("What we are owed"), html.indexOf("Money "));
    const figures = [...band.matchAll(/font-size:19px[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(figures).toHaveLength(4);
    expect(new Set(figures).size, `the band repeats a figure: ${figures.join(" / ")}`).toBe(4);
    expect(band).toContain("LMJ Management");
    expect(band).toContain("381 days");
    // The dead tiles are gone: retention at zero no longer buys a quarter.
    expect(band).not.toContain("Retention held");
    expect(band).not.toContain("Collectible now");
  });

  it("does not spend a tile on a zero", () => {
    const none = renderDigestEmail(data({ undepositedCount: 0, undepositedCents: 0, readyToBillCents: 5_000_00 }));
    expect(none.html).not.toContain("Not deposited");
    // One phrase platform-wide, so the email and the screen name it the same.
    expect(none.html).toContain("Won, not invoiced");

    const some = renderDigestEmail(data({ undepositedCount: 2, undepositedCents: 2_000_00 }));
    expect(some.html).toContain("Not deposited");
  });

  it("labels the period figures with the window they cover", () => {
    const weekly = renderDigestEmail(data({ cadence: "weekly", windowLabel: "this week", inCents: 40_000_00 }));
    expect(weekly.text).toContain("MONEY THIS WEEK");
    // The window is on the heading now, not repeated on every tile.
    expect(weekly.html).toContain("Money this week");
  });

  it("carries the AR sheet, grouped by job", () => {
    const { html, text } = renderDigestEmail(
      data({
        ar: [
          { jobName: "LMJ - Duct Patches", label: "Retention", openCents: 75_00, isRetention: true },
          { jobName: "LMJ - Duct Patches", label: "AIA#4", openCents: 550_00, isRetention: false },
          { jobName: "O'Shea Properties", label: "9/3/26 - invoiced", openCents: 2_500_00, isRetention: false },
        ],
        arTotalCents: 3_125_00,
        arRetentionCents: 75_00,
      })
    );
    expect(html).toContain("AR sheet");
    expect(html).toContain("LMJ - Duct Patches");
    expect(html).toContain("Subtotal (2)");
    expect(html).toContain("Total (3)");
    expect(text).toContain("AR SHEET");
  });

  it("the html closes every tag it opens, in order", () => {
    /**
     * The AR sheet used to be bolted on with `html.replace("</div>", ...)`,
     * which replaces the FIRST closing div, not the last. So the whole section
     * was injected into the middle of the document and the nesting broke —
     * Alex's actual inbox showed the AR heading drawn on top of the report
     * title, and the table overlapping the figures. Every unit test passed:
     * the strings were all present, just in the wrong place.
     */
    const { html } = renderDigestEmail(
      data({
        ar: [{ jobName: "A job", label: "AIA#1", openCents: 100, isRetention: false }],
        arTotalCents: 100,
      })
    );
    const stack: string[] = [];
    for (const m of html.matchAll(/<(\/?)(div|table|tr|td|th|p|a|ul|li)\b[^>]*?(\/?)>/g)) {
      const [, closing, tag, selfClose] = m;
      if (selfClose) continue;
      if (closing) {
        expect(stack.pop(), `</${tag}> with nothing open`).toBe(tag);
      } else {
        stack.push(tag);
      }
    }
    expect(stack, `tags left open: ${stack.join(", ")}`).toEqual([]);
  });

  it("puts the AR sheet AFTER the figures, not through them", () => {
    const { html } = renderDigestEmail(
      data({ ar: [{ jobName: "A job", label: "AIA#1", openCents: 100, isRetention: false }], arTotalCents: 100 })
    );
    expect(html.indexOf("Are we making money?")).toBeLessThan(html.indexOf("What we are owed"));
    expect(html.indexOf("What we are owed")).toBeLessThan(html.indexOf("AR sheet"));
    expect(html.indexOf("AR sheet")).toBeLessThan(html.indexOf("PPP Commercial Command Center"));
  });

  it("escapes what it prints — the AR sheet carries names people typed", () => {
    // The brief used to be the untrusted text in here and is gone; the job and
    // application labels are now the user-supplied strings landing in an inbox.
    const { html } = renderDigestEmail(
      data({
        ar: [{ jobName: '<script>alert("x")</script>', label: "ok", openCents: 100, isRetention: false }],
        arTotalCents: 100,
      })
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

});

/**
 * ONE email a day, whichever cadences fall due.
 *
 * With all three switched on the naive rule sent two every Monday, two on the
 * 1st, and three on a Monday that was the 1st — a minute apart, all carrying
 * identical outstanding / collectible / past-due / retention figures. That is
 * how a recurring report stops being read.
 */
describe("digestDueToday", () => {
  const all = { daily: true, weekly: true, monthly: true };
  const WED = "2026-08-19";        // Wednesday
  const MON = "2026-08-17";        // Monday
  const FIRST = "2026-09-01";      // a 1st that isn't a Monday
  const MON_FIRST = "2027-02-01";  // a Monday that IS the 1st

  it("an ordinary day sends the daily", () => {
    expect(digestDueToday(all, WED)).toBe("daily");
  });

  it("a Monday sends ONE email, not two", () => {
    expect(digestDueToday(all, MON)).toBe("weekly");
  });

  it("the 1st sends ONE, not two", () => {
    expect(digestDueToday(all, FIRST)).toBe("monthly");
  });

  it("a Monday that is the 1st sends ONE, not three", () => {
    expect(digestDueToday(all, MON_FIRST)).toBe("monthly");
  });

  it("the longest window wins because it contains the shorter ones", () => {
    // "this month" includes today, so nothing the daily would have said about
    // cash is lost by sending the monthly instead.
    const w = digestWindow("monthly", MON_FIRST);
    expect(w.fromYmd <= MON_FIRST).toBe(true);
    expect(w.toYmd).toBe(MON_FIRST);
  });

  it("each switch still stands on its own", () => {
    expect(digestDueToday({ daily: false, weekly: true, monthly: false }, WED)).toBeNull();
    expect(digestDueToday({ daily: false, weekly: true, monthly: false }, MON)).toBe("weekly");
    expect(digestDueToday({ daily: true, weekly: false, monthly: false }, MON)).toBe("daily");
    expect(digestDueToday({ daily: false, weekly: false, monthly: true }, FIRST)).toBe("monthly");
  });

  it("all off sends nothing, even on a day everything would be due", () => {
    expect(digestDueToday({ daily: false, weekly: false, monthly: false }, MON_FIRST)).toBeNull();
  });
});
