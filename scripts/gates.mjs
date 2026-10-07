/**
 * EVERY GATE, IN ORDER, AND A STAMP SAYING WHICH CODE PASSED THEM.
 *
 *   npm run gates
 *
 * READ ONLY as far as the repository is concerned: it runs checks and writes
 * one file, .gates/verified, which is gitignored.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * Karan, 2026-10-07: "too many mistakes keep coming up".
 *
 * Of the day's ~55 fixes, five were repairs of work from earlier the same day.
 * Every one of those five had the same cause: a gate that exists, was not run,
 * or was run and its exit code not acted on.
 *
 *   the build  ran, exited 1 on a transient font fetch, printed "build=1",
 *              and the commit went out in the same shell line anyway.
 *   tsc        not re-run after a one-character regex edit; /s is TS1501 at
 *              this target, and vitest does not type-check.
 *   CI's node  20 against production's 24, so two tests were green here and
 *              red for everybody.
 *
 * The ordering, and the reading of each exit code, lived in a person's head.
 * That is not a gate. This is: one chain, stop at the first failure, and on
 * success stamp the git TREE that passed.
 *
 * ── THE STAMP IS THE POINT ──────────────────────────────────────────────
 *
 * It records the tree of HEAD, not a timestamp, so the hook in scripts/hooks
 * can refuse a push whose code is not the code that passed. That closes the
 * two gaps a remembered habit leaves open: verifying and then pushing
 * something else, and verifying nothing at all.
 *
 * Run it AFTER committing, so the tree it stamps is the tree you are pushing.
 *
 *   --fast   skip vitest and the build. Stamps nothing, so it cannot satisfy
 *            the hook; it is for a quick look mid-edit, not for pushing.
 */
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const fast = process.argv.includes("--fast");

/**
 * Cheapest first, so a type error does not cost a full suite to find. Each
 * entry is a gate that has caught a real defect in this repo.
 */
const GATES = [
  ["types", "npx", ["tsc", "--noEmit"]],
  ["rules are wired", "node", ["scripts/check-rules-are-wired.mjs"]],
  ["options nothing passes", "node", ["scripts/check-unpassed-options.mjs"]],
  ["lint budget", "node", ["scripts/check-lint-budget.mjs"]],
  ...(fast ? [] : [
    ["tests", "npx", ["vitest", "run"]],
    ["build", "npm", ["run", "build"]],
  ]),
];

const started = Date.now();
const secs = (ms) => `${(ms / 1000).toFixed(0)}s`;

for (const [name, cmd, args] of GATES) {
  const at = Date.now();
  process.stdout.write(`\n──  ${name}\n`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  /**
   * A signal is not a pass. spawnSync reports a killed child as status null,
   * and `null !== 0` is the only reason that is not a silent success here —
   * so say it out loud rather than rely on the coincidence.
   */
  if (r.error || r.signal || r.status !== 0) {
    const how = r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    console.log(
      `\n✗  ${name} FAILED (${how}) after ${secs(Date.now() - at)}.`
      + `\n   Nothing was stamped, so a push of this tree will be refused.`
      + `\n   Fix it and run npm run gates again.\n`,
    );
    process.exit(1);
  }
  console.log(`✓  ${name}  ${secs(Date.now() - at)}`);
}

if (fast) {
  console.log(
    `\nFast gates passed in ${secs(Date.now() - started)}.`
    + `\nNO STAMP WRITTEN — tests and the build did not run. Run npm run gates before pushing.\n`,
  );
  process.exit(0);
}

const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();

mkdirSync(".gates", { recursive: true });
writeFileSync(".gates/verified", `${tree}\n`);

console.log(`\nAll gates passed in ${secs(Date.now() - started)}.  Stamped ${head} (${tree.slice(0, 12)}).`);
if (dirty) {
  /**
   * The stamp names HEAD's tree, and the worktree is not HEAD. Whatever is
   * uncommitted here was in front of the gates but is not in what they
   * certified, so the hook will pass a push that does not include it.
   */
  console.log(
    `\n⚠  The worktree is not clean, so the stamp covers the LAST COMMIT, not what you just ran:\n`
    + dirty.split("\n").map((l) => `     ${l}`).join("\n")
    + `\n   Commit those and run this again, or the push will carry unverified code.\n`,
  );
} else {
  console.log(`Safe to push.\n`);
}
