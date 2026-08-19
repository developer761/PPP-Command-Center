import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The color form is the only PPP surface an outside member of the public uses,
 * unauthenticated, usually on a phone. An a11y regression here is silent — it
 * type-checks, it renders, it looks right, and nobody on the team would ever
 * notice, because nobody on the team reaches it with a screen reader.
 *
 * These are the three failures the persona audit found, each locked so the next
 * refactor can't quietly undo them:
 *
 *  1. ~30 anonymous controls. A room has a color search, a finish dropdown and
 *     a skip toggle per surface, all identified only by a visual label sitting
 *     in a sibling element. Announced without one, the form is a wall of
 *     identical "Choose a finish…" comboboxes with no way to tell which room or
 *     surface any of them belongs to.
 *  2. Submit failure was announced to nobody. The error block renders BELOW the
 *     button, so on a phone it appears off-screen: press Submit, hear nothing,
 *     see nothing move, close the tab believing you're done.
 *  3. The submit button was white on #2baae1 — 2.64:1, under both the AA 4.5:1
 *     bar and the 3:1 large-text floor.
 */

const src = readFileSync(join(process.cwd(), "components/customer-form-view.tsx"), "utf8");

/** Strip comments so an explanation of a rule can't satisfy the rule. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const code = codeOnly(src);

/**
 * The JSX attributes of the first tag opened at/after `from`.
 *
 * Can't just scan to the next ">" — an inline arrow handler (`ref={(el) =>
 * el?.focus()}`) contains one. Track brace depth and stop at the first ">" that
 * sits outside any `{...}` expression.
 */
function attrsOfTagAt(source: string, from: number): string {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return source.slice(from, i);
  }
  return source.slice(from);
}

describe("customer form accessibility", () => {
  it("names every per-surface control with its surface and room", () => {
    // The row builds one string and hands it to each control, so the assertion
    // is on that string existing and reaching all four of them.
    expect(code).toMatch(/const rowContext = `\$\{surface\}, \$\{roomLabel\}`/);

    const finishSelect = code.indexOf("<select");
    expect(finishSelect).toBeGreaterThan(-1);
    expect(attrsOfTagAt(code, finishSelect)).toContain("aria-label={`Finish for ${rowContext}`}");

    // Color search input.
    const searchInput = code.indexOf('<input\n          type="text"');
    expect(searchInput).toBeGreaterThan(-1);
    expect(attrsOfTagAt(code, searchInput)).toContain("aria-label={`Color for ${rowContext}`}");

    // Skip / un-skip toggles: three renderings (mobile inline, skipped-state
    // revert, desktop link) that all read "Skip this" / "Add color" out of
    // context. Each must carry its own label.
    const toggleLabels = code.match(/aria-label=\{[^}]*rowContext[^}]*\}/g) ?? [];
    expect(toggleLabels.length).toBeGreaterThanOrEqual(5);

    // And the room notes box, whose <label> is a sibling, not a `for=` target.
    expect(code).toContain("aria-label={`Notes for ${title}`}");
  });

  it("announces a submit failure and moves focus to it", () => {
    const block = code.indexOf("{submitError && (");
    expect(block).toBeGreaterThan(-1);
    const attrs = attrsOfTagAt(code, code.indexOf("<div", block));
    expect(attrs).toContain('role="alert"');
    // Announcing alone isn't enough — the block renders below the fold on a
    // phone, so a sighted keyboard user still wouldn't see it.
    expect(attrs).toContain("tabIndex={-1}");
    expect(attrs).toContain("focus()");
  });

  it("keeps the submit button above the AA contrast bar", () => {
    const submit = code.indexOf("Submit my colors");
    expect(submit).toBeGreaterThan(-1);
    // Walk back to the button's className.
    const before = code.slice(Math.max(0, submit - 1500), submit);
    // Only the RESTING background counts. `hover:bg-ppp-blue-800` also contains
    // "bg-ppp-blue", and matching it made this test pass against the original
    // 2.64:1 button — the exact defect it exists to catch.
    const resting = [...before.matchAll(/(^|[\s"'])bg-ppp-blue(-\d+)?\b/g)].at(-1);
    expect(resting, "no unprefixed bg-ppp-blue* on the submit button").toBeDefined();
    const token = `bg-ppp-blue${resting![2] ?? ""}`;
    // #2baae1 (bare `bg-ppp-blue`, and -400/-500/-600) all fail 4.5:1 on white.
    expect(["bg-ppp-blue-700", "bg-ppp-blue-800", "bg-ppp-blue-900"]).toContain(token);
  });
});
