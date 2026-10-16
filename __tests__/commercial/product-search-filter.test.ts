/**
 * THE PRODUCT SEARCH BOX MUST NOT BE ABLE TO WRITE FILTER SYNTAX.
 *
 * listProducts used to escape only the LIKE wildcards and interpolate the rest
 * into `.or(...)`. A comma is PostgREST's OR delimiter and parentheses group,
 * so "Primer, Exterior" became a fourth condition — PostgREST 400'd, the error
 * was swallowed, and the picker said "no products".
 *
 * Asserted by parsing the filter the way PostgREST does (top-level commas
 * outside quotes and parentheses, `"…"` with backslash escapes) and then
 * running the resulting LIKE pattern against real strings — not by looking for
 * quote characters in the output.
 */
import { describe, it, expect } from "vitest";
import { productSearchFilter } from "@/lib/commercial/products/db";

/** Split a PostgREST logic list at its top-level commas. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted && c === "\\") {
      cur += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    else if (!quoted && depth === 0 && c === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** `col.ilike.<value>` → { col, pattern } with PostgREST's quoting undone. */
function parseCondition(cond: string): { col: string; op: string; pattern: string } {
  const [col, op, ...rest] = cond.split(".");
  let v = rest.join(".");
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, "$1");
  return { col, op, pattern: v };
}

/** Postgres ILIKE semantics: % any run, _ one char, backslash escapes. */
function ilike(pattern: string, value: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      re += (pattern[++i] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(value);
}

const NASTY = [
  "Primer, Exterior",
  "Sealer (Clear)",
  "Seal & Poly",
  'Ben "Regal" Select',
  "50%_off",
  "x,deleted_at.not.is.null",
];

describe("productSearchFilter", () => {
  for (const q of NASTY) {
    it(`"${q}" stays exactly three conditions, each a literal substring match`, () => {
      const conds = splitTopLevel(productSearchFilter(q)).map(parseCondition);
      expect(conds.map((c) => `${c.col}.${c.op}`)).toEqual([
        "sku.ilike",
        "name.ilike",
        "variation_label.ilike",
      ]);
      for (const c of conds) {
        expect(ilike(c.pattern, `Benjamin ${q} 5gal`)).toBe(true);
        expect(ilike(c.pattern, q.toUpperCase())).toBe(true);
      }
    });
  }

  it("a wildcard the user typed is a literal, not a wildcard", () => {
    const [{ pattern }] = splitTopLevel(productSearchFilter("50%_off")).map(parseCondition);
    expect(ilike(pattern, "50%_off")).toBe(true);
    expect(ilike(pattern, "50 percent Xoff")).toBe(false);
  });

  it("trims the box the way the caller did", () => {
    const [{ pattern }] = splitTopLevel(productSearchFilter("  primer  ")).map(parseCondition);
    expect(ilike(pattern, "Exterior Primer 1gal")).toBe(true);
    expect(ilike(pattern, "Exterior Prime")).toBe(false);
  });
});
