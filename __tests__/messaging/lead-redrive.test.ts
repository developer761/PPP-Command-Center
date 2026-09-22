import { describe, it, expect } from "vitest";
import {
  shouldRedrive, planRedrive, reasonIsWorthRetrying, ageHours,
  DEFAULT_MAX_AGE_HOURS, type HeldLead,
} from "@/lib/messaging/lead-redrive";

const NOW = new Date("2026-09-22T17:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const held = (over: Partial<HeldLead> = {}): HeldLead => ({
  id: "l1",
  status: "triage",
  triageReason: "region_not_live: CA LA Leads is not switched on yet",
  sfCreatedAt: hoursAgo(2),
  receivedAt: hoursAgo(2),
  ...over,
});

/**
 * THE GUARD IS THE FEATURE.
 *
 * Re-driving held leads without an age check texts four hundred people about
 * an enquiry they made last week, the moment somebody switches a workflow on.
 * In production on 2026-09-22 there were 432 leads held only because no
 * workflow was active, the oldest six days old.
 */
describe("a lead is only worth texting while they still remember asking", () => {
  it("releases a lead from two hours ago", () => {
    expect(shouldRedrive(held(), { now: NOW }).redrive).toBe(true);
  });

  it("holds a lead from last week, and says how old it is", () => {
    const d = shouldRedrive(held({ sfCreatedAt: hoursAgo(24 * 6), receivedAt: hoursAgo(24 * 6) }), { now: NOW });
    expect(d.redrive).toBe(false);
    if (!d.redrive) expect(d.why).toMatch(/6 day\(s\) old/);
  });

  it("holds right on the far side of the limit", () => {
    expect(shouldRedrive(held({ sfCreatedAt: hoursAgo(DEFAULT_MAX_AGE_HOURS + 1) }), { now: NOW }).redrive).toBe(false);
    expect(shouldRedrive(held({ sfCreatedAt: hoursAgo(DEFAULT_MAX_AGE_HOURS - 1) }), { now: NOW }).redrive).toBe(true);
  });

  it("lets somebody widen the window deliberately", () => {
    // Releasing a real backlog is a decision. It should be possible, and it
    // should require typing a number rather than happening by default.
    const old = held({ sfCreatedAt: hoursAgo(24 * 5), receivedAt: hoursAgo(24 * 5) });
    expect(shouldRedrive(old, { now: NOW }).redrive).toBe(false);
    expect(shouldRedrive(old, { now: NOW, maxAgeHours: 24 * 7 }).redrive).toBe(true);
  });

  it("refuses a lead with no date rather than guessing it is fresh", () => {
    const d = shouldRedrive(held({ sfCreatedAt: null, receivedAt: null }), { now: NOW });
    expect(d.redrive).toBe(false);
    if (!d.redrive) expect(d.why).toMatch(/age cannot be checked/);
  });

  it("falls back to when we received it when Salesforce gave no date", () => {
    expect(shouldRedrive(held({ sfCreatedAt: null, receivedAt: hoursAgo(1) }), { now: NOW }).redrive).toBe(true);
  });

  it("treats a lead dated in the future as brand new, not negative", () => {
    // Clock skew between Salesforce and us. Reads as nonsense otherwise.
    expect(ageHours(held({ sfCreatedAt: hoursAgo(-3) }), NOW)).toBe(0);
  });
});

