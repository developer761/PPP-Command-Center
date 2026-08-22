import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Two different slug names on one path segment breaks the whole app.
 *
 * On 2026-08-22 I added /api/commercial/aia/[id]/lien-waiver beside the
 * existing /api/commercial/aia/[applicationId]/export. Next refuses that:
 *
 *   Error: You cannot use different slug names for the same dynamic path
 *          ('id' !== 'applicationId').
 *
 * It is not a warning about one route. The dev server does not boot — every
 * page on the platform is down.
 *
 * AND `next build` EXITS 0. tsc passes, the tests pass, the build passes; the
 * app does not start. I shipped it and only found out because I happened to
 * start a dev server two commits later for something else. Nothing in the
 * normal verification path can see it, which is exactly why it is a test.
 */

const ROOT = "app";

function dirsIn(dir: string): string[] {
  return readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
}

/** Walk every route directory, collecting the slug names used at each path. */
function collect(dir: string, path: string, out: Map<string, Map<string, string[]>>) {
  const children = dirsIn(dir);
  const slugs = children.filter((c) => c.startsWith("[") && c.endsWith("]"));
  if (slugs.length > 0) {
    // Route groups "(x)" do not create a URL segment, so the parent path is the
    // key that matters — not the folder path.
    const bucket = out.get(path) ?? new Map<string, string[]>();
    for (const s of slugs) {
      // [id] and [...id] and [[...id]] all occupy the same segment.
      const name = s.replace(/^\[+\.{0,3}/, "").replace(/\]+$/, "");
      bucket.set(name, [...(bucket.get(name) ?? []), join(dir, s)]);
    }
    out.set(path, bucket);
  }
  for (const c of children) {
    const seg = c.startsWith("(") && c.endsWith(")") ? "" : `/${c}`;
    collect(join(dir, c), path + seg, out);
  }
}

describe("dynamic route segments", () => {
  it("never use two different slug names at the same path", () => {
    const found = new Map<string, Map<string, string[]>>();
    collect(ROOT, "", found);

    const clashes: string[] = [];
    for (const [path, names] of found) {
      if (names.size > 1) {
        const detail = [...names.entries()]
          .map(([n, dirs]) => `  [${n}] — ${dirs.join(", ")}`)
          .join("\n");
        clashes.push(
          `${path || "/"} uses ${names.size} different slug names:\n${detail}\n` +
            `Next refuses this and the dev server will not boot. Pick one name ` +
            `for the segment (the one already there).`
        );
      }
    }
    expect(clashes, `\n${clashes.join("\n\n")}\n`).toEqual([]);
  });

  it("is actually walking the route tree", () => {
    // A broken walk would report no clashes for the same reason it reports
    // nothing at all.
    const found = new Map<string, Map<string, string[]>>();
    collect(ROOT, "", found);
    expect(found.size, "no dynamic segments found — the walk is broken").toBeGreaterThan(10);
  });
});
