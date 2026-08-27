import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * "The hub never writes MaterialType__c." — Kate, R6.2.
 *
 * That field is the ESTIMATOR's answer, carried from Quote.MaterialType__c when
 * the opportunity closes won. Its whole value is being able to read what was
 * sold next to what was ordered, and a single hub write destroys that
 * comparison permanently — there is no history to recover it from.
 *
 * Reading it is fine and expected: it seeds the AM's picker. Only WRITES are
 * forbidden, so this looks for the field appearing in an update payload rather
 * than anywhere in the file.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (f.endsWith(".ts") || f.endsWith(".tsx")) out.push(f);
  }
  return out;
}
const ROOT = process.cwd();
const FILES = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))]
  .filter((f) => !f.includes("/commercial/") && !f.includes("commercial-"));

/** Strip comments — the rule is explained in prose all over this codebase. */
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("MaterialType__c stays the estimator's answer", () => {
  it("no code path puts MaterialType__c in a Salesforce update payload", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = codeOnly(readFileSync(f, "utf8"));
      // `fields: { MaterialType__c: ... }` is how every write in this codebase
      // is shaped — a batch attempt or a direct sObject update.
      // [\s\S] rather than the /s flag — the tsconfig target predates it.
      if (/fields\s*:\s*\{[^}]*\bMaterialType__c\s*:/.test(src.replace(/\n/g, " "))) {
        offenders.push(f.replace(ROOT + "/", ""));
      }
    }
    expect(offenders, "R6.2: the hub must never write MaterialType__c").toEqual([]);
  });

  it("the submit route writes Product_Lines__c instead", () => {
    // Guards the guard: if the write moved or was removed entirely, the
    // assertion above would pass vacuously while nothing recorded the choice.
    const route = readFileSync(join(ROOT, "app/api/customer-form/submit/[token]/route.ts"), "utf8");
    expect(route).toMatch(/fields:\s*\{\s*Product_Lines__c:/);
    expect(route).toMatch(/formatProductLines/);
  });

  it("still READS MaterialType__c, because it seeds the AM's default", () => {
    // Kate: "The hub reads it as the starting default." Losing the read would
    // silently drop the estimator's suggestion from the picker.
    const anyRead = FILES.some((f) => /MaterialType__c/.test(readFileSync(f, "utf8")));
    expect(anyRead, "the estimator's value is no longer read anywhere").toBe(true);
  });
});
