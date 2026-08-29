/**
 * Everything that has to be true, in the order that fails fastest.
 *
 * `npm test` is deliberately pure-logic — no database, no browser, no rendered
 * document (see vitest.config.ts). That keeps it a few seconds and zero-flake,
 * and it structurally CANNOT see the class of bug that actually ships here:
 *
 *   · a form posting a field its action never reads
 *   · a picker offering a value the database's CHECK rejects
 *   · a PDF that quietly grew to two pages
 *   · a page that 500s only with real data
 *   · a colour the dark theme never remapped
 *
 * Every one of those shipped past a green suite. So the suite is one LAYER,
 * not the answer, and the layers above it need a database and a running server.
 * Four separate commands nobody remembers to run is the same as no commands —
 * hence one entry point.
 *
 *   npm run verify              types + unit + enums   (needs .env.local)
 *   npm run verify -- --full    …plus the 73-page smoke (needs a dev server)
 *
 * Each step says what it can and cannot catch, because a check whose blind
 * spots aren't stated gets trusted for things it never covered.
 */
import { spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";

const full = process.argv.includes("--full");
const results = [];

function step(name, cmd, { catches, blind, skipIf } = {}) {
  if (skipIf?.()) {
    console.log(`\n⏭  ${name} — skipped (${skipIf.reason})`);
    results.push([name, "skipped"]);
    return;
  }
  console.log(`\n▶  ${name}`);
  if (catches) console.log(`   catches: ${catches}`);
  if (blind) console.log(`   blind to: ${blind}`);
  const t = Date.now();
  const r = spawnSync("sh", ["-c", cmd], { stdio: "inherit" });
  const ok = r.status === 0;
  console.log(`   ${ok ? "✅" : "❌"} ${((Date.now() - t) / 1000).toFixed(1)}s`);
  results.push([name, ok ? "pass" : "fail"]);
  return ok;
}

// A shared working tree with two dev servers wipes .next underneath whichever
// one is serving, and every result after that is noise. This has produced three
// false alarms in two days; it is worth ten milliseconds to say so up front.
try {
  const procs = execSync("pgrep -fl 'next dev' 2>/dev/null || true", { encoding: "utf8" })
    .trim().split("\n").filter((l) => l && !l.includes("pgrep"));
  if (procs.length > 1) {
    console.log(`\n⚠️  ${procs.length} dev servers are running in this tree.`);
    console.log("   They share .next and will overwrite each other's build.");
    console.log("   Any failure below may be that, not your code. Stop all but one.\n");
  }
} catch { /* pgrep is best-effort */ }

const noEnv = { reason: "no .env.local", ...{} };

step("types", "npx tsc --noEmit", {
  catches: "signature drift, missing fields, bad imports",
  blind: "anything the database or the browser decides — a CHECK constraint is invisible here",
});

step("unit", "npx vitest run", {
  catches: "pure logic: money math, date windows, name derivation, PDF page counts",
  blind: "the database, the network, the rendered page",
});

step("db enums", "node scripts/check-db-enums.mjs", {
  catches: "a picker offering a value Postgres rejects — this once left a table with zero rows for months",
  blind: "everything else about the database",
  skipIf: Object.assign(() => !existsSync(".env.local"), noEnv),
});

if (full) {
  step("pages", "node scripts/smoke-pages.mjs", {
    catches: "a route that 500s with real data, on all 73 pages",
    blind: "how any of it LOOKS, and anything behind a click",
    skipIf: Object.assign(
      () => !existsSync(".env.local"),
      { reason: "no .env.local" }
    ),
  });
} else {
  console.log("\n⏭  pages — skipped (pass --full, and start a dev server first)");
  results.push(["pages", "skipped"]);
}

console.log("\n" + "─".repeat(52));
for (const [name, r] of results) {
  console.log(`  ${r === "pass" ? "✅" : r === "fail" ? "❌" : "⏭ "} ${name}`);
}
const failed = results.filter(([, r]) => r === "fail").length;
console.log("─".repeat(52));
if (failed) {
  console.log(`\n${failed} step(s) failed.\n`);
  process.exit(1);
}
console.log(
  full
    ? "\nAll layers pass. Still unproven by any of them: how it looks, what happens after a click, and whether a real person can finish a job.\n"
    : "\nStatic layers pass. The 73-page smoke did NOT run — use --full with a dev server up.\n"
);
