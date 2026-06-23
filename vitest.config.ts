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
