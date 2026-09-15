import { defineConfig } from "vitest/config";
import { resolve } from "path";

/**
 * LIVE end-to-end checks — real database, real local dev server.
 *
 * Deliberately separate from vitest.config.ts: the main suite is pure logic
 * and runs in CI with no credentials. These run by hand, with .env.local and a
 * dev server up, and exist because the defects that ship live in the seams a
 * pure test cannot reach. See scripts/esign.live.test.ts for how to run.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, ".."),
      "server-only": resolve(__dirname, "../__tests__/__stubs__/server-only.ts"),
    },
  },
  test: {
    include: ["scripts/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    fileParallelism: false,
  },
});
