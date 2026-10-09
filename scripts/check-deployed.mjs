#!/usr/bin/env node
/**
 * DID THE THING I JUST PUSHED ACTUALLY SHIP?
 *
 * ── WHY THIS EXISTS, 2026-10-05 ─────────────────────────────────────────
 *
 * A fix for a refused address was written, gated (tsc, 6262 tests, the wiring
 * check, 143 scenarios, a clean `npm run build`) and pushed. Every gate was
 * green. Then it was replayed in the simulator against production and the OLD
 * wording came back.
 *
 * The deploy had failed. `next/font/google` fetches Roboto, Roboto_Condensed
 * and Dancing_Script from Google AT BUILD TIME, that fetch failed on Vercel's
 * builder, and Turbopack came back with 36 module-not-found errors. Nothing
 * local could have caught it — the same commit builds clean on this machine —
 * and it was the SECOND time in one day.
 *
 * On this repo a merge to main IS the production release. So a failed build is
 * not "a build to re-run later", it is a change that silently did not happen
 * while every signal said it had. The only reason it was caught is that
 * somebody went and looked.
 *
 * ── WHAT IT CHECKS ──────────────────────────────────────────────────────
 *
 * The newest PRODUCTION deployment is Ready, and it is built from the commit
 * at HEAD. Both halves matter and they fail differently:
 *
 *   not Ready      the build broke — the font fetch above, or anything else
 *   Ready, older   the build is still running, or a newer push errored and
 *                  production is still serving the last good one
 *
 * Deliberately NOT a gate in `npm run verify`: it describes the state of the
 * world after a push, not the state of the tree before one. Run it when a
 * change is expected to be live, which is exactly when the assumption gets
 * made.
 */

import { execFileSync } from "node:child_process";

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

/** The commit we are asking about. */
const head = run("git", ["rev-parse", "HEAD"]);
const headShort = head.slice(0, 7);
const subject = run("git", ["log", "-1", "--format=%s"]);

/**
 * WHICH PROJECT. The scope has more than one, and this script read row 0.
 *
 * `vercel ls` without a linked project lists every production deployment in
 * the SCOPE, newest first — and ppp-s-projects also holds `rycos`, which
 * deploys every few minutes from an unrelated repo. There is no
 * .vercel/project.json here, so on 2026-10-07 this printed
 *
 *   Newest prod 57b00e6  BUILDING
 *
 * where 57b00e6 is a Ryco commit that does not exist in this repository. The
 * verdict was about another application. It can fail falsely, which wastes
 * time, and it can PASS falsely, which is the whole thing this gate exists to
 * prevent — the same mistake as answering "is it live" from the wrong
 * localhost.
 *
 * So the project is named, the rows are filtered to it, and an empty filter is
 * a hard stop rather than a fallback to whatever was newest.
 */
const PROJECT = "ppp-command-center";

let rows;
try {
  const raw = run("npx", ["vercel", "ls", PROJECT, "--prod", "--json"]);
  const parsed = JSON.parse(raw);
  rows = Array.isArray(parsed) ? parsed : (parsed.deployments ?? []);
} catch (e) {
  // No token, no network, no project link. Say so plainly rather than
  // reporting a healthy deploy we never actually looked at.
  console.error("COULD NOT CHECK: `vercel ls` failed.");
  console.error(String(e.message ?? e).split("\n").slice(0, 4).join("\n"));
  console.error("\nThis is NOT a pass. Run `npx vercel login` or check the dashboard.");
  process.exit(2);
}

if (!rows.length) {
  console.error("COULD NOT CHECK: vercel returned no production deployments.");
  process.exit(2);
}

/**
 * Belt and braces: naming the project on the command line should be enough,
 * but a row carries its own `name` and the cost of checking it is nothing
 * against the cost of reading another app's deploy as this one's. A row with
 * no name is kept — older CLI output omitted it — and one with the WRONG name
 * is not.
 */
const mine = rows.filter((r) => !r.name || r.name === PROJECT);
if (!mine.length) {
  console.error(`COULD NOT CHECK: no production deployment belongs to "${PROJECT}".`);
  console.error(`   vercel returned ${rows.length} row(s), for: ${[...new Set(rows.map((r) => r.name))].join(", ")}`);
  console.error(`\nThis is NOT a pass — the deployments listed are other projects in this scope.`);
  process.exit(2);
}

const newest = mine[0];
const state = String(newest.state ?? newest.readyState ?? "").toUpperCase();
const sha = String(
  newest.meta?.githubCommitSha ?? newest.gitSource?.sha ?? ""
).slice(0, 7);
const ts = newest.createdAt ?? newest.created;
const when = ts ? new Date(ts).toLocaleString() : "unknown time";

console.log(`HEAD        ${headShort}  ${subject}`);
console.log(`Newest prod ${sha || "(no commit recorded)"}  ${state}  ${when}`);
console.log(`            ${newest.url ?? ""}\n`);

let bad = false;

if (state !== "READY") {
  bad = true;
  console.error(`✗  The newest production deployment is ${state}, not READY.`);
  console.error(`   Production is still serving whatever shipped before it, so the`);
  console.error(`   change is NOT live however green the local gates were.`);
  console.error(`   Logs:  npx vercel inspect --logs ${newest.url}`);
  if (state === "ERROR") {
    console.error(`   If it is 'Module not found: @vercel/turbopack-next/internal/font/google/font',`);
    console.error(`   that is the Google Fonts fetch failing on the builder. Retry:`);
    console.error(`   npx vercel redeploy ${newest.url} --no-wait`);
  }
}

if (sha && sha !== headShort) {
  bad = true;
  console.error(`✗  Production is built from ${sha}, but HEAD is ${headShort}.`);
  console.error(`   Either the build for HEAD has not finished, or it failed and`);
  console.error(`   production fell back to the last good one.`);
}

if (bad) process.exit(1);

console.log("✓  Production is READY and built from HEAD. The change is live.");
