/**
 * LINT, HELD DOWN RATHER THAN IGNORED.
 *
 *   node scripts/check-lint-budget.mjs
 *   node scripts/check-lint-budget.mjs --update     (after you fix some)
 *
 * READ ONLY except with --update, which rewrites the baseline below.
 *
 * ── WHY A BUDGET AND NOT A CLEAN BUILD ──────────────────────────────────
 *
 * Lint sat outside the gate with 153 errors: neither enforced nor
 * acknowledged, which is the worst of both. Nobody fixed them, and nobody
 * could tell a new one from an old one.
 *
 * 48 were genuinely mechanical and are fixed — apostrophes in JSX, prefer-const,
 * an interface that was its own supertype, components declared during render,
 * and `require` in .cjs files, which is not a mistake and is now configured
 * rather than suppressed.
 *
 * The rest are NOT defects, and "fixing" them would mean restructuring forty
 * components with no behaviour change and no way to regression-test the UI.
 * They are counted instead, per rule, so:
 *
 *   - a NEW error of any kind fails the gate immediately
 *   - fixing some and regressing others cannot cancel out, because the budget
 *     is per rule rather than one total
 *   - the number is visible in every verify run instead of living in
 *     somebody's memory
 *
 * ── WHAT IS STILL OUTSTANDING, AND WHY ──────────────────────────────────
 *
 * set-state-in-effect (53). React Compiler's strictest rule. Every one
 * sampled was a legitimate imperative effect: async loading, error handling,
 * resetting a command palette on open, closing mobile nav on navigation.
 * Removing them means `key`-based resets or a data-fetching library.
 *
 * purity (14). All `Date.now()` during render. In the server components most
 * of them sit in, that is correct and runs once. One of them —
 * app/commercial/page.tsx:98 — is deliberate, with a comment explaining it
 * hoists a single read so four comparisons cannot straddle midnight and put a
 * row in two aging buckets on one screen. That is good code being flagged.
 * The client-component ones deserve a hydration check, which is real work.
 *
 * no-explicit-any (25). 24 of them in scripts/ — one-off audit tooling
 * against Salesforce shapes that genuinely are unknown at the boundary.
 *
 * refs (4), immutability (4), use-memo (1), no-require-imports (4 outside
 * .cjs). Small, real, unexamined.
 *
 * NONE OF THIS IS A REASON TO LEAVE THEM FOREVER. It is a reason not to
 * pretend they were fixed. Lower a number here whenever you clear some.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * The most errors each rule may produce. Every number is a debt, not a
 * target: it may go down and may never go up.
 */
const BUDGET = {
  "react-hooks/set-state-in-effect": 53,
  "@typescript-eslint/no-explicit-any": 25,
  "react-hooks/purity": 14,
  "@typescript-eslint/no-require-imports": 4,
  "react-hooks/refs": 4,
  "react-hooks/immutability": 4,
  "react-hooks/use-memo": 1,
};

const update = process.argv.includes("--update");

let raw;
try {
  raw = execFileSync("npx", ["eslint", ".", "-f", "json"], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  // eslint exits non-zero when it finds errors, which is the normal case here.
  raw = e.stdout ?? "";
  if (!raw.trim()) {
    console.error("\n  eslint produced no output:\n" + (e.stderr ?? e.message) + "\n");
    process.exit(1);
  }
}

const report = JSON.parse(raw);
const counts = {};
let files = 0;
for (const file of report) {
  files++;
  for (const m of file.messages) {
    if (m.severity !== 2) continue;              // errors only; warnings are separate
    const rule = m.ruleId ?? "PARSE/OTHER";
    counts[rule] = (counts[rule] ?? 0) + 1;
  }
}

/**
 * A SCAN THAT LOOKED AT NOTHING MUST NOT PASS.
 *
 * If eslint's config breaks, or a glob stops matching, the report comes back
 * empty and every budget is satisfied — a green line over nothing checked.
 */
if (files < 100) {
  console.error(`\n  ✗  eslint only looked at ${files} files. Something is wrong with the config or the globs; refusing to report a pass over nothing.\n`);
  process.exit(1);
}

if (update) {
  const next = Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1])
  );
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const body = Object.entries(next).map(([r, n]) => `  ${JSON.stringify(r)}: ${n},`).join("\n");
  const rewritten = src.replace(/const BUDGET = \{[\s\S]*?\n\};/, `const BUDGET = {\n${body}\n};`);
  writeFileSync(new URL(import.meta.url), rewritten);
  console.log("\n  baseline updated:\n" + body + "\n");
  process.exit(0);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
const budgeted = Object.values(BUDGET).reduce((a, b) => a + b, 0);
console.log(`\nLINT BUDGET — ${total} errors across ${files} files (budget ${budgeted})\n`);

let over = 0, under = 0;
const rules = new Set([...Object.keys(BUDGET), ...Object.keys(counts)]);
for (const rule of [...rules].sort()) {
  const now = counts[rule] ?? 0;
  const max = BUDGET[rule] ?? 0;
  if (now > max) {
    over++;
    console.log(`  ✗  ${rule}\n       ${now} now, ${max} allowed — ${now - max} new`);
  } else if (now < max) {
    under++;
    console.log(`  ↓  ${rule}  ${now} (was ${max}) — ${max - now} fixed, lower the budget with --update`);
  } else if (now > 0) {
    console.log(`  =  ${rule}  ${now}`);
  }
}

if (over) {
  console.log(`\n  ${over} rule(s) went UP. A lint error that is new is the one worth fixing —`);
  console.log(`  the rest of the budget is old debt that is deliberately held, not ignored.\n`);
  process.exit(1);
}
console.log(`\n${under ? `ALL WITHIN BUDGET — and ${under} rule(s) improved` : "ALL WITHIN BUDGET"}\n`);
process.exit(0);
