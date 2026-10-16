import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stageFromIntents } from "@/lib/messaging/agent-output";
import { silenceOpenerProblem } from "@/lib/messaging/into-silence";

/**
 * A LIVE CONVERSATION, TURN AFTER TURN, FED THE WAY PRODUCTION FEEDS IT.
 *
 * Every earlier test of these rules built ONE turn's context by hand, and
 * hand-built context is how the three bugs below survived: each of them
 * lives in what the NEXT turn reads back after this one has been persisted.
 *
 *   liveTurnInputs   is what scheduler-db.draftReply calls
 *   runAgentTurn     is what it hands the result to, with the model mocked
 *   the row writes   are emulated exactly as draftReply guards them —
 *                    `.is(column, null)`, so the first value wins
 *
 * The opts passed to runAgentTurn mirror draftReply's for every field the
 * flow rules read. Kept beside the loop rather than spread through the
 * tests, so a difference from production is one place to look.
 */

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create };
    static AuthenticationError = class extends Error {};
    static RateLimitError = class extends Error {};
    static APIError = class extends Error {};
  }
  return { default: FakeAnthropic };
});

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

type Row = {
  customer_name: string | null; customer_phone: string;
  inquiry_scope: string | null; customer_address: string | null; customer_email: string | null;
};
type Msg = { direction: "inbound" | "outbound"; body: string; media_count?: number };

let runAgentTurn: typeof import("@/lib/messaging/agent-run").runAgentTurn;
let liveTurnInputs: typeof import("@/lib/messaging/live-turn").liveTurnInputs;
let persistedRow: typeof import("@/lib/messaging/live-turn").persistedRow;

beforeEach(async () => {
  vi.resetModules();
  create.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
  ({ runAgentTurn } = await import("@/lib/messaging/agent-run"));
  ({ liveTurnInputs, persistedRow } = await import("@/lib/messaging/live-turn"));
});
afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

function conversation(row: Partial<Row> = {}) {
  const state = {
    row: {
      customer_name: "Tom Smith", customer_phone: "+15165550123",
      inquiry_scope: null, customer_address: null, customer_email: null, ...row,
    } as Row,
    msgs: [] as Msg[],
    intents: [] as string[],
  };

  /** One draftReply, with the model choosing `intent`. */
  async function bot(
    intent: string,
    freeText = "",
    action: "agent_turn" | "stall_followup" | "park_reopen" = "agent_turn",
    stallStep?: number,
  ) {
    create.mockReset();
    create.mockResolvedValue(chose(intent, freeText));
    const turn = liveTurnInputs({
      row: state.row, msgs: state.msgs, stage0: stageFromIntents(state.intents),
      speaksAfterUs: action === "stall_followup" || action === "park_reopen",
    });
    if (!turn) throw new Error("nothing to reply to");
    const { resolved } = turn;
    const res = await runAgentTurn(cfg, turn.history, turn.inboundBody, {
      track: "new_lead",
      stage: resolved.stage,
      lastIntent: state.intents[state.intents.length - 1] ?? undefined,
      lastAskedForInfo: /^ask_/.test(state.intents[state.intents.length - 1] ?? ""),
      followUpStep: action === "stall_followup" ? stallStep : undefined,
      priorIntents: state.intents,
      scopeFromCustomer: resolved.scopeFrom === "customer",
      known: {
        name: state.row.customer_name, phone: state.row.customer_phone,
        email: resolved.email, address: resolved.address, inquiryScope: resolved.inquiryScope,
      },
      mediaCount: turn.mediaCount,
    });
    if (res.ok) {
      // draftReply's three guarded writes.
      state.row = persistedRow(state.row, resolved);
      state.intents.push(res.action.intent);
      if (res.rendered) state.msgs.push({ direction: "outbound", body: res.rendered });
    }
    return { res, resolved };
  }

  const customer = (body: string) => { state.msgs.push({ direction: "inbound", body }); };
  return { state, bot, customer };
}

const refusal = (res: Awaited<ReturnType<typeof runAgentTurn>>) =>
  res.ok ? "allowed" : (res.rejected ?? res.error);

/* ─────────────────────────────────────────────────────────────────────── */

