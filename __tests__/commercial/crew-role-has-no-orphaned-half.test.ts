import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The Crew role must not have a half nobody can reach.
 *
 * `linkEmployeeToUser` was written alongside the Crew role in 2026-08 —
 * duplicate-link guard, audit trail, the lot — and then never called. A
 * repo-wide search on 2026-09-24 found the definition, the build spec, and no
 * caller anywhere in app/ or components/.
 *
 * That turned a feature into a trap. Pressing "Restrict to crew" confines a
 * login to five screens; all five resolve the person through
 * `commercial_employees.user_id`; and nothing in the product could set that
 * column. So the button locked someone out of the whole platform, left them on
 * "Almost there" forever, and the only way back was a hand-written UPDATE. The
 * live database agreed: 24 employees, zero linked.
 *
 * ── WHY THIS SHAPE ─────────────────────────────────────────────────────────
 *
 * It asserts on the SEAM — is there a caller — not on the function's contents,
 * which were never the problem and were in fact correct. Typechecking cannot
 * see this: an exported function with no callers is perfectly well-typed. The
 * unit suite cannot see it either; you can test `linkEmployeeToUser` to death
 * and every test passes while no human being can invoke it.
 *
 * Proven to fail: at the commit before the picker was added, both names below
 * had zero matches and this test was red.
 */

const ROOT = process.cwd();

/** Every mutation that IS the Crew role, paired with what breaks without it. */
const MUST_BE_REACHABLE: ReadonlyArray<{ fn: string; orElse: string }> = [
  {
    fn: "linkEmployeeToUser",
    orElse:
      "a crew login can never be pointed at a person, so all five crew screens show 'Almost there' forever",
  },
  {
    fn: "setCrewRole",
    orElse: "nobody can be restricted to crew, or released from it, in the product",
  },
];

/** Source files a person's click can actually reach. */
function uiFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(join(ROOT, "app"));
  walk(join(ROOT, "components"));
  return out;
}

/**
 * Comments are stripped before matching. Four tests here have gone green on
 * their own docblocks — a file that merely EXPLAINS why linkEmployeeToUser
 * exists must not count as calling it.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the Crew role has no unreachable half", () => {
  const files = uiFiles();

  it("scans a real number of UI files", () => {
    // An empty scan is a fake pass: every assertion below would hold vacuously.
    expect(files.length).toBeGreaterThan(200);
  });

  for (const { fn, orElse } of MUST_BE_REACHABLE) {
    it(`${fn} is called from somewhere a person can click`, () => {
      const callers = files.filter((f) => {
        const src = stripComments(readFileSync(f, "utf8"));
        return new RegExp(`\\b${fn}\\b`).test(src);
      });
      expect(
        callers.map((f) => f.replace(`${ROOT}/`, "")),
        `${fn} has no caller under app/ or components/ — ${orElse}`,
      ).not.toHaveLength(0);
    });
  }
});
