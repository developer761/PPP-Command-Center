/**
 * Push, but only what is actually ours and only if it has been tested.
 *
 *   npm run push
 *
 * WHY THIS EXISTS
 *
 * Two Claude sessions share this one working tree (see "ONE shared working
 * tree" in AGENTS.md), and on 2026-10-14 that cost three separate rounds of
 * manual repair:
 *
 *   - The other session's whole Stripe build sat UNCOMMITTED in the tree for
 *     days, so every `git status` here was full of files that were not ours.
 *   - A stash command built with a line-wrapped path produced an EMPTY
 *     pathspec, so instead of stashing five superseded files it swept the
 *     entire tree — including this session's hooks and an unrelated planning
 *     doc. Recovered from a tarball, but only because one had been taken.
 *   - origin/main moved twice mid-push, once with the same commit under a
 *     different SHA, needing a rebase and a re-run of the gates each time.
 *
 * None of those were a bad decision at the time; they were a workflow with no
 * guard rail. This is the guard rail. Every check below refuses and explains
 * rather than guessing, because the failure mode of guessing here is pushing
 * somebody else's half-finished work to a branch where a merge is a production
 * deploy.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const DRY = process.argv.includes("--dry-run");
const REMOTE = "origin";
const BRANCH = "main";

const gitRaw = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const git = (...args) => gitRaw(...args).trim();
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

let failed = 0;
const ok = (name, detail = "") => console.log(`  ok    ${name}${detail ? " — " + detail : ""}`);
const bad = (name, detail = "") => {
  failed += 1;
  console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
};

/**
 * Files this session is allowed to leave lying around untracked. Anything else
 * uncommitted is either ours and should be committed, or the other session's
 * and must not be touched — either way a human decides, not this script.
 */
const KNOWN_LOCAL = [/^\.claude\//, /^\.open\.mjs$/, /^\.gates\//, /^docs\/ONLINE_BOOKING_PLAN\.md$/];

console.log("\nChecking what would actually go out\n");

// ── 1. Up to date with the remote? ───────────────────────────────────────────
// A rebase changes the tree, which invalidates the gates stamp, so this has to
// be settled BEFORE the stamp check rather than after a failed push.
try {
  git("fetch", REMOTE, BRANCH);
} catch (err) {
  bad("could not reach the remote", String(err).split("\n")[0]);
}
const behind = lines(git("rev-list", `HEAD..${REMOTE}/${BRANCH}`));
if (behind.length === 0) ok("up to date with " + REMOTE + "/" + BRANCH);
else
  bad(
    `${REMOTE}/${BRANCH} has moved — ${behind.length} commit(s) you do not have`,
    "run: git pull --rebase origin main && npm run gates, then this again",
  );

// ── 2. What exactly is going out? ────────────────────────────────────────────
const outgoing = lines(git("log", "--format=%H\t%an\t%s", `${REMOTE}/${BRANCH}..HEAD`));
if (outgoing.length === 0) {
  console.log("\nNothing to push. Everything local is already on the remote.\n");
  process.exit(0);
}
const me = git("config", "user.name");
console.log(`\n  ${outgoing.length} commit(s) to push, as "${me}":`);
for (const row of outgoing) {
  const [sha, author, ...rest] = row.split("\t");
  const subject = rest.join("\t");
  const mine = author === me;
  console.log(`    ${mine ? " " : "⚠"} ${sha.slice(0, 8)}  ${author.padEnd(16)} ${subject.slice(0, 72)}`);
  if (!mine) bad(`commit ${sha.slice(0, 8)} was authored by ${author}, not you`);
}

/*
 * THREE dots, not two. `diff A..B` compares the two tips, so when the remote
 * has moved it lists the other session's files as if they were in our push —
 * the first run of this script claimed nine files including two messaging ones
 * nobody here had touched, which is precisely the confusion this script exists
 * to remove. `A...B` diffs from the merge base: only what WE changed.
 */
const outFiles = lines(git("diff", "--name-only", `${REMOTE}/${BRANCH}...HEAD`));
console.log(`\n  ${outFiles.length} file(s):`);
for (const f of outFiles) console.log(`      ${f}`);
console.log("");

// ── 3. Is anyone mid-edit on a file we are pushing? ─────────────────────────
// THE OVERLAP CHECK. A file that is both in our push and uncommitted in the
// tree means two writers are on it at once, and whichever of us commits second
// silently reverts the other.
// gitRaw, and NOT the `lines()` helper: porcelain's status is a fixed-width
// two-column prefix, so ANY trim shifts it. " M package.json" trimmed to
// "M package.json" and then cut three characters yields "ackage.json". The
// first two runs of this script reported exactly that — once from trimming each
// line, then again from the helper trimming the whole output, which mangles
// only the FIRST row and so looks like a one-off rather than a parsing bug.
const dirty = gitRaw("status", "--porcelain")
  .split("\n")
  .filter((l) => l.length > 3)
  .map((l) => l.slice(3))
  .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p))
  .map((p) => p.replace(/^"|"$/g, "").trim())
  .filter(Boolean);
