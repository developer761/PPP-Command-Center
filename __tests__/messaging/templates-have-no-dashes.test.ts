import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { renderMessage, SILENT_INTENTS } from "@/lib/messaging/render";
import { END_INTENTS, CONTINUE_INTENTS, type Intent } from "@/lib/messaging/agent-output";
import { stripComments } from "../helpers/strip-comments";

/**
 * A23 — NO EM OR EN DASH IN ANYTHING WE SEND. 2026-10-16.
 *
 * PHONE_PRICING_NO_ADDRESS opened "That's no problem — we can do this over
 * the phone instead." The validator refuses that dash in the model's
 * rapport; the template sent it, and no check read templates for it.
 * language.test's syntax-tree sweep looks for inverted punctuation only.
 *
 * Same method as that sweep: every string literal in the files that hold
 * customer copy, read from the syntax tree so an escape cannot hide one, plus
 * every intent rendered in both languages.
 */
const COPY_FILES = [
  "lib/messaging/render.ts",
  "lib/messaging/render-es.ts",
  "lib/messaging/appointment-time.ts",
  "lib/messaging/disclosure.ts",
  "lib/messaging/availability-ask.ts",
  "lib/messaging/returning-customer.ts",
  "lib/messaging/multi-property.ts",
];
const DASH = /[—–]/;

describe("A23: no dash in customer copy", () => {
  it.each(COPY_FILES)("has no em or en dash in any string in %s", (path) => {
    const src = stripComments(readFileSync(path, "utf8"));
    const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true);
    const hits: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
      ) {
        if (DASH.test(node.text)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          hits.push(`${path}:${line + 1} ${JSON.stringify(node.text).slice(0, 80)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(hits).toEqual([]);
  });

  it("renders no dash for any intent, in either language", () => {
    const ALL: Intent[] = [...END_INTENTS, ...CONTINUE_INTENTS];
    const hits: string[] = [];
    for (const intent of ALL) {
      if (SILENT_INTENTS.has(intent)) continue;
      for (const language of ["en", "es"] as const) {
        for (const turn of [0, 1, 2]) {
          // With and without an address: phone_pricing has its own wording
          // for no address, and that is the template that carried the dash.
          for (const address of ["12 Oak St", null]) {
            const out = renderMessage({
              intent, turn, language,
              known: { scope: "kitchen", zip: "11530", state: "Florida", address },
              offsiteReason: language === "es" ? "no puede estar en la propiedad" : "you can't be at the property",
            } as never);
            if (DASH.test(out)) hits.push(`${intent}/${language}/${turn}: ${out}`);
          }
        }
      }
    }
    expect(hits).toEqual([]);
  });

  /** The phone price with no address, the template that carried the dash. */
  it("phone_pricing with no address sends no dash", () => {
    for (const turn of [0, 1]) {
      const out = renderMessage({ intent: "phone_pricing", turn, known: { scope: "kitchen", address: null } });
      expect(out).toMatch(/phone/);
      expect(out).not.toMatch(DASH);
    }
  });

  /** CONTROL: the sweep sees a dash when there is one. */
  it("catches a dash, including an escaped one", () => {
    const sf = ts.createSourceFile("t.ts", 'const a = "x \\u2014 y";', ts.ScriptTarget.Latest, true);
    let found = false;
    const visit = (n: ts.Node): void => { if (ts.isStringLiteral(n) && DASH.test(n.text)) found = true; ts.forEachChild(n, visit); };
    visit(sf);
    expect(found).toBe(true);
  });
});
