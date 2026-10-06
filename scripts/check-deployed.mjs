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
 * Vercel's CLI prints a table whose columns have moved between versions, so
 * this reads the JSON rather than the human output. `--prod` scopes it to
 * production, which is the only target this repo deploys to.
 */
let rows;
try {
  const raw = run("npx", ["vercel", "ls", "--prod", "--json"]);
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

const newest = rows[0];
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
