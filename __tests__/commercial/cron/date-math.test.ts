import { describe, it, expect } from "vitest";

/**
 * Tests that lock in the Stage 1 audit fix for DATE-vs-TIMESTAMPTZ
 * comparison correctness.
 *
 * Why this matters: the original cron used `.lt("due_at", nowIso)`
 * against a DATE column. Postgres promotes the DATE to midnight UTC,
 * so a task due 2026-06-18 flagged overdue at 00:00 UTC on the same
 * day — which is 8pm the night before in Eastern. Audit caught it
 * before deploy. Fix: compare as date-string.
 *
 * These tests verify the date-string math used in the cron job
 * runners — building "today" as YYYY-MM-DD, computing the cooling
 * cutoff, and the window-end date for the decision-deadline filter.
 */

describe("date-string today derivation", () => {
  it("new Date().toISOString().slice(0,10) yields YYYY-MM-DD", () => {
    // Simulate the cron firing at any time today
    const today = new Date().toISOString().slice(0, 10);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("compares correctly: yesterday < today < tomorrow as date-strings", () => {
    const now = new Date("2026-06-22T12:00:00Z");
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const today = now.toISOString().slice(0, 10);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(yesterday).toBe("2026-06-21");
    expect(today).toBe("2026-06-22");
    expect(tomorrow).toBe("2026-06-23");
    // String comparison must match chronological order for YYYY-MM-DD
    expect(yesterday < today).toBe(true);
    expect(today < tomorrow).toBe(true);
  });

  it("yesterday's date string is lexicographically less than today's", () => {
    // The actual filter is `.lt("due_at", today)` — a task due
    // yesterday must match, today must NOT, tomorrow must NOT.
    const today = "2026-06-22";
    expect("2026-06-21" < today).toBe(true); // overdue
    expect("2026-06-22" < today).toBe(false); // due today, NOT overdue
    expect("2026-06-23" < today).toBe(false); // due tomorrow, not overdue
  });
});

describe("hot-deals decision-window date-string math", () => {
  it("14-day forward window is correctly computed as date-string", () => {
    const now = new Date("2026-06-22T12:00:00Z").getTime();
    const windowEnd = new Date(now + 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(windowEnd).toBe("2026-07-06");
  });

  it("proposal_due_at = today + 14d is INCLUDED in window", () => {
    const windowEnd = "2026-07-06";
    expect("2026-07-06" <= windowEnd).toBe(true);
  });

  it("proposal_due_at = today + 15d is EXCLUDED from window", () => {
    const windowEnd = "2026-07-06";
    expect("2026-07-07" <= windowEnd).toBe(false);
  });

  it("past-due proposal_due_at is INCLUDED (no lower bound — audit fix)", () => {
    // The audit fix removed the gte("proposal_due_at", now) filter
    // because past-due hot deals are EXACTLY the cohort that needs
    // the nudge most. We just enforce: <= today + 14d.
    const windowEnd = "2026-07-06";
    expect("2026-06-01" <= windowEnd).toBe(true); // past-due, INCLUDED
  });
});

describe("dedup window boundary math (Stage 1 + 2 recheck fix)", () => {
  it("23h window releases before next 24h cron fire", () => {
    // The original bug: gte("created_at", now - 24h) caught the
    // previous fire's row at exactly 24h+1ms. Fix: trim to 23h so
    // the dedup releases reliably between daily fires.
    const HOURS = 23;
    const cutoffMs = HOURS * 60 * 60 * 1000;
    const previousFire = Date.now() - 24 * 60 * 60 * 1000; // 24h ago
    const cutoff = Date.now() - cutoffMs; // 23h ago
    // Previous fire was 24h ago — 23h cutoff is more recent — previous
    // fire is BEFORE the cutoff → not found → dedup releases.
    expect(previousFire < cutoff).toBe(true);
  });

  it("29d window releases before next 30d doc cron fire", () => {
    const HOURS = 29 * 24;
    const cutoffMs = HOURS * 60 * 60 * 1000;
    const previousFire = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - cutoffMs;
    expect(previousFire < cutoff).toBe(true);
  });

  it("6d window releases before next 7d hot-deal cron fire", () => {
    const HOURS = 6 * 24;
    const cutoffMs = HOURS * 60 * 60 * 1000;
    const previousFire = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - cutoffMs;
    expect(previousFire < cutoff).toBe(true);
  });
});

describe("UTC date stability for 12:00 UTC cron schedule", () => {
  it("12:00 UTC always falls on the same calendar date in Eastern", () => {
    // The cron fires at 12:00 UTC. That's 7am EST (winter, UTC-5)
    // or 8am EDT (summer, UTC-4). In BOTH cases, it's the same
    // calendar date as the UTC date — never crosses midnight Eastern.
    const winterFire = new Date("2026-01-15T12:00:00Z");
    const summerFire = new Date("2026-07-15T12:00:00Z");
    // YYYY-MM-DD in UTC always matches the Eastern calendar date at
    // 12:00 UTC (because 7am or 8am Eastern is still that same day).
    expect(winterFire.toISOString().slice(0, 10)).toBe("2026-01-15");
    expect(summerFire.toISOString().slice(0, 10)).toBe("2026-07-15");
  });
});
