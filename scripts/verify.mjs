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
 *   · a color the dark theme never remapped
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

/** One probe, so the server-dependent step can skip instead of failing. */
let serverUp = false;
try {
  const res = await fetch("http://localhost:3000/", { signal: AbortSignal.timeout(2500) });
  serverUp = !!res;
} catch { serverUp = false; }

step("types", "npx tsc --noEmit", {
  catches: "signature drift, missing fields, bad imports",
  blind: "anything the database or the browser decides — a CHECK constraint is invisible here",
});

step("unit", "npx vitest run", {
  catches: "pure logic: money math, date windows, name derivation, PDF page counts",
  blind: "the database, the network, the rendered page",
});

step("rules are wired", "node scripts/check-rules-are-wired.mjs", {
  catches:
    "a correct rule with no consumer — A7's offsiteReason was computed and never passed, so a live critical rule never once fired. Proved on 2026-09-26: unwiring A25's callback leaves tsc green and all 5,289 unit tests passing",
  blind: "whether the rule is RIGHT. It only checks that the value reaches the far end",
});

step("form fields", "node scripts/check-duplicate-form-fields.mjs", {
  catches:
    "one form field rendered twice across a phone/desktop layout swap — the hidden copy overwrote a Gusto cost Mary typed on her phone",
  blind: "a field that is simply missing, and anything about what the action does with it",
});

step("db enums", "node scripts/check-db-enums.mjs", {
  catches: "a picker offering a value Postgres rejects — this once left a table with zero rows for months",
  blind: "everything else about the database",
  skipIf: Object.assign(() => !existsSync(".env.local"), noEnv),
});

/**
 * THIRTEEN CHECKS THAT EXISTED AND THE GATE NEVER RAN.
 *
 * Every one of these was written for a bug that had already happened, and
 * every one was reachable only by somebody remembering to type it. Twelve
 * passed the moment they were run. A check nobody runs is a comment.
 *
 * Ordered cheapest first, so a static mistake fails before anything pays for
 * a round trip to the database.
 */
const ENV = Object.assign(() => !existsSync(".env.local"), noEnv);

step("schema drift", "node scripts/check-schema-drift.mjs", {
  catches: "a migration in the repo that the live database does not have, and the reverse",
  blind: "whether the schema it agrees on is the RIGHT one",
});

step("form seams", "node scripts/check-form-seams.mjs", {
  catches: "a form field the action that reads it does not accept — the seam between them",
  blind: "what the action does with a field once it has it",
});

step("soft-delete uniques", "node scripts/check-soft-delete-uniques.mjs", {
  catches: "a unique index that counts soft-deleted rows, so deleting and recreating fails",
  blind: "every other kind of index",
});

step("selected columns", "node --env-file=.env.local scripts/check-selected-columns.mjs", {
  catches: "a .select() naming a column the table does not have",
  blind: "a column that exists and holds the wrong thing",
  skipIf: ENV,
});

step("report folders", "node --env-file=.env.local scripts/check-report-folders.mjs", {
  catches: "a report filed under a folder nothing renders",
  blind: "whether the report itself is right",
  skipIf: ENV,
});

step("upload limit", "node --env-file=.env.local --import ./scripts/ts-resolve-register.mjs scripts/check-upload-limit.mjs", {
  catches: "an upload ceiling the storage bucket will not actually accept",
  blind: "what happens to a file once it is in",
  skipIf: ENV,
});

step("salesforce fields", "node scripts/check-sf-fields.mjs", {
  catches: "a field this code reads that Salesforce does not expose",
  blind: "the VALUES in those fields",
});

step("salesforce picklists", "node --import ./scripts/ts-resolve-register.mjs scripts/check-sf-picklists.mjs", {
  catches: "a picklist value Salesforce will reject on write",
  blind: "anything not a picklist",
});

step("money reconciles", "node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-money-reconciles.mjs", {
  catches: "the four money measures disagreeing with each other on real rows",
  blind: "whether the figures match what Square actually settled",
  skipIf: ENV,
});

step("delivery flows", "node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-delivery-flows.mjs", {
  catches: "a document flow that cannot reach its recipient",
  blind: "whether the recipient reads it",
  skipIf: ENV,
});

step("one-off flow", "node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-one-off-flow.mjs", {
  catches: "the one-off job path breaking end to end",
  blind: "the recurring path",
  skipIf: ENV,
});

step("receipt path", "node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-receipt-path.mjs", {
  catches: "a receipt that cannot be produced for a real payment",
  blind: "what the receipt says",
  skipIf: ENV,
});

/**
 * NEEDS A DEV SERVER, so it is skipped rather than failed when none is up.
 * It passed here only because one happened to be running, which is the sort
 * of pass that teaches people to trust a check that was not looking.
 */
step("tour targets", "node scripts/check-tour-targets.mjs", {
  catches: "a walkthrough step pointing at an element that is not on the page it opens",
  blind: "everything about the page except that one element being present",
  skipIf: Object.assign(
    () => !serverUp,
    { reason: "no dev server on localhost:3000" },
  ),
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
