import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as nodeModule from "node:module";

/**
 * node:module exposes this from Node 22.18, and the @types/node in this repo
 * does not declare it, so it is reached through a cast rather than an import.
 *
 * CI RUNS NODE 20, WHERE IT DOES NOT EXIST. The first version of this file
 * asserted the function was present and failed 137 cases in CI while passing
 * locally on Node 24 — a red gate for everybody, caused by the test rather
 * than by the code. "A check that quietly passes when its instrument is
 * absent is not a check" is still right, so the answer is not to skip: it is
 * to have a second instrument.
 *
 * Exact mode asks node itself and catches every construct, including ones
 * nobody has hit yet. Pattern mode knows only the three that actually occur —
 * parameter properties, enums, namespaces — which is weaker, and still catches
 * the one that took out `npm run verify` this morning. Whichever runs, the
 * file reports which, and neither can pass by doing nothing.
 */
const stripTypeScriptTypes = (nodeModule as unknown as {
  stripTypeScriptTypes?: (code: string, options: { mode: "strip" }) => string;
}).stripTypeScriptTypes;

/** The constructs node's strip-only mode refuses. */
const UNSUPPORTED: { why: string; re: RegExp }[] = [
  // constructor(public readonly to: string) — the one that bit.
  { why: "a constructor parameter property", re: /constructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+\w/s },
  { why: "an enum", re: /(?:^|\n)\s*(?:export\s+)?(?:const\s+)?enum\s+\w/ },
  { why: "a namespace or module block", re: /(?:^|\n)\s*(?:export\s+)?(?:namespace|module)\s+\w+\s*\{/ },
  // import x = require(...) / export = x
  { why: "an import= or export= form", re: /(?:^|\n)\s*(?:import\s+\w+\s*=\s*require|export\s*=)/ },
];

/** Throws like the real stripper when it meets something strip-only refuses. */
function strippableByPattern(src: string): void {
  // Comments describe these constructs all over this repo; they are not them.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const { why, re } of UNSUPPORTED) {
    if (re.test(code)) throw new Error(`strip-only mode cannot parse ${why}`);
  }
}

const strip = stripTypeScriptTypes
  ? (src: string) => { stripTypeScriptTypes(src, { mode: "strip" }); }
  : strippableByPattern;
const mode = stripTypeScriptTypes ? "node's own stripper" : "patterns (this runtime has no stripper)";

/**
 * The end-to-end suite loads this code through node, not through the bundler.
 *
 * Every `verify:*` script imports the real modules with node's strip-only
 * TypeScript mode, which deletes type annotations without understanding them.
 * A handful of TypeScript constructs cannot be removed that way — constructor
 * parameter properties (`constructor(public readonly to: string)`), enums,
 * namespaces — and node refuses the whole FILE when it meets one.
 *
 * So one parameter property in one transport took out `npm run verify`
 * entirely: twenty-odd scripts that each import the gate, which imports the
 * transports. Caught by hand an hour after it shipped, and nothing else could
 * have caught it — `tsc --noEmit` and `next build` are both perfectly happy
 * with the syntax, because for them it is valid TypeScript. It is.
 *
 * TwilioTransport already carried a comment saying exactly this. The class that
 * broke it was added four lines above that comment.
 *
 * This asks node itself rather than matching patterns, so it covers the
 * constructs nobody has hit yet as well as the one that bit.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const FILES = walk("lib/messaging");

describe("every messaging module survives node's strip-only TypeScript", () => {
  it("has the files to check, and something to check them with", () => {
    expect(FILES.length).toBeGreaterThan(50);
    console.log(`  strip-only check running with ${mode}`);
  });

  it("rejects the construct that broke the suite, whichever instrument is in use", () => {
    // The instrument works. Same shape as the line that shipped and took out
    // every verify:* script while tsc and next build stayed green.
    expect(() => strip(
      "class A extends Error { constructor(public readonly to: string) { super(); } }"
    )).toThrow();
    expect(() => strip("export enum Colour { Red, Green }")).toThrow();
    expect(() => strip("export namespace X { export const y = 1; }")).toThrow();
    // And does not fire on ordinary TypeScript.
    expect(() => strip("export function f(a: string): number { return a.length; }")).not.toThrow();
    // Nor on a comment that merely describes the construct, which this repo is
    // full of — including the file above.
    expect(() => strip("// constructor(public readonly to: string) is refused\nexport const a = 1;")).not.toThrow();
  });

  it.each(FILES)("%s", (file) => {
    expect(() => strip(fs.readFileSync(file, "utf8"))).not.toThrow();
  });
});
