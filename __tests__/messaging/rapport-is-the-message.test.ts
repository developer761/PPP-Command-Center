import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  RAPPORT_IS_THE_MESSAGE, checkRapport, validateAction,
} from "@/lib/messaging/agent-output";
import { renderMessage } from "@/lib/messaging/render";

/**
 * A32 CUTS A REASON OFF AN ASK. Where there is no ask, it was cutting the
 * whole message.
 *
 *   customer  "how long will the job take?"
 *   model     answer_question + "Most rooms take a day or two because of
 *             drying time."
 *
 * REASON_CLAUSE matched "because…", the rapport was dropped, and
 * SAYS[answer_question] is [""] — so the rendered message was the empty
 * string. The turn then read as silence and the conversation was handed to a
 * person with no draft written: the customer got nothing, and nobody saw what
 * the bot had tried to say.
 *
 * "How long", "why" and "what's the difference" are all questions whose answer
 * IS a reason, so the rule as written forbade answering any of them.
 */

describe("the rule knows when rapport is the whole message", () => {
  it("names exactly the intents whose template is empty", () => {
    // Pinned to render.ts rather than trusted: agent-output cannot import the
    // renderer, so the two lists would otherwise drift silently, and a third
    // empty template would bring the bug straight back.
    const src = fs.readFileSync("lib/messaging/render.ts", "utf8");
    const empties = [...src.matchAll(/^\s{2}(\w+):\s*\[""\],/gm)].map((m) => m[1]);
    expect(empties.length).toBeGreaterThan(0);
    expect([...RAPPORT_IS_THE_MESSAGE].sort()).toEqual(empties.sort());
  });

  it("lets an answer carry its reason", () => {
    expect(checkRapport("Most rooms take a day or two because of drying time.", undefined, false, true).ok).toBe(true);
  });

  it("still cuts a reason bolted onto an ask", () => {
    const r = checkRapport("Since you're moving soon, what's the address?", undefined, true, false);
    expect(r.ok).toBe(false);
  });
});

describe("answering 'how long will it take' reaches the customer", () => {
  const answer = "Most rooms take a day or two because of drying time.";

  it("survives the validator", () => {
    const v = validateAction(
      { intent: "answer_question", freeText: answer, confidence: 0.9 },
      { customerText: "how long will the job take?" }
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.droppedRapport).toBeUndefined();
  });

  it("and survives the renderer, which is the half that made it silence", () => {
    // The pair, asserted together. The validator passing while the renderer
    // empties the message is this codebase's signature failure.
    const v = validateAction(
      { intent: "answer_question", freeText: answer, confidence: 0.9 },
      { customerText: "how long will the job take?" }
    );
    if (!v.ok) throw new Error("the validator refused it");
    const out = renderMessage({ intent: "answer_question", freeText: v.action.freeText, turn: 0 });
    expect(out.trim()).not.toBe("");
    expect(out).toContain("day or two");
  });
});
