/**
 * AN OPTION THE PRODUCT DOES NOT ACTUALLY HAVE.
 *
 *   node scripts/check-unpassed-options.mjs
 *
 * READ ONLY. Reads source files and nothing else.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * Karan, 2026-10-07: "how do we keep missing so many simple issues".
 *
 * Because almost none of them are wrong code. They are correct code nobody
 * calls, or calls differently in two places — and a unit test cannot see that,
 * because a unit test calls the thing itself. Two examples from one day:
 *
 *   justAskedForAvailability  declared on availabilityGap, read inside it,
 *                             covered by three tests, and never passed by
 *                             production. Kate's rule that a bare "yes" to
 *                             the availability question counts could not fire
 *                             once, so the best leads could not be closed.
 *   ours                      the hook for telling emailFromCustomer about
 *                             more of PPP's own domains. Never passed, so the
 *                             .com half of a two-domain company read as the
 *                             CUSTOMER's address and the quote would have gone
 *                             to PPP.
 *
 * Both were found by hand. This finds them by machine: an optional field on an
 * `opts`/`options` object that no other module ever supplies.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * It does not flag an option a TEST passes and production does not — that is
 * the justAskedForAvailability shape exactly, and it is reported, not ignored.
 * It does not look at required fields: the type checker already has those.
 *
 * A name in ALLOWED is one somebody has looked at and decided is fine. Adding
 * to that list is the point — it is a decision with a reason next to it, not a
 * number going up.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e)) out.push(full);
  }
  return out;
}

const PROD = ["lib", "app", "components"].flatMap((r) => walk(r));
const TESTS = walk("__tests__");

/**
 * Looked at and accepted. Each needs a reason, because an unexplained entry is
 * how a real finding gets silenced.
 */
const ALLOWED = new Map([
  // Passed straight to Google's Places SDK, which reads it. Not ours to call.
  ["componentRestrictions", "an option of the Google Places widget, not of our code"],
  // Shorthand at the call site (`{ launchAt }`), which this cannot see.
  ["launchAt", "passed by enrol-core as shorthand, which the scan cannot match"],
  // A test seam with a real default behind it: sweepStalled reads each
  // workspace's own time_zone and only lets a caller override it.
  ["officeZoneFor", "sweepStalled defaults it from sms_sub_accounts.time_zone; the option is for tests"],
  // Same shape: the default is PPP's two domains, derived in ourDomains, and
  // the option only lets a caller add more.
  ["ours", "emailFromCustomer knows PPP's .net and .com itself; the option only adds to them"],
]);

const findings = [];
for (const file of PROD) {
  const src = readFileSync(file, "utf8");
  const names = new Set();
  // The shape that bit: an inline options object type on a parameter.
  for (const m of src.matchAll(/\bopts(?:ions)?\s*:\s*\{([^}]{0,500})\}/g)) {
    for (const k of m[1].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\?\s*:/g)) names.add(k[1]);
  }
  for (const name of names) {
    if (ALLOWED.has(name)) continue;
    const passedBy = (f) => new RegExp(`\\b${name}\\s*:`).test(readFileSync(f, "utf8"));
    if (PROD.some((f) => f !== file && passedBy(f))) continue;
    /**
     * AND A LOCAL HELPER CALLED LOCALLY IS STILL CALLED.
     *
     * The first version only looked in OTHER files and reported
     * customer-form-view's `overwrite` — which is passed thirty lines away, by
     * the button Kate asked for. A detector that cries wolf gets switched off,
     * so: in the declaring file, a `name:` that is not the `name?:` of the
     * declaration is a caller.
     */
    const here = readFileSync(file, "utf8");
    const usesHere = [...here.matchAll(new RegExp(`\\b${name}\\s*(\\?)?\\s*:`, "g"))];
    if (usesHere.some((m) => !m[1])) continue;
    findings.push({
      file, name,
      inTests: TESTS.some((f) => { try { return passedBy(f); } catch { return false; } }),
    });
  }
}

console.log("\nOPTIONS NOTHING PASSES — a capability the product may not have\n");
if (!findings.length) {
  console.log("  none\n");
  process.exit(0);
}
for (const f of findings.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log(`  ✗  ${f.name}`);
  console.log(`       declared in ${f.file}`);
  console.log(f.inTests
    ? "       and TESTS pass it — so it is covered, and still unreachable in production"
    : "       and nothing passes it anywhere");
}
console.log(
  `\n${findings.length} found. Either pass it where it was meant to be passed, delete it,`
  + `\nor add it to ALLOWED in this file WITH THE REASON.\n`
);
process.exit(1);
