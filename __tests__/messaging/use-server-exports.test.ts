import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

/**
 * A "use server" module may export ONLY async functions.
 *
 * Exporting a plain const from one makes Next drop EVERY export in the module
 * — the importing page then fails with "the module has no exports at all",
 * which names neither the const nor the rule. The type checker cannot see it;
 * only the production build catches it, and only if somebody runs one.
 *
 * Adding `export const MAX_ROWS = 2000` to optout-import-write.ts broke the
 * build exactly this way. Types are fine: they are erased before Next sees
 * them.
 */
const DIRS = ["lib/messaging", "lib/commercial"];

function serverFiles(): string[] {
  const out: string[] = [];
  for (const dir of DIRS) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith(".ts")) continue;
      const p = `${dir}/${f}`;
      if (readFileSync(p, "utf8").startsWith('"use server"')) out.push(p);
    }
  }
  return out;
}

/** Exports that are neither an async function nor a type. */
function illegalExports(src: string): string[] {
  const bad: string[] = [];
  for (const m of src.matchAll(/^export\s+(?!async\s+function\b)(?!type\b)(?!interface\b)(\w+)/gm)) {
    bad.push(m[1]);
  }
  return bad;
}

describe('"use server" modules export only async functions', () => {
  it("finds the files it claims to scan", () => {
    expect(serverFiles().length).toBeGreaterThanOrEqual(6);
  });

  it("has no const, let, class or sync function export", () => {
    const offenders: string[] = [];
    for (const f of serverFiles()) {
      for (const name of illegalExports(readFileSync(f, "utf8"))) {
        offenders.push(`${f} :: export ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("detects the exact break that shipped — proving the check can fail", () => {
    expect(illegalExports('"use server";\nexport const MAX_ROWS = 2000;\n')).toEqual(["const"]);
    expect(illegalExports('"use server";\nexport function sync() {}\n')).toEqual(["function"]);
    expect(illegalExports('"use server";\nexport class Thing {}\n')).toEqual(["class"]);
  });

  it("allows what is legal", () => {
    expect(illegalExports('"use server";\nexport async function go() {}\n')).toEqual([]);
    expect(illegalExports('"use server";\nexport type T = { a: string };\n')).toEqual([]);
  });
});
