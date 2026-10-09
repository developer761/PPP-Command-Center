import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Lint sat outside the gate for months — 153 errors, neither enforced nor
 * acknowledged, which is the worst of both: nobody fixes them, and nobody can
 * tell a new one from an old one.
 *
 * The override below is genuinely CONFIGURATION rather than suppression: a
 * rule pointed at the wrong kind of file. Everything else is either fixed or
 * counted by scripts/check-lint-budget.mjs, which holds the remaining number
 * down and runs inside `npm run verify`.
 *
 * NOTHING HERE TURNS A RULE OFF TO MAKE A REAL PROBLEM GO AWAY. If a rule is
 * finding something true, it stays on and the budget carries it until it is
 * fixed.
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    /**
     * These are the default ignores of eslint-config-next, with one change:
     * `**` in front of each, so they match a build directory ANYWHERE and not
     * only at the repo root.
     *
     * Without the prefix, `.next/**` is anchored to the config's own
     * directory. An agent worktree under .claude/worktrees/ that has been
     * built leaves its own .next/ outside that anchor, and lint walks into
     * 195MB of generated Turbopack chunks — which fail every rule we have,
     * because generated code is not written to our standards and was never
     * meant to be read by this. On 2026-10-08 that took the lint gate from
     * pass to a 65KB wall of errors about `__turbopack_context__`, and the
     * tree could not be pushed.
     *
     * `/.next/` in .gitignore is root-anchored for the same reason and has
     * the same hole; it only shows up as untracked noise there rather than a
     * failed gate.
     */
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/next-env.d.ts",
    /**
     * .claude/worktrees/ holds git worktrees — each one a FULL checkout of
     * this same repo, created for a subagent and left behind afterwards.
     *
     * Linting them counts every source file once per worktree. With three
     * left over this put every budgeted rule at almost exactly 4x its
     * number (set-state-in-effect 53 -> 211, no-explicit-any 25 -> 97,
     * purity 14 -> 62) and read as 400-odd new errors, when not one line of
     * source had changed. The budget is per-rule counts, so anything that
     * multiplies the corpus breaks it.
     *
     * Lint the working tree, once. A worktree's own gates cover its own code
     * while it is alive.
     */
    ".claude/**",
  ]),
  {
    /**
     * A .cjs file IS CommonJS. `require` is not a mistake there, it is the
     * only thing that works — these run as plain node scripts outside the
     * bundler, and rewriting them as ES modules would break them.
     *
     * The rule exists to catch an ES module that has drifted back to
     * require(), which is a real problem, so it stays an error everywhere
     * else.
     */
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
