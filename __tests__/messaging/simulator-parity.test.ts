import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readFileSync } from "node:fs";

/**
 * THE SANDBOX MUST BE GIVEN WHAT PRODUCTION IS GIVEN.
 *
 * `runAgentTurn` decides almost nothing on its own. It is handed a context —
 * the stage, the prior intents, the service-area verdict, the customer's zone —
 * and the rules read that context. So a caller that omits a field does not get
 * a failing rule. It gets a rule that never runs, because every guard is
 * written `if (ctx.someField && ...)` and an absent field short-circuits it.
 *
 * That makes an omission invisible in the worst possible way: the sandbox
 * answers, the answer looks fine, and the rule it was supposed to be testing
 * was never consulted. lib/messaging/simulator.ts has now been patched for
 * this FIVE times — the out-of-hours disclosure, the resolved scope, the
 * address, and on 2026-09-28 the prior intents and the service-area verdict —
 * each found by hand, each after the sandbox had been used to sign something
 * off.
 *
 * The 2026-09-28 one is the shape worth remembering. A full onsite flow, then
 * the customer says "Weekdays are better", and the sandbox replied:
 *
 *   "Perfect, you're all set. Someone from the office will confirm the
 *    details with you."
 *
 * Production refuses that turn — A4, a day is not a window, the estimator
 * cannot be booked against it. The sandbox allowed it because `priorIntents`
 * was never passed, and all four close guards hang off it. The sandbox is
 * where Kate and Karan GRADE the bot, so it was showing them a more permissive
 * bot than the one that ships, and a reply marked "Good" there becomes an
 * example the next model imitates.
 *
 * So rather than asserting the five fields we happen to have noticed, this
 * asserts the SHAPE: whatever the live scheduler passes, the sandbox passes
 * too, unless the difference is named and justified below.
 */

/** Option keys at every `runAgentTurn(...)` call site in a file. */
function optionKeys(path: string): string[] {
  const src = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const walk = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "runAgentTurn") {
      const last = n.arguments[n.arguments.length - 1];
      if (last && ts.isObjectLiteralExpression(last)) {
        for (const p of last.properties) if (p.name) found.push(p.name.getText(sf));
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return [...new Set(found)].sort();
}

const PRODUCTION = "lib/messaging/scheduler-db.ts";
const SANDBOX = "lib/messaging/simulator.ts";

/**
 * Differences that are CORRECT, each with the reason.
 *
 * A field belongs here only when the sandbox not passing it produces the same
 * behaviour as production, not merely when nobody has got round to it. Adding
 * a name here is a claim, so state the claim.
 */
const JUSTIFIED: Record<string, string> = {
  /**
   * A25's "when may we call you". Production reads it from the conversation
   * row, which remembers a constraint stated several turns ago. The sandbox
   * has no conversation row — and agent-run's own default is exactly right for
   * that case: `opts.callback ?? { unreachableStartHour: statedConstraint(
   * ownWords)?.startHour ?? null }`, reading the constraint out of the message
   * being answered. Passing nothing here gets the documented fallback rather
   * than a disabled rule, which is the distinction this whole file is about.
   */
  callback: "agent-run falls back to the constraint stated in this message, which is correct with no conversation row",
};

describe("the sandbox is given the same context as production", () => {
  it("finds the call sites it claims to check", () => {
    expect(optionKeys(PRODUCTION).length, PRODUCTION).toBeGreaterThan(8);
    expect(optionKeys(SANDBOX).length, SANDBOX).toBeGreaterThan(8);
  });

  it("passes every field the live scheduler passes", () => {
    const prod = optionKeys(PRODUCTION);
    const sim = optionKeys(SANDBOX);
    const missing = prod.filter((k) => !sim.includes(k) && !(k in JUSTIFIED));
    expect(
      missing,
      `lib/messaging/simulator.ts does not pass ${missing.join(", ")} to runAgentTurn, ` +
        "which scheduler-db does. Every rule reading those fields is inert in the sandbox — " +
        "it will not fail, it will simply never run. Pass the field, or add it to JUSTIFIED " +
        "with the reason the absence is harmless."
    ).toEqual([]);
  });

  /**
   * The close guards specifically, because they are the ones that were dead
   * and because the stage is so easily mistaken for them. `stage` is a number
   * answering "how far along are we"; A3 is satisfied by EVENTS, so the guards
   * that refuse a close read the intent list instead. Passing one is not
   * passing the other.
   */
  it("passes the prior intents, not only the stage they collapse to", () => {
    const sim = optionKeys(SANDBOX);
    expect(sim).toContain("stage");
    expect(sim).toContain("priorIntents");
  });

  it("detects a missing field — proving the check can fail", () => {
    const prod = ["priorIntents", "serviceArea", "stage"];
    const simWithout = ["stage"];
    const missing = prod.filter((k) => !simWithout.includes(k) && !(k in JUSTIFIED));
    expect(missing).toEqual(["priorIntents", "serviceArea"]);
  });

  /** A justification must say something, or the allow-list becomes a bin. */
  it("gives a reason for every justified difference", () => {
    for (const [field, why] of Object.entries(JUSTIFIED)) {
      expect(why.length, field).toBeGreaterThan(30);
    }
  });
});

/**
 * ── THE SANDBOX MUST NOT DENY A COMPLIANCE BEHAVIOUR WE HAVE ────────────
 *
 * It said, of HELP: "(No reply is sent. The carrier answers HELP itself.)"
 *
 * That is the reasoning help-reply.ts exists to correct. Its header quotes
 * this exact sentence from simulator.ts and explains why it is wrong here —
 * Twilio answers HELP automatically only for a number with no handler of its
 * own, and ours has one. Production sends the reply from record-inbound.ts,
 * and not answering HELP is a CTIA violation carriers check at verification.
 *
 * So the one screen used to check compliance stated the opposite of what
 * ships, on the rule most likely to be audited. It also survived the whole
 * ctx-parity pass above, because HELP is decided before runAgentTurn is
 * reached and none of those fields touch it.
 *
 * Opt-out is the genuine case of sending nothing, and stays that way.
 */
describe("the sandbox answers HELP, because production does", () => {
  const raw = () => readFileSync("lib/messaging/simulator.ts", "utf8");
  /**
   * Comments stripped, the same way simulator-safety.test.ts does it and for
   * the same reason: the comment explaining why "the carrier answers HELP"
   * was WRONG has to quote it, and a raw match fails on the explanation. That
   * is a false positive which teaches people to water down the comment
   * instead of fixing the code.
   */
  const code = () => raw()
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("does not claim the carrier handles HELP", () => {
    expect(code()).not.toMatch(/carrier answers HELP/i);
  });

  it("keeps the explanation of why that claim was wrong", () => {
    // The comment is the reason written down. Losing it is how the next
    // person re-introduces the line.
    expect(raw()).toMatch(/carrier answers HELP/i);
  });

  it("renders the real reply, from the same function production calls", () => {
    // Not a copy of the words — the function, so the two cannot drift.
    expect(code()).toMatch(/helpReply\(/);
  });

  it("still says nothing at all for an opt-out", () => {
    // The carrier does answer STOP, and adding to it is the breach.
    expect(code()).toMatch(/number is suppressed and nothing further can go out/i);
  });
});
