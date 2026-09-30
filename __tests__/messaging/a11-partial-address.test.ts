import { describe, it, expect } from "vitest";
import { validateAction } from "@/lib/messaging/agent-output";

/**
 * A11 — the second most breached rule in the handover corpus: 289 breaches
 * across 250 conversations, all of them a partial address mishandled.
 *
 * ── WHY THIS GUARD EXISTS ───────────────────────────────────────────────
 *
 * Seen in the sandbox on 2026-09-30, against the live build. The customer
 * said "its 12 Marchmont Ave. roughly how much would that run me?". The bot
 * refused to quote (A1, right), offered the off-site quote (A7, right), then
 * asked for name and email — and never asked for the ZIP, while the progress
 * panel still read "Full address, asking for this next".
 *
 * Nothing was breached. The stage machine advances on intents ASKED, which is
 * Kate's carve-out, so ask_contact was legal. addressGap correctly returned
 * `zip`, and the prompt told the model to ask for that piece "and only that
 * piece". The model declined.
 *
 * A prompt instruction the model can decline is precisely what this file
 * replaces with a refusal.
 */
const act = (intent: string) => ({ intent, freeText: "", confidence: 0.95, reasoning: "" });

describe("a half address cannot be walked past", () => {
  it.each(["ask_contact", "ask_availability", "success"])(
    "refuses %s while the ZIP is still missing", (intent) => {
      const res = validateAction(act(intent), {
        addressGap: "zip",
        lastIntent: "offer_offsite_quote",
        priorIntents: ["ask_project_details", "ask_address"],
      } as never);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe("partial_address_walked_past");
      expect(res.detail).toMatch(/ZIP code/);
      // Names the piece, so the retry can be the RIGHT ask rather than a
      // second request for the whole address.
      expect(res.detail).toMatch(/only that piece/);
    }
  );

  /**
   * A41: "Do not block the flow on a REFUSAL. If they decline to give a
   * field, continue and move on." So exactly one attempt is owed — if the
   * turn before was the address ask and they still have not completed it,
   * moving on is correct.
   */
  it("allows moving on once the ask has already been made", () => {
    const res = validateAction(act("ask_contact"), {
      addressGap: "zip",
      lastIntent: "ask_address",
      priorIntents: ["ask_project_details", "ask_address"],
    } as never);
    expect(res.ok).toBe(true);
  });

  it("does not fire when the whole address is held", () => {
    const res = validateAction(act("ask_contact"), {
      addressGap: null,
      lastIntent: "offer_offsite_quote",
      priorIntents: ["ask_project_details", "ask_address"],
    } as never);
    expect(res.ok).toBe(true);
  });

  /**
   * The intents that must stay available while a gap is open. A customer who
   * asks a question mid-address gets an ANSWER, not a refusal — A29 binds at
   * any point in the conversation.
   */
  it.each(["answer_question", "acknowledge", "offer_offsite_quote", "ask_address"])(
    "leaves %s available while the gap is open", (intent) => {
      const res = validateAction(act(intent), {
        addressGap: "zip",
        lastIntent: "offer_offsite_quote",
        priorIntents: ["ask_project_details", "ask_address"],
      } as never);
      expect(res.ok, intent).toBe(true);
    }
  );

  it("still refuses CONFIRMING a half address, which banks it as whole", () => {
    // The guard that already existed, unchanged by this one.
    const res = validateAction(act("confirm_address"), { addressGap: "zip" } as never);
    expect(res.ok).toBe(false);
  });
});
