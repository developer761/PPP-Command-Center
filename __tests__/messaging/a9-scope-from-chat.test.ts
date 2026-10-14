import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A9 — "Summarize scope in the bot's OWN WORDS, but ONLY scope pulled FROM
 * FILE. Never restate scope the customer just typed in chat." 56 faults.
 *
 * validateAction allowed confirm_scope IDENTICALLY whether the scope came
 * off the record or out of the chat — the whole distinction the rule turns
 * on — and the renderer sent the customer's own sentence back: "So we have
 * this down as: I need the kitchen and two bedrooms painted. Have I got that
 * right?"
 *
 * scopeFromCustomer was already in the context, read at one site where it
 * SATISFIES an A3 leg rather than refusing anything.
 */
const ctx = (scopeFromCustomer?: boolean) => ({
  scopeFromCustomer,
  knownFields: { name: true, phone: true, email: true, address: true, inquiryScope: true },
  addressGap: null,
  templateAsks: () => false,
  customerMessages: [],
  flowStage: 1,
}) as never;

const confirm = (scopeFromCustomer?: boolean) =>
  validateAction({ intent: "confirm_scope", confidence: 0.97, freeText: "" }, ctx(scopeFromCustomer));

describe("A9 — scope the customer just typed is not read back", () => {
  it("refuses confirm_scope when they typed it this conversation", () => {
    const v = confirm(true);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe("restated_scope_from_chat");
  });

  /**
   * The other half, and the reason the intent exists: a wrong lead form only
   * surfaces if somebody reads it back. Breaking this would be worse than
   * the bug being fixed.
   */
  it("still confirms scope that came off the RECORD", () => {
    expect(confirm(false).ok).toBe(true);
  });

  it("does nothing when provenance is unknown", () => {
    expect(confirm(undefined).ok).toBe(true);
  });
});

/**
 * THE HARNESS MUST SEE IT TOO.
 *
 * scheduler-db.ts and simulator.ts have always passed scopeFromCustomer; the
 * scenario engine never did, so this rule could not be exercised there at
 * all. A context thinner than production disables a rule silently, which is
 * the one thing a harness must not do.
 */
describe("the scenario engine passes scope provenance like production", () => {
  it("sets scopeFromCustomer when the customer typed the scope", async () => {
    const { waysThrough } = await import("../../scripts/scenario-engine.mjs");
    const w = waysThrough({ name: "t", text: "I need the kitchen and two bedrooms painted" });
    expect(w.ctx.scopeFromCustomer).toBe(true);
    expect(w.open).not.toContain("confirm_scope");
  });
});
