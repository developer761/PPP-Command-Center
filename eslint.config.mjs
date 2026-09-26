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
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
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
