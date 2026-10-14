import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";
import { jobRoute } from "@/lib/messaging/offsite";

/**
 * A6 — "when the JOB routes off-site, PRESENT the quick quote instead of
 * running the in-person booking flow. The route is a LOOKUP, not a
 * judgement."
 *
 * 93 fell_short findings, 85 critical, and 92 of the 93 are this exact
 * fault: the booking flow ran and the quick quote was never presented.
 *
 * ── WHY THIS IS AN INTENT GUARD, NOT A WORDING ONE ──────────────────────
 *
 * A sentence cannot tell you whether A6 was broken. "We can provide a quick
 * quote for this project. Do you prefer text or email?" sits in Kate's
 * PRAISED set AND in her FAULTED set — identical words, right or wrong
 * depending on whether the booking flow had already run. A freeText matcher
 * scored 2 of 82 against the real faults, which is how the wrong instrument
 * was found before it shipped.
 */
const ctx = (jobRouteValue: string | null, priorIntents: string[] = []) => ({
  jobRoute: jobRouteValue,
  priorIntents,
  knownFields: { name: true, phone: true, email: true, address: true, inquiryScope: true },
  addressGap: null,
  availabilityGap: "both",
  templateAsks: () => false,
  customerMessages: [],
  flowStage: 4,
}) as never;

const ask = (route: string | null, prior: string[] = []) =>
  validateAction({ intent: "ask_availability", confidence: 0.97, freeText: "" }, ctx(route, prior));

describe("A6 — an off-site job never enters the in-person booking flow", () => {
  /** The lookup is the premise; if this changes the guard is aimed wrong. */
  it("routes partial-room work off-site", () => {
    expect(jobRoute("one accent wall in the living room")?.route).toBe("offsite");
  });

  it("refuses the availability ask on an off-site job", () => {
    const v = ask("offsite");
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("offsite_job_entered_booking_flow");
  });

  /**
   * The ladder is the carve-out. Once the quick quote has actually been
   * presented it HAS come first, and a visit arranged after that is not the
   * fault A6 describes.
   */
  it("allows it once the quick quote has been presented", () => {
    expect(ask("offsite", ["present_offsite_quote"]).ok).toBe(true);
  });

  it("leaves an on-site job alone, where booking is the whole point", () => {
    expect(ask("onsite").ok).toBe(true);
  });

  /** A caller that does not track scope must behave as it always has. */
  it("does nothing when the route is unknown", () => {
    expect(ask(null).ok).toBe(true);
  });

  it("never blocks the intent A6 actually wants", () => {
    const v = validateAction(
      { intent: "present_offsite_quote", confidence: 0.97, freeText: "" },
      ctx("offsite"),
    );
    expect(v.ok).toBe(true);
  });
});
