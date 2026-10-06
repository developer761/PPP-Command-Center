import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ONE RETRY, FED THE REFUSAL.
 *
 * A rejection used to end the turn, on the reasoning in
 * agentFailureIsTransient: "the same input will be refused again next minute,
 * so retrying is pointless." True of a banned phrase; false of the refusals
 * seen live on 2026-10-05, every one of which says what to do instead —
 *
 *   address_question_walked_past: ...so the address is still owed. Answer them
 *   AND ask for it again in the same message
 *
 * — and the model never saw that sentence. Replaying identical input gave
 * different intents on different runs, so these are variance, which is exactly
 * what a second attempt fixes.
 *
 * THE RISK THIS FILE EXISTS FOR is not the retry working. It is the contract
 * underneath it: `rejected` means TERMINAL, and the scheduler cancels on it
 * rather than counting a failure. If a retry made an exhausted rejection look
 * transient, a rate-limited minute would start silently dropping replies —
 * a bug this codebase has already shipped once.
 */

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  // All three error classes runAgentTurn narrows on. A missing one is not a
  // failed assertion, it is `instanceof` throwing inside the catch block.
  class FakeAnthropic {
    messages = { create };
    static AuthenticationError = class extends Error {};
    static RateLimitError = class extends Error {};
    static APIError = class extends Error {};
  }
  return { default: FakeAnthropic };
});

/** A model reply choosing an action, in the shape the SDK returns. */
const chose = (intent: string, freeText = "") => ({
  content: [{ type: "tool_use", name: "choose_action", id: `t_${intent}`, input: { intent, confidence: 0.97, freeText } }],
  usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
});

const cfg = {
  persona_name: "Emily", persona_role: "coordinator",
  required_flow: ["project_details", "address", "contact", "availability"],
  services_included: null, services_excluded: null, offsite_rules: null,
  tone_rules: null, office_location: null, service_area_note: null,
  confidence_threshold: 0.9,
};

/**
 * The live scenario, reduced: the customer asked a question instead of giving
 * the address, so advancing to ask_contact is refused by
 * address_question_walked_past and asking again is the legal move.
 */
const dodge = {
  track: "new_lead" as const,
  // Stage 2: the address has been ASKED, so contact is the next step in order
  // and `out_of_order` does not fire first. What refuses ask_contact here is
  // address_question_walked_past, which is the rule under test — with stage 1
  // the ordering guard gets there first and the retry is exercised for the
  // wrong reason.
  stage: 2,
  priorIntents: ["ask_project_details", "ask_address"],
  scopeFromCustomer: true,
  known: { inquiryScope: "living room" },
};

let runAgentTurn: typeof import("@/lib/messaging/agent-run").runAgentTurn;
let agentFailureIsTransient: typeof import("@/lib/messaging/agent-run").agentFailureIsTransient;

beforeEach(async () => {
  vi.resetModules();
  create.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  ({ runAgentTurn, agentFailureIsTransient } = await import("@/lib/messaging/agent-run"));
});

afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe("a refused turn gets exactly one more attempt", () => {
  it("rescues the turn when the second choice is legal", async () => {
    create
      .mockResolvedValueOnce(chose("ask_contact", "The office handles scheduling."))
      .mockResolvedValueOnce(chose("ask_address", "The office handles scheduling."));

    const res = await runAgentTurn(cfg, [{ role: "customer", text: "i need my living room painted" }],
      "what times do you have available this week?", dodge);

    expect(create).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.action.intent).toBe("ask_address");
    // And it SAYS it was rescued, so the rate is countable.
    expect(res.retriedAfter).toMatch(/address_question_walked_past/);
  });

  it("does not spend a retry when the first choice is legal", async () => {
    create.mockResolvedValueOnce(chose("ask_address", "The office handles scheduling."));

    const res = await runAgentTurn(cfg, [{ role: "customer", text: "i need my living room painted" }],
      "what times do you have available this week?", dodge);

    expect(create).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.retriedAfter).toBeUndefined();
  });

  it("stops at two — a model that declines twice is not unlucky", async () => {
    create
      .mockResolvedValueOnce(chose("ask_contact", "The office handles scheduling."))
      .mockResolvedValueOnce(chose("ask_availability", "The office handles scheduling."));

    const res = await runAgentTurn(cfg, [{ role: "customer", text: "i need my living room painted" }],
      "what times do you have available this week?", dodge);

    expect(create).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(false);
  });
});

