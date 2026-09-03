import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * No <form> inside another form — including forms that are COMPONENTS.
 *
 * Brendan 2026-09-03: "i have tried to remove tax and its not coming off."
 *
 * He was right and it never could have worked. The Sales-tax <form> sat inside
 * `<AutosaveProposalForm>`, which renders a real <form>. HTML forbids nested
 * forms, so the browser drops the inner one: the Treatment select belonged to
 * the OUTER form, and "Save tax setting" ran `saveProposalAction` instead of
 * `setJobTaxFromProposalAction`. Nothing was written, the page came back
 * looking unchanged, and his PDF kept charging $21,875 in sales tax on a job he
 * had marked a capital improvement.
 *
 * Nothing about the tax code was wrong — checked live: exempt produced no tax
 * line, taxable produced exactly his $21,875. The button submitted the wrong
 * form.
 *
 * The reason it hid for so long is the reason this test counts COMPONENTS as
 * well as tags: a depth count of literal `<form>` elements reports depth 1 at
 * that line and looks perfectly healthy. AGENTS.md already carries the rule
 * ("trace the HTML tree: no nested forms") — a rule with no check is a memo.
 */

const FORM_COMPONENTS = [
  "AutosaveProposalForm",
  "AutosaveForm",
];

/**
 * Strip comments before counting anything.
 *
 * Without this, prose describing the problem counts as the problem: the first
 * run flagged six files, and every one was a comment mentioning `<form>` —
 * including the note explaining this very bug. Grepping source text catches
 * writing about code as readily as code.
 */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // {/* JSX comment */}
    .replace(/\/\*[\s\S]*?\*\//g, "")               // /* block */
    .replace(/^\s*\/\/.*$/gm, "")                     // // line
    .replace(/\/\/.*$/gm, "");                        // trailing //
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (["node_modules", ".next", ".git", "worktrees"].includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Every opener that produces a <form> in the DOM: the tag, and any component
 *  known to render one. */
function openers(line: string): number {
  return (
    (line.match(/<form[\s>]/g) ?? []).length +
    FORM_COMPONENTS.reduce((n, c) => n + (line.match(new RegExp(`<${c}[\\s>]`, "g")) ?? []).length, 0)
  );
}
function closers(line: string): number {
  return (
    (line.match(/<\/form>/g) ?? []).length +
    FORM_COMPONENTS.reduce((n, c) => n + (line.match(new RegExp(`</${c}>`, "g")) ?? []).length, 0)
  );
}

describe("no nested forms", () => {
  const files = [...walk("app/commercial"), ...walk("components/commercial")];

  it("scans a real number of files (guards this test)", () => {
    // A zero-file walk would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(20);
  });

  it("knows which components render a form", () => {
    // If AutosaveProposalForm stops rendering a <form>, or is renamed, this
    // list is stale and the check silently weakens.
    for (const c of FORM_COMPONENTS) {
      const path = files.find((f) => f.endsWith(`${c.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}.tsx`));
      if (!path) continue;
      expect(stripComments(readFileSync(path, "utf8")), `${c} no longer renders a <form>`).toMatch(/<form[\s>]/);
    }
  });

  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    if (!/<form[\s>]/.test(src) && !FORM_COMPONENTS.some((c) => src.includes(`<${c}`))) continue;
    it(`${file.replace("app/commercial/", "").replace("components/commercial/", "")} has no nested form`, () => {
      let depth = 0;
      const offenders: string[] = [];
      src.split("\n").forEach((line, i) => {
        const o = openers(line);
        if (o && depth > 0) offenders.push(`line ${i + 1}: ${line.trim().slice(0, 72)}`);
        depth += o - closers(line);
        if (depth < 0) depth = 0; // a stray closer shouldn't cascade
      });
      expect(
        offenders,
        `a form opened inside another form. The browser drops the inner one, so its submit button runs the OUTER form's action — silently, with the page looking unchanged.`
      ).toEqual([]);
    });
  }
});
