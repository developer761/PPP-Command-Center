import { describe, it, expect } from "vitest";
import { checkRapport } from "@/lib/messaging/agent-output";

/**
 * A41 — "Do not block the flow on a REFUSAL. If they decline to give a
 * field, continue and move on."
 *
 * The INTENT half is enforced: a refused field does not stop ask_address
 * happening. The WORDING half was not, so the bot could tell a customer who
 * had just declined that the conversation is stuck until they relent — the
 * exact deadlock A41 exists to prevent, said in the one place nothing
 * checked.
 *
 * DEFENCE IN DEPTH, and labelled as such: this fires on 0 of 2,155 faulted
 * and 0 of 651 praised messages in Kate's corpus. The language has not
 * occurred. It is worth having because the prompt is otherwise the only
 * thing between a customer and a dead conversation, and the false-positive
 * risk measured zero.
 */
const R = (t: string) => checkRapport(t, undefined, true, false);

describe("A41 — the bot never says the conversation cannot continue", () => {
  it.each([
    "I can't continue without it, so I'll need you to give me that field.",
    "Unfortunately I can't move forward until you give me the zip.",
    "We can't proceed without your email.",
    "I'm unable to continue unless you provide the address.",
    "I do need the address before we can go any further.",
    "Since you've declined, I have to stop here.",
    "That's a required field, I can't skip it.",
    "No puedo continuar sin la direccion.",
  ])("refuses %j", (t) => {
    expect(R(t).ok).toBe(false);
  });

  /**
   * THE LINE IT MUST NOT CROSS, and it is a busy one. A15 and A1 REQUIRE the
   * bot to say what it cannot do — these are among the most common honest
   * sentences it sends. The difference is what the inability is tied to: a
   * block conditions it on the customer handing something over, an honest
   * limit names what the bot cannot do and hands off.
   */
  it.each([
    "I can't set times myself, but the office handles scheduling.",
    "I can't quote a price, the estimator will put that together.",
    "I'm not able to see the number you're texting from.",
    "The estimator will confirm that with you directly.",
    "No problem, we can work with that.",
    "We can get you a quick quote instead.",
    "Happy to help with that.",
  ])("allows the honest limit %j", (t) => {
    expect(R(t).ok).toBe(true);
  });

  it("names the rule in the refusal, so the model can correct itself", () => {
    const r = R("We can't proceed without your email.");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.why).toMatch(/A41/);
  });
});