describe("finding 1: scope the customer typed still counts once it has been stored", () => {
  it("books the lead who described the job in their first text (en)", async () => {
    const c = conversation();
    c.customer("Hi, I need the outside of my house painted, 2 story colonial");
    expect(refusal((await c.bot("ask_address")).res)).toBe("allowed");
    // Stored, exactly as draftReply stores it.
    expect(c.state.row.inquiry_scope).toMatch(/outside of my house painted/);

    c.customer("12 Oak St, Garden City NY 11530");
    const t2 = await c.bot("ask_contact");
    expect(refusal(t2.res)).toBe("allowed");
    // Read back off the row, and still theirs.
    expect(t2.resolved.scopeFrom).toBe("customer");

    c.customer("tom@example.com");
    expect(refusal((await c.bot("ask_availability")).res)).toBe("allowed");

    c.customer("Monday morning works");
    const close = await c.bot("success");
    expect(refusal(close.res)).toBe("allowed");
  });

  it("and the Spanish twin", async () => {
    const c = conversation();
    c.customer("Hola, necesito pintar el exterior de mi casa, dos pisos");
    expect(refusal((await c.bot("ask_address")).res)).toBe("allowed");
    c.customer("12 Oak St, Garden City NY 11530");
    expect(refusal((await c.bot("ask_contact")).res)).toBe("allowed");
    c.customer("tom@example.com");
    expect(refusal((await c.bot("ask_availability")).res)).toBe("allowed");
    c.customer("El lunes por la mañana");
    expect(refusal((await c.bot("success")).res)).toBe("allowed");
  });

  /**
   * A9 still holds on the later turns: reading back what they typed is the
   * echo, whichever turn it is attempted on.
   */
  it("still refuses to read their own words back on a later turn", async () => {
    const c = conversation();
    c.customer("Hi, I need the outside of my house painted, 2 story colonial");
    await c.bot("ask_address");
    c.customer("12 Oak St, Garden City NY 11530");
    expect(refusal((await c.bot("confirm_scope")).res)).toMatch(/^restated_scope_from_chat/);
  });

  /**
   * THE CONTROL: scope that came off the lead form was never confirmed by
   * the customer, so the close still owes a confirm_scope and confirming it
   * stays legal. This is the distinction scopeFromCustomer exists for.
   */
  it("CRM scope is still the record's, and still owed a confirmation", async () => {
    const c = conversation({ inquiry_scope: "Exterior repaint, 2 story colonial" });
    c.customer("Hi, yes still interested");
    const t1 = await c.bot("confirm_scope");
    expect(t1.resolved.scopeFrom).toBe("record");
    expect(refusal(t1.res)).toBe("allowed");
  });

  it("CRM scope with no confirmation cannot close", async () => {
    const c = conversation({
      inquiry_scope: "Exterior repaint, 2 story colonial",
      customer_address: "12 Oak St, Garden City NY 11530",
      customer_email: "tom@example.com",
    });
    c.customer("hi");
    await c.bot("confirm_address");
    c.customer("yes");
    await c.bot("confirm_contact");
    c.customer("yes");
    await c.bot("ask_availability");
    c.customer("Monday morning works");
    expect(refusal((await c.bot("success")).res)).toMatch(/^details_never_collected/);
  });
});

describe("finding 2: the flow keeps its place after a deferral", () => {
  it("confirms the address they gave after a pricing question was deferred", async () => {
    const c = conversation();
    c.customer("Hi, how much would it cost to paint 3 bedrooms and a hallway?");
    expect(refusal((await c.bot("defer_to_estimator")).res)).toBe("allowed");
    c.customer("12 Oak St, Garden City NY 11530");
    const t2 = await c.bot("confirm_address");
    expect(t2.resolved.stage).toBeGreaterThanOrEqual(1);
    expect(refusal(t2.res)).toBe("allowed");
    c.customer("yes that's right");
    expect(refusal((await c.bot("ask_contact")).res)).toBe("allowed");
  });

  /**
   * The opener is a price question, so ask_address cannot be turn one
   * (question_left_unanswered). The control asks for it on the next turn.
   */
  it("control: the same thread with ask_address reaches stage 2", async () => {
    const c = conversation();
    c.customer("Hi, how much would it cost to paint 3 bedrooms and a hallway?");
    expect(refusal((await c.bot("defer_to_estimator")).res)).toBe("allowed");
    c.customer("ok");
    expect(refusal((await c.bot("ask_address")).res)).toBe("allowed");
    c.customer("12 Oak St, Garden City NY 11530");
    const t2 = await c.bot("ask_contact");
    expect(t2.resolved.stage).toBe(2);
    expect(refusal(t2.res)).toBe("allowed");
  });
});

