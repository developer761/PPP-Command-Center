import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A link's first query separator is `?`, not `&`.
 *
 * Karan 2026-09-17: "make sure there's no dead or old pages it ever brings me
 * to, because it happened before with Brendan and it brought him to like a
 * random opp page."
 *
 * One real 404 was exactly this, on the deal-name link in an invoice header:
 *
 *     `/commercial/opportunities/${opp.id}${opp.archived_at ? "&archived=1" : ""}`
 *
 * For an ARCHIVED deal that emits `/commercial/opportunities/<uuid>&archived=1`
 * — and the whole string is the `[id]` path segment, so `UUID_RE.test(id)`
 * fails and the page calls `notFound()`. Clicking the job from its own invoice
 * landed on "that record isn't here", but only for archived deals, which is why
 * it survived. The comment directly above it explained, correctly, why
 * `?archived=1` needed to be carried.
 *
 * Nothing about that is visible in review: the template reads fine, the
 * conditional reads fine, and the ternary's two branches are individually
 * correct.
 */

const ROOTS = ["app/commercial", "components/commercial", "lib/commercial", "lib/notifications"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(join(process.cwd(), r))).map((p) =>
  p.replace(process.cwd() + "/", "")
);

describe("internal links", () => {
  /**
   * Reduce a template literal to the text it can actually EMIT.
   *
   * The first version of this compared the position of `&` against the position
   * of `?` in the raw source, and missed the real bug outright — because
   * `${opp.archived_at ? "&archived=1" : ""}` contains a `?`, the TERNARY's,
   * which sat before the `&` and looked like a query separator. A check that
   * cannot see the one defect it was written for is worse than no check.
   *
   * So `${…}` holes are replaced by the string literals inside them, in order.
   * Both branches of a ternary are appended, which over-approximates — and that
   * is the right direction here: it asks "can this ever emit a `&` before a
   * `?`", which is exactly the question.
   */
  const emitted = (lit: string): string => {
    let out = "";
    let i = 0;
    while (i < lit.length) {
      if (lit[i] === "$" && lit[i + 1] === "{") {
        let depth = 1;
        let j = i + 2;
        while (j < lit.length && depth > 0) {
          if (lit[j] === "{") depth++;
          else if (lit[j] === "}") depth--;
          j++;
        }
        const expr = lit.slice(i + 2, j - 1);
        for (const m of expr.matchAll(/"([^"]*)"|'([^']*)'/g)) out += m[1] ?? m[2] ?? "";
        i = j;
      } else {
        out += lit[i];
        i++;
      }
    }
    return out;
  };

  it("never open their query string with &", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      src.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/`(\/commercial\/[^`]*)`/g)) {
          const out = emitted(m[1]);
          const amp = out.indexOf("&");
          if (amp === -1) continue;
          if (out.slice(amp).startsWith("&amp;")) continue;
          const q = out.indexOf("?");
          if (q === -1 || amp < q) {
            bad.push(`${f}:${i + 1}  ${m[1].trim().slice(0, 100)}`);
          }
        }
      });
    }
    expect(
      bad,
      `these can emit a path segment instead of a query — the page 404s:\n${bad.join("\n")}`
    ).toEqual([]);
  });

  it("measured something — the link literals are still where this looks", () => {
    // Without this the assertion passes trivially if the glob or the pattern
    // ever stops matching, and the check silently covers nothing.
    const all = files.map((f) => readFileSync(join(process.cwd(), f), "utf8")).join("\n");
    expect([...all.matchAll(/`\/commercial\//g)].length).toBeGreaterThan(100);
    expect(files.length).toBeGreaterThan(150);
  });
});
