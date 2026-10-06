import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as nodeModule from "node:module";

/**
 * node:module exposes this from Node 22.18, but the @types/node in this repo
 * does not declare it yet, so it is reached through a cast rather than an
 * import. Missing at RUNTIME is a different matter and is asserted below: a
 * check that quietly passes when its instrument is absent is not a check.
 */
const stripTypeScriptTypes = (nodeModule as unknown as {
  stripTypeScriptTypes?: (code: string, options: { mode: "strip" }) => string;
}).stripTypeScriptTypes;

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
    // Without this every case below would pass by doing nothing.
    expect(typeof stripTypeScriptTypes, "node:module.stripTypeScriptTypes is gone — this whole file is now inert").toBe("function");
  });

  it("rejects the construct that broke the suite", () => {
    // The instrument works. Same shape as the line that shipped.
    expect(() => stripTypeScriptTypes!(
      "class A extends Error { constructor(public readonly to: string) { super(); } }",
      { mode: "strip" }
    )).toThrow();
  });

  it.each(FILES)("%s", (file) => {
    const src = fs.readFileSync(file, "utf8");
    expect(() => stripTypeScriptTypes!(src, { mode: "strip" })).not.toThrow();
  });
});