/**
 * THE CONTRACT. An exhausted rejection is still terminal, and still carries
 * what a grader needs.
 */
describe("the terminal semantics survive the retry", () => {
  it("is not transient once both attempts are refused", async () => {
    create
      .mockResolvedValueOnce(chose("ask_contact", "The office handles scheduling."))
      .mockResolvedValueOnce(chose("ask_availability", "The office handles scheduling."));

    const res = await runAgentTurn(cfg, [{ role: "customer", text: "i need my living room painted" }],
      "what times do you have available this week?", dodge);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejected).toBeTruthy();
    expect(agentFailureIsTransient(res)).toBe(false);
  });

  /**
   * The second choice has to fail DIFFERENTLY, which is the point: two
   * distinct refusals say the model moved and still missed. When both
   * refusals are identical there is nothing to add and `retriedAfter` is
   * deliberately omitted rather than printing the same sentence twice.
   */
  it("keeps BOTH refusals, so a grader can see whether the model moved", async () => {
    create
      .mockResolvedValueOnce(chose("ask_contact", "The office handles scheduling."))
      .mockResolvedValueOnce(chose("ask_address", "It'll run about $2,500."));

    const res = await runAgentTurn(cfg, [{ role: "customer", text: "i need my living room painted" }],
      "what times do you have available this week?", dodge);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // `rejected` is the LAST refusal, `retriedAfter` the first.
    expect(res.retriedAfter).toMatch(/address_question_walked_past/);
    expect(res.rejected).toBeTruthy();
    expect(res.rejected).not.toBe(res.retriedAfter);
    expect(res.attempted?.intent).toBe("ask_address");
    // And `attempted` is the SECOND attempt, not the first — the grader is
    // looking at what actually got sent to the validator last.
    expect(res.attempted?.freeText).toMatch(/2,500/);
  });

  /** An infrastructure failure is still transient — the half that must not move. */
  it("still treats a thrown API error as retryable by the scheduler", async () => {
    create.mockRejectedValueOnce(new Error("fetch failed"));
    const res = await runAgentTurn(cfg, [], "hello", dodge);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.rejected).toBeUndefined();
    expect(agentFailureIsTransient(res)).toBe(true);
  });
});

/** The retry must be judged by the same rules, and see its own refusal. */
describe("what the second attempt is sent", () => {
  it("sends the refusal back as the result of the action it chose", async () => {
    create
      .mockResolvedValueOnce(chose("ask_contact", "The office handles scheduling."))
      .mockResolvedValueOnce(chose("ask_address", "The office handles scheduling."));

    await runAgentTurn(cfg, [{ role: "customer", text: "i need my living room painted" }],
      "what times do you have available this week?", dodge);

    const second = create.mock.calls[1][0];
    const last = second.messages[second.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content[0].type).toBe("tool_result");
    expect(last.content[0].tool_use_id).toBe("t_ask_contact");
    expect(last.content[0].is_error).toBe(true);
    expect(String(last.content[0].content)).toMatch(/address_question_walked_past/);
    // The model's own choice is in the transcript it is reasoning about.
    expect(second.messages[second.messages.length - 2].role).toBe("assistant");
  });

  /** Same cached system prefix on both calls, which is what keeps it cheap. */
  it("reuses the cached system blocks rather than rebuilding them", async () => {
    create
      .mockResolvedValueOnce(chose("ask_contact", "The office handles scheduling."))
      .mockResolvedValueOnce(chose("ask_address", "The office handles scheduling."));

    await runAgentTurn(cfg, [{ role: "customer", text: "i need my living room painted" }],
      "what times do you have available this week?", dodge);

    const [first, second] = create.mock.calls.map((c) => c[0]);
    expect(second.system).toEqual(first.system);
    expect(first.system[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