describe("which reasons are worth asking again", () => {
  it("retries the ones a person resolves by changing something", () => {
    for (const r of [
      "region_not_live: CA LA Leads is not switched on yet",
      "workspace_has_no_number: Thumbtack has no phone number",
      "no_matching_workspace: source=Google state=— locality=—",
      "region_unclear: NY is covered by several teams",
      "no active workflow covers this workspace",
    ]) {
      expect(reasonIsWorthRetrying(r), r).toBe(true);
    }
  });

  it("does not retry the ones that will answer the same way", () => {
    for (const r of [
      "no_contactable_phone: no phone on the record",
      'no_contactable_phone: "null" is not a number we can text',
      "not_serviced: TX is outside the states PPP covers",
      "this number has opted out",
    ]) {
      expect(reasonIsWorthRetrying(r), r).toBe(false);
    }
  });

  it("never retries somebody who opted out, whatever else the reason says", () => {
    // The one that must not be got wrong by a substring match.
    expect(reasonIsWorthRetrying("region_not_live, and this number has opted out")).toBe(false);
  });

  it("does not retry a lead outside the service area", () => {
    // "not_serviced" contains no transient word, but a future reason might.
    // Permanent wins on a tie, deliberately.
    expect(reasonIsWorthRetrying("not_serviced: no matching workspace for CA Orange")).toBe(false);
  });

  it("ignores an empty reason rather than retrying blindly", () => {
    expect(reasonIsWorthRetrying(null)).toBe(false);
    expect(reasonIsWorthRetrying("")).toBe(false);
  });
});

describe("what it refuses to touch", () => {
  it("leaves a routed lead alone", () => {
    const d = shouldRedrive(held({ status: "routed" }), { now: NOW });
    expect(d.redrive).toBe(false);
    if (!d.redrive) expect(d.why).toMatch(/already routed/);
  });

  it("leaves a lead already waiting in the queue alone", () => {
    // Re-driving a pending row would double-process it.
    expect(shouldRedrive(held({ status: "pending" }), { now: NOW }).redrive).toBe(false);
  });

  it("retries a 'failed' row even with a raw error for a reason", () => {
    // A crash mid-enrolment leaves a Postgres message rather than one of our
    // reasons, and the row is the only record the lead ever existed.
    const d = shouldRedrive(held({
      status: "failed",
      triageReason: 'insert or update on table "sms_conversations" violates foreign key constraint',
    }), { now: NOW });
    expect(d.redrive).toBe(true);
  });

  it("still applies the age guard to a failed row", () => {
    expect(shouldRedrive(held({ status: "failed", triageReason: "boom", sfCreatedAt: hoursAgo(24 * 9) }), { now: NOW }).redrive).toBe(false);
  });
});

describe("planning a release", () => {
  it("splits a batch and counts why each one stayed", () => {
    const plan = planRedrive([
      held({ id: "a" }),
      held({ id: "b", sfCreatedAt: hoursAgo(24 * 8), receivedAt: hoursAgo(24 * 8) }),
      held({ id: "c", triageReason: "no_contactable_phone: no phone on the record" }),
      held({ id: "d", status: "routed" }),
    ], { now: NOW });

    expect(plan.release.map((l) => l.id)).toEqual(["a"]);
    // Three different reasons, each named, so the screen can say what a
    // release would and would not do before anybody presses the button.
    expect(Object.values(plan.holdReasons).reduce((a, b) => a + b, 0)).toBe(3);
    expect(Object.keys(plan.holdReasons)).toHaveLength(3);
  });

  it("releases nothing from an empty batch", () => {
    expect(planRedrive([], { now: NOW })).toEqual({ release: [], holdReasons: {} });
  });

  it("is safe to run against the real production mix", () => {
    // The shape of sf_lead_inbound on 2026-09-22: mostly old, mostly waiting
    // on a workflow. A release with the default window must move almost none
    // of it, which is the whole point.
    const batch: HeldLead[] = [
      ...Array.from({ length: 432 }, (_, i) => held({
        id: `w${i}`, status: "ignored",
        triageReason: "no active workflow covers this workspace",
        sfCreatedAt: hoursAgo(24 * 3), receivedAt: hoursAgo(24 * 3),
      })),
      ...Array.from({ length: 6 }, (_, i) => held({ id: `f${i}`, sfCreatedAt: hoursAgo(5), receivedAt: hoursAgo(5) })),
    ];
    const plan = planRedrive(batch, { now: NOW });
    expect(plan.release).toHaveLength(6);
  });
});
