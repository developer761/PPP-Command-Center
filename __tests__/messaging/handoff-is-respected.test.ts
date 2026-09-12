import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * When a person takes a conversation over, the bot goes quiet — on every path.
 *
 * There turned out to be three separate ways a message reaches the customer,
 * and each needed the guard written into it by hand:
 *
 *   agent turns     scheduler-db.draftReply   skipped only 'ended'
 *   campaign steps  scheduler.runAction       skipped only 'ended'
 *   the review queue drafts-write.sendDraft   never read the conversation at all
 *
 * The third is the one worth remembering: a human presses that button, so it
 * looks deliberate, and nothing about it suggested it could be sending into a
 * conversation somebody else had already taken over.
 *
 * A fourth path added later would have the same hole and nothing would say so,
 * because none of this is visible to tsc or to the build. So: anything that
 * reaches the carrier must demonstrate it knows about the holder.
 */

/** Modules allowed to call gatedSend, and what each must acknowledge. */
const CARRIER_CALLERS: Record<string, RegExp> = {
  // Sends a reply a person approved. Must refuse when somebody else holds it.
  "lib/messaging/drafts-write.ts": /owning_user_id/,
  // Runs agent turns. Must skip a conversation a person has.
  "lib/messaging/scheduler-db.ts": /human_active/,
};

/** The gate itself and the transports are the chokepoint, not callers. */
const NOT_A_CALLER = new Set([
  "lib/messaging/gate.ts",
  // Only names gatedSend in a comment explaining it must never call it;
  // simulator-safety.test.ts enforces that separately.
  "lib/messaging/simulator.ts",
]);

function libFiles(): string[] {
  return readdirSync("lib/messaging")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join("lib/messaging", f));
}

describe("the handoff is respected on every path to the customer", () => {
  it("the set of carrier callers has not changed", () => {
    const callers = libFiles().filter((f) => readFileSync(f, "utf8").includes("gatedSend"));
    const unexpected = callers.filter(
      (f) => !(f in CARRIER_CALLERS) && !NOT_A_CALLER.has(f)
    );
    expect(
      unexpected,
      `a new way to reach the customer appeared. It must refuse to send into a\n` +
        `conversation somebody has taken over — then add it to CARRIER_CALLERS:\n${unexpected.join("\n")}`
    ).toEqual([]);
  });

  it("each caller checks who holds the conversation", () => {
    const missing: string[] = [];
    for (const [file, needle] of Object.entries(CARRIER_CALLERS)) {
      const src = readFileSync(file, "utf8");
      if (!needle.test(src)) missing.push(`${file} (no ${needle})`);
    }
    expect(missing, `sends without knowing who holds it:\n${missing.join("\n")}`).toEqual([]);
  });

  it("campaign steps defer rather than sending into a held conversation", () => {
    // This one lives in scheduler.ts rather than a carrier caller, because the
    // state arrives through resolve() before the send is attempted.
    const src = readFileSync("lib/messaging/scheduler.ts", "utf8");
    expect(src).toMatch(/conversationState === "human_active"/);
    expect(src).toMatch(/reschedule/);
  });

  it("handing it back re-queues an answer the customer is still owed", () => {
    // A message that arrived during the hold had its turn cancelled. Without
    // this, releasing leaves ai_active with nothing scheduled and the customer
    // is answered by nobody, ever.
    const src = readFileSync("lib/messaging/handoff-write.ts", "utf8");
    expect(src).toMatch(/queueTurnIfUnanswered/);
  });

  it("the turn queuer is not a public endpoint", () => {
    // Every export of a "use server" module is a POST endpoint any signed-in
    // user can call. This one queues agent work without checking who asked, so
    // it must live outside that boundary.
    const src = readFileSync("lib/messaging/turn-queue.ts", "utf8");
    expect(src.trimStart().startsWith('"use server"')).toBe(false);
    expect(src).not.toMatch(/^["']use server["']/m);
  });

  it("the checks can fail", () => {
    // Controls. Each assertion above passes trivially if its needle is wrong.
    expect(/owning_user_id/.test("nothing here")).toBe(false);
    expect(/human_active/.test('if (conv.state === "human_active")')).toBe(true);
    expect(Object.keys(CARRIER_CALLERS).length).toBeGreaterThan(1);
  });
});
