/**
 * POINT GIT AT scripts/hooks.
 *
 * Run by npm's `prepare`, so `npm install` wires the pre-push hook for whoever
 * clones this repo. .git/hooks is not committed; a directory of hooks in the
 * tree is, which is why core.hooksPath exists.
 *
 * It must never fail a build. Vercel and GitHub Actions both run an install,
 * and neither needs a hook — Vercel's checkout may not even be a git worktree.
 * So every unhappy path here exits 0 with a word about why.
 */
import { execFileSync } from "node:child_process";

const quit = (why) => { console.log(`install-hooks: ${why}`); process.exit(0); };

if (process.env.CI) quit("CI — hooks are for a working copy, not a runner");
if (process.env.VERCEL) quit("Vercel build — nothing to hook");

let inside;
try {
  inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  quit("not a git worktree");
}
if (inside !== "true") quit("not a git worktree");

try {
  const current = execFileSync("git", ["config", "--get", "core.hooksPath"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (current && current !== "scripts/hooks") {
    /**
     * Somebody chose another hooks directory on purpose. Taking it over would
     * silently disable their hooks, which is a worse failure than ours not
     * running.
     */
    quit(`core.hooksPath is already ${current} — leaving it alone`);
  }
} catch { /* unset, which is the normal case */ }

try {
  execFileSync("git", ["config", "core.hooksPath", "scripts/hooks"], { stdio: "ignore" });
  console.log("install-hooks: pre-push gate installed (git config core.hooksPath scripts/hooks)");
} catch (e) {
  quit(`could not set core.hooksPath (${e.message}) — pushes will not be gated`);
}
