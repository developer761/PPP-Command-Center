import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderMessage } from "@/lib/messaging/render";
import {
  END_INTENTS, CONTINUE_INTENTS, NURTURE_END_INTENTS, NURTURE_CONTINUE_INTENTS,
  checkRapport, type Intent,
} from "@/lib/messaging/agent-output";

/**
 * Just the SAYS object.
 *
 * This slice used to run to the next top-level const, which quietly started
 * including the truncation helper when one was added between them — and that
 * helper legitimately contains an ellipsis. A test whose scope drifts when
 * unrelated code moves is a test that will eventually be silenced rather than
 * fixed.
 */
function saysObject(src: string): string {
  const start = src.indexOf("const SAYS");
  const end = src.indexOf("\n};", start);
  return src.slice(start, end);
}

const ALL = [...new Set([
  ...END_INTENTS, ...CONTINUE_INTENTS, ...NURTURE_END_INTENTS, ...NURTURE_CONTINUE_INTENTS,
])] as Intent[];

/**
 * Our own templates have to follow the rules we enforce on the model.
 *
 * They did not. Twenty-seven variants used an em dash, which is the first
 * thing on Kate's banned list and something the post-filter drops the model's
 * rapport for. Enforcing a rule on the model and breaking it ourselves is
 * worse than not having the rule.
 */
describe("the templates obey the tone rules they enforce", () => {
  const known = {
    address: "166 S Park Ave, Rockville Centre, NY 11570",
    phone: "516-784-6046", email: "tom@example.com", scope: "interior painting",
  };

  it("uses no em dash, ellipsis or parentheses in any variant", () => {
    const bad: string[] = [];
    for (const intent of ALL) {
      for (const turn of [0, 1, 2]) {
        const out = renderMessage({ intent, turn, known });
        if (!out) continue;
        // The template is allowed the one question it exists to ask; the rule
        // being checked is that it does not ask a SECOND one.
        const r = checkRapport(out.replace(/\?/g, ""));
        if (!r.ok) bad.push(`${intent}/${turn}: ${r.why} :: ${out}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("asks at most one question per message", () => {
    for (const intent of ALL) {
      for (const turn of [0, 1, 2]) {
        const out = renderMessage({ intent, turn, known });
        expect((out.match(/\?/g) ?? []).length, `${intent}/${turn}: ${out}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never says "Yep" or "Thanks for letting me know"', () => {
    const src = readFileSync("lib/messaging/render.ts", "utf8");
    // Source-level, so a variant that only appears at a turn number this test
    // does not reach is still caught.
    const templateArea = saysObject(src);
    expect(templateArea).not.toMatch(/\bYep\b/);
    expect(templateArea).not.toMatch(/thanks for letting me know/i);
  });

  it("has no em dash in any template string, not just the ones rendered here", () => {
    const src = readFileSync("lib/messaging/render.ts", "utf8");
    const templateArea = saysObject(src);
    // Strip comments — an em dash in prose explaining the rule is not a
    // violation of it.
    const code = templateArea.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/[—–]/);
    expect(code).not.toMatch(/\.\.\.|…/);
  });

  /**
   * The one place an ellipsis is allowed, and only as a truncation marker on
   * a value the customer themselves wrote.
   */
  it("marks a shortened quote and keeps the message a sane length", () => {
    const long = "x ".repeat(3000);
    const out = renderMessage({ intent: "confirm_scope", known: { scope: long } });
    expect(out.length).toBeLessThan(300);
    expect(out).toContain("…");
  });

  it("does not shorten a scope that is already short", () => {
    const out = renderMessage({ intent: "confirm_scope", known: { scope: "interior painting" } });
    expect(out).toContain("interior painting");
    expect(out).not.toContain("…");
  });

  /** The phone we read back must not reintroduce parentheses. */
  it("reads a contact back without brackets", () => {
    const out = renderMessage({ intent: "confirm_contact", known });
    expect(out).toContain("516-784-6046");
    expect(out).not.toMatch(/[()]/);
  });
});
