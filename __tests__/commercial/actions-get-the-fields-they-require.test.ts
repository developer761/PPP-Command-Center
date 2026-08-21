import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY form must post the ids its action refuses to run without.
 *
 * This is the generalisation of the bug Stephanie reported twice over:
 * "Once sent for approval, it brings you all the way back to the accounts page"
 * AND "Change orders emailed to customer not coming through" were one omission
 * — the Send form was the only form in its panel not posting opp_id and
 * account_id, and sendChangeOrderAction bails to /commercial/accounts when
 * either fails UUID_RE, BEFORE it sends anything.
 *
 * There are ~125 actions across Commercial carrying that shape of guard. Every
 * one is a button that can silently dump a person on a list page having done
 * nothing, and NOTHING catches it: FormData is stringly-typed on both sides, so
 * the action compiles perfectly while reading a field nobody posts.
 *
 * This walks every Commercial surface, works out which formData keys each
 * action gates on, and checks the forms bound to that action in the same file
 * actually post them.
 *
 * SCOPE, stated honestly: it can only see forms in the SAME FILE as their
 * action. When an action is handed to a component as a prop — which is exactly
 * how the change-order bug hid — the pairing is checked by
 * forms-post-their-ids.test.ts instead, which walks the panel. Both are needed;
 * neither is sufficient.
 */

const ROOT = "app/commercial";

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** `const opp_id = String(formData.get("opp_id") ?? "")` → opp_id ⇒ "opp_id". */
function varToField(body: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of body.matchAll(/const\s+(\w+)\s*=\s*String\(\s*formData\.get\("([a-z_]+)"\)/g)) {
    m.set(d[1], d[2]);
  }
  return m;
}

type Action = { name: string; required: string[] };

function actionsIn(src: string): Action[] {
  const out: Action[] = [];
  for (const m of src.matchAll(/async function (\w+)\s*\(\s*formData: FormData\s*\)/g)) {
    const start = m.index! + m[0].length;
    const rest = src.slice(start);
    const nextAt = rest.search(/\nasync function /);
    const body = nextAt === -1 ? rest.slice(0, 3000) : rest.slice(0, nextAt);
    const map = varToField(body);
    const required = new Set<string>();
    // Only guards that BAIL to another page. A guard that re-renders with an
    // error message is a different, honest thing.
    for (const g of body.matchAll(/UUID_RE\.test\([\s\S]{0,300}?redirect\("\/commercial/g)) {
      for (const v of g[0].matchAll(/UUID_RE\.test\((\w+)\)/g)) {
        const field = map.get(v[1]);
        if (field) required.add(field);
      }
    }
    if (required.size > 0) out.push({ name: m[1], required: [...required] });
  }
  return out;
}

/**
 * Fields emitted by a shared hidden-input helper.
 *
 * Several tools factor the common ids into one place — `const ctx = (<>…</>)`
 * or `const Ctx = () => (<>…</>)` — and drop `{ctx}` / `<Ctx />` into each
 * form. A scanner that only reads `name="…"` inside the <form> tag sees those
 * forms as missing everything, which is 13 false alarms on this codebase. An
 * audit that cries wolf gets switched off, so it resolves the helper instead.
 */
function contextFields(src: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(?:\(\)\s*=>\s*)?\(\s*<>([\s\S]{0,1200}?)<\/>/g)) {
    const fields = new Set([...m[2].matchAll(/name="([a-z_]+)"/g)].map((x) => x[1]));
    if (fields.size > 0) out.set(m[1], fields);
  }
  return out;
}

/** Forms in this file bound to `action={name}`, with the fields they post. */
function formsFor(src: string, action: string): { line: number; fields: Set<string> }[] {
  const out: { line: number; fields: Set<string> }[] = [];
  for (const m of src.matchAll(new RegExp(`<form[^>]*\\saction=\\{${action}\\}`, "g"))) {
    const end = src.indexOf("</form>", m.index!);
    if (end === -1) continue;
    const body = src.slice(m.index!, end);
    const fields = new Set([...body.matchAll(/name="([a-z_]+)"/g)].map((x) => x[1]));
    // Pull in whatever a referenced context helper contributes.
    for (const [helper, helperFields] of contextFields(src)) {
      const used = new RegExp(`\\{\\s*${helper}\\s*\\}|<${helper}\\s*/>`).test(body);
      if (used) for (const f of helperFields) fields.add(f);
    }
    out.push({ line: src.slice(0, m.index!).split("\n").length, fields });
  }
  return out;
}

describe("a form never submits into a guard it can't satisfy", () => {
  const files = walk(ROOT);

  it("checks a meaningful number of surfaces", () => {
    // Guards the test itself: a refactor that changes how actions are declared
    // would otherwise make this file pass by finding nothing at all.
    const total = files.reduce((n, f) => n + actionsIn(readFileSync(f, "utf8")).length, 0);
    expect(total, "found no guarded actions — has the action shape changed?").toBeGreaterThan(50);
  });

  it("actually inspects a meaningful number of form/action pairs", () => {
    // Without this, a regex that stopped matching <form> would make the check
    // below pass by examining nothing — the same shape of failure as the
    // migration parser that reported fixed tables as broken, except silent.
    let pairs = 0;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const action of actionsIn(src)) pairs += formsFor(src, action.name).length;
    }
    expect(pairs, "no form/action pairs found — the scan is inspecting nothing").toBeGreaterThan(40);
  });

  it("every same-file form posts what its action requires", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const action of actionsIn(src)) {
        for (const form of formsFor(src, action.name)) {
          const missing = action.required.filter((f) => !form.fields.has(f));
          if (missing.length > 0) {
            offenders.push(
              `${file}:${form.line} — <form action={${action.name}}> omits ${missing
                .map((x) => `"${x}"`)
                .join(", ")}, which the action bails to a list page without. ` +
                `The button will look like it worked and will have done nothing.`
            );
          }
        }
      }
    }
    expect(offenders, `\n${offenders.join("\n")}\n`).toEqual([]);
  });
});