describe("finding 3: a follow-up after silence is not a reply to an old message", () => {
  /** We asked for the address, they asked a question, we answered and asked again. */
  async function answeredThenSilent(question: string, lang: "en" | "es" = "en") {
    const c = conversation();
    c.customer(lang === "es" ? "Necesito pintar mi sala" : "I need my living room painted");
    expect(refusal((await c.bot("ask_address")).res)).toBe("allowed");
    c.customer(question);
    const answered = await c.bot("answer_question", lang === "es" ? "Sí, también pintamos techos." : "Yes, we do ceilings too.");
    expect(refusal(answered.res)).toBe("allowed");
    return c;
  }

  for (const action of ["stall_followup", "park_reopen"] as const) {
    it(`${action}: asking for the address again is allowed`, async () => {
      const c = await answeredThenSilent("do you guys do ceilings too?");
      const f = await c.bot("ask_address", "", action, 1);
      expect(refusal(f.res)).toBe("allowed");
    });

    it(`${action}: the re-ask does not concede to a refusal nobody made`, async () => {
      const c = await answeredThenSilent("ok thanks");
      const f = await c.bot("ask_address", "", action, 1);
      expect(refusal(f.res)).toBe("allowed");
      const body = f.res.ok ? f.res.rendered : "";
      expect(body).not.toMatch(/No problem|at least need the zip/i);
      expect(silenceOpenerProblem(body)).toBeNull();
    });
  }

  it("Spanish follow-up stays Spanish and is allowed", async () => {
    const c = await answeredThenSilent("¿también pintan techos?", "es");
    const f = await c.bot("ask_address", "", "stall_followup", 1);
    expect(refusal(f.res)).toBe("allowed");
    const body = f.res.ok ? f.res.rendered : "";
    expect(body).not.toMatch(/No hay problema|What's the address/i);
  });

  it("the model is told nothing new arrived, not handed the old message", async () => {
    const c = await answeredThenSilent("do you guys do ceilings too?");
    await c.bot("ask_address", "", "stall_followup", 1);
    const prompt = JSON.stringify(create.mock.calls[0][0].messages);
    expect(prompt).toContain("Nothing new has arrived from the customer");
    expect(prompt).not.toContain("has just sent");
    // Our own answer stays in the transcript; it used to be sliced off.
    expect(prompt).toContain("Yes, we do ceilings too.");
  });

  /**
   * CONTROL: a real refusal still gets Kate's zip floor on an ordinary turn.
   */
  it("control: an ordinary turn after a refusal still uses the zip floor", async () => {
    const c = conversation();
    c.customer("I need my living room painted");
    await c.bot("ask_address");
    c.customer("I'd rather not give my address yet");
    const f = await c.bot("ask_address");
    expect(refusal(f.res)).toBe("allowed");
    expect(f.res.ok && f.res.rendered).toMatch(/zip/i);
  });

  /**
   * And the race: the customer replied after the follow-up was queued. Their
   * message is new, so it is what the turn answers.
   */
  it("a follow-up that finds a fresh customer message answers it", async () => {
    const c = await answeredThenSilent("ok thanks");
    c.customer("12 Oak St, Garden City NY 11530");
    const f = await c.bot("confirm_address", "", "stall_followup", 1);
    expect(f.resolved.address).toMatch(/12 Oak St/);
    expect(refusal(f.res)).toBe("allowed");
  });
});

/**
 * FINDING 4: THE HARNESS HAS TO READ WHAT PRODUCTION READS.
 *
 * The scenario engine re-derived scope from the whole thread with no row, so
 * a scope typed in message one stayed "customer" there for ever while the
 * live path read it back off the row as "record". It now replays the row the
 * way draftReply writes it; with known-from-thread's provenance check
 * removed, the first test here fails, which is the check it was missing.
 */
describe("the scenario engine replays the stored row like production", () => {
  const booked = {
    name: "described the job, then gave everything",
    history: [
      "Hi, I need the outside of my house painted, 2 story colonial",
      "12 Oak St, Garden City NY 11530",
      "tom@example.com",
    ],
    text: "Monday morning works",
    priorIntents: ["ask_address", "ask_contact", "ask_availability"],
    known: { name: "Tom Smith", phone: "+15165550123" },
  };

  it("a scope they typed is still theirs at the close, so success is open", async () => {
    const { waysThrough } = await import("../../scripts/scenario-engine.mjs");
    const w = waysThrough(booked);
    expect(w.ctx.scopeFromCustomer).toBe(true);
    expect(w.open).toContain("success");
    expect(w.open).not.toContain("confirm_scope");
  });

  it("control: lead-form scope still owes confirm_scope before success", async () => {
    const { waysThrough } = await import("../../scripts/scenario-engine.mjs");
    const w = waysThrough({
      ...booked,
      history: ["hi", "12 Oak St, Garden City NY 11530", "tom@example.com"],
      known: { ...booked.known, inquiryScope: "Exterior repaint, 2 story colonial" },
    });
    expect(w.ctx.scopeFromCustomer).toBe(false);
    expect(w.open).not.toContain("success");
    expect(w.probe("success")).toMatch(/^details_never_collected/);
  });

  it("passes the validator fields production passes", async () => {
    const { waysThrough } = await import("../../scripts/scenario-engine.mjs");
    const w = waysThrough({ ...booked, serviceArea: "serviced" });
    expect(w.ctx.lastIntent).toBe("ask_availability");
    expect(w.ctx.serviceArea).toBe("serviced");
    expect(w.ctx.negativeReaction).toBe(false);
  });
});
