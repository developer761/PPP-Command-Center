import { defineConfig } from "vitest/config";
import { resolve } from "path";

/**
 * Vitest config — Stage 3.5d.
 *
 * Strict design rules for this suite:
 *
 *  1. PURE LOGIC ONLY. Zero database mocking, zero Supabase stubs,
 *     zero fake servers. Every function under test is a pure
 *     transformation (input → output, no I/O). This keeps the suite
 *     fast (~1s for ~40 tests), zero-flake, and zero-credential
 *     (CI doesn't need any secrets).
 *
 *  2. NO TEST DATABASE. Integration tests need a real DB which means
 *     credentials in CI, migration sync, isolation, cleanup — all
 *     overkill for the actual bugs that have shipped this year (every
 *     audit-flagged critical was a pure-logic bug). Skip the
 *     complexity.
 *
 *  3. COVERAGE GATE 60%. SubHub's plan asked for 80-90% because they
 *     have a wide backend surface. Our pure-logic surface is small;
 *     60% covers the load-bearing math/regex/HMAC bits without
 *     chasing a number on UI components.
 *
 *  4. PATH ALIAS PARITY. Resolves @/* the same way Next.js does
 *     (tsconfig.json baseUrl=".") so tests can import any lib
 *     module without rewriting imports.
 */

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
      // `server-only` is a Next.js sentinel package that throws if
      // imported from a client component. In tests we run server code
      // directly in Node, so stub it as a no-op. This is the
      // documented Vitest+Next pattern.
      "server-only": resolve(__dirname, "__tests__/__stubs__/server-only.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    /**
     * THIRTY SECONDS, NOT VITEST'S FIVE.
     *
     * Rule 1 above is still true of the logic tests, but this suite has grown
     * a second kind: ~20 STRUCTURAL tests that read every .ts/.tsx under app/,
     * lib/, components/ and __tests__/ — up to 3,000 files — and strip the
     * comments out of each before asserting on it, because an import
     * specifier or a function name sitting in a docblock would otherwise read
     * as the real thing and turn the assertion green for the wrong reason.
     * That is a genuine parse, it is the point, and it does not fit in five
     * seconds when a dozen workers are doing it at once.
     *
     * At the default, `no-stranded-components` measured 5,152 ms in a full run
     * and passed in isolation: a red that tracks how busy the machine is. On
     * 2026-10-16 three of these timed out together, the pattern was read as
     * another session editing the shared tree, and the real cause — the
     * comment stripper walking `getChildren()`, 2,195 ms on top of a 308 ms
     * parse — went unexamined for an afternoon. Patching the three that
     * happened to fail was whack-a-mole; seventeen more carried the same
     * latent flake.
     *
     * Raising this costs a passing suite nothing: a timeout only decides how
     * long a HUNG test runs before it gives up. It is set loose on purpose —
     * it is here to end an infinite loop, not to time a slow walk. Anything
     * that genuinely wants to catch a slow walk should measure it, not infer
     * it from a wall clock shared with every other worker.
     */
    testTimeout: 30_000,
    include: ["__tests__/**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "e2e/**", "__tests__/__stubs__/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // Pure-logic surfaces only — everything else is integration.
      include: [
        "lib/commercial/email-archive/address.ts",
        "lib/commercial/email-archive/sanitize.ts",
        "lib/commercial/email-archive/inbound.ts",
        "lib/notifications/commercial-events.ts",
        "lib/commercial/opportunities/notes.ts",
        "lib/commercial/opportunities/status.ts",
        "lib/commercial/opportunities/constants.ts",
        "lib/commercial/cron/**/*.ts",
        "lib/observability.ts",
      ],
      exclude: ["**/*.d.ts", "**/*.config.*"],
      thresholds: {
        // Soft floors — fail the build if coverage drops BELOW. Set
        // to 60% rather than the SubHub-recommended 80% because our
        // surface is smaller + integration-heavy bits (Supabase
        // queries, server actions) are excluded by design.
        statements: 60,
        branches: 55,
        functions: 60,
        lines: 60,
      },
    },
  },
});
