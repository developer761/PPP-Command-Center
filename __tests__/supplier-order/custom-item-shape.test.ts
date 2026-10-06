import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `CustomItem` in order-builder-view.tsx is a hand-copy of `CustomColorItem`
 * in lib/supplier-order/builder.ts, because builder.ts is `server-only` and a
 * client component cannot import from it.
 *
 * The copy had already drifted once: `scope` was added to the canonical type
 * on 2026-10-06 and not to the component's, which only surfaced because tsc
 * happened to be run. A field that exists on one side and not the other is a
 * value the screen collects and the email never sends, or the reverse — so
 * this pins the two field lists together instead of relying on a type error
 * that only appears when the new field is actually referenced.
 */

const root = join(__dirname, "..", "..");

/** Field names declared in a `type X = { … }` block, comments stripped. */
function fieldsOf(source: string, typeName: string): string[] {
  const start = source.indexOf(`type ${typeName} = {`);
  if (start < 0) throw new Error(`type ${typeName} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = source
    .slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
  // Only top-level keys: every field here is a primitive, so depth never grows.
  return [...body.matchAll(/(^|[;,{\s])([A-Za-z_][A-Za-z0-9_]*)\??\s*:/g)]
    .map((m) => m[2])
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
}

describe("the custom-item shape is the same on both sides", () => {
  it("declares identical fields in the component and the builder", () => {
    const component = readFileSync(join(root, "components/order-builder-view.tsx"), "utf8");
    const builder = readFileSync(join(root, "lib/supplier-order/builder.ts"), "utf8");

    const inComponent = fieldsOf(component, "CustomItem");
    const inBuilder = fieldsOf(builder, "CustomColorItem");

    expect(inComponent).toEqual(inBuilder);
    // Sanity: the parse found a real shape, not an empty one that would make
    // the comparison above pass by matching nothing.
    expect(inBuilder).toContain("label");
    expect(inBuilder).toContain("scope");
    expect(inBuilder.length).toBeGreaterThanOrEqual(7);
  });
});