const contested = outFiles.filter((f) => dirty.some((d) => d === f || f.startsWith(d)));
if (contested.length === 0) ok("no file in this push is uncommitted in the tree");
else
  bad(
    `${contested.length} file(s) are in this push AND uncommitted right now`,
    contested.join(", ") + " — another session may be editing them",
  );

// ── 4. Is the rest of the tree someone else's work? ─────────────────────────
const strangers = dirty.filter((p) => !KNOWN_LOCAL.some((re) => re.test(p)));
if (strangers.length === 0) ok("nothing uncommitted except this session's own local files");
else {
  // NOT a failure: the other session's work-in-progress living here is the
  // normal state of this tree. It is reported so that "I did not expect that
  // file" is a thought somebody has BEFORE the push, not after.
  console.log(`  note  ${strangers.length} uncommitted path(s) left alone (not yours to push):`);
  for (const p of strangers.slice(0, 12)) console.log(`          ${p}`);
  if (strangers.length > 12) console.log(`          …and ${strangers.length - 12} more`);
}

// ── 5. Did the gates actually pass on THIS tree? ─────────────────────────────
// The pre-push hook enforces this too; checking here turns a rejected push into
// an explanation.
const tree = git("rev-parse", "HEAD^{tree}");
const stampPath = ".gates/verified";
if (!existsSync(stampPath)) bad("no gates stamp", "run: npm run gates");
else {
  const stamp = readFileSync(stampPath, "utf8").trim().split(/\s+/)[0];
  if (stamp === tree) ok("gates passed on exactly this tree", tree.slice(0, 12));
  else bad("the gates stamp is for a different tree", `stamp ${stamp.slice(0, 12)} vs HEAD ${tree.slice(0, 12)} — run: npm run gates`);
}

// ── Decide ───────────────────────────────────────────────────────────────────
if (failed > 0) {
  console.log(`\n${failed} check(s) failed. Nothing pushed.\n`);
  process.exit(1);
}
if (DRY) {
  console.log("\nAll checks pass. --dry-run, so nothing pushed.\n");
  process.exit(0);
}

console.log(`\nAll checks pass. Pushing ${outgoing.length} commit(s) to ${REMOTE}/${BRANCH}…\n`);
try {
  console.log(
    execFileSync("git", ["push", REMOTE, `HEAD:${BRANCH}`], { encoding: "utf8", stdio: "pipe" }).trim() ||
      "pushed.",
  );
} catch (err) {
  const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
  console.log(out || String(err));
  console.log("\nPush refused. Nothing changed on the remote.\n");
  process.exit(1);
}
console.log(`\n✅ Pushed. A merge to ${BRANCH} is a production deploy — confirm it with: npm run check:deployed\n`);
