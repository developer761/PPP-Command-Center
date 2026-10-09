/**
 * A SETTING THE GATE ENFORCES THAT NOTHING CAN SET.
 *
 *   node scripts/check-settings-have-writers.mjs
 *
 * READ ONLY. Reads source files and nothing else.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * check-unpassed-options.mjs finds a value produced and handed to nobody.
 * This is its mirror, and it is the more expensive half: a value READ and
 * written by nobody. The gate consults it on every send, the column sits at
 * its migration default on all thirty-three workspaces, and there is no
 * control anywhere — so the behaviour is whatever the default happened to be,
 * permanently, and it looks configurable from the code.
 *
 * `send_on_holidays` shipped exactly like that on 2026-10-07. The gate refused
 * to text on US federal holidays, the column defaults to false, and it was in
 * neither COPYABLE_SETTINGS nor NEVER_COPIED, absent from the settings page,
 * absent from the hours form and absent from the patch builder. PPP could not
 * decide to work July 4th, and nothing said so.
 *
 * `send_on_weekends`, added months earlier, had every one of those. The two
 * are twins and only one was wired, which is the shape this repo keeps hitting.
 *
 * ── WHAT IT CHECKS ──────────────────────────────────────────────────────
 *
 * Every field of GateWorkspace — the subset of a workspace row the gate reads
 * — must either be written somewhere in lib/, app/ or components/, or be named
 * in ALLOWED with a reason. A write is a `column:` inside an insert/update
 * payload, or a `patch.column =` assignment.
 *
 * Reading the gate's own type rather than a list kept here is the point: a new
 * field on GateWorkspace is a new thing the gate decides by, so it is exactly
 * when this question needs asking again.
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

const SOURCES = ["lib", "app", "components"].flatMap((r) => walk(r));

/**
 * Looked at and accepted. A reason is required, because an unexplained entry
 * is how a real finding gets silenced.
 */
const ALLOWED = new Map([
  ["id", "the primary key, not a setting"],
  ["name", "set when the workspace is created, not configured per send"],
  ["phone_e164", "provisioned with the number, not a policy switch"],
  ["origination_identity", "how AWS addresses a shared number; set with the number"],
  ["time_zone", "written by saveWorkspaceHours as time_zone, which this does find — kept here only if that changes"],
]);

const gate = readFileSync("lib/messaging/gate.ts", "utf8");
const block = gate.match(/export type GateWorkspace = \{([\s\S]*?)\n\};/);
if (!block) {
  console.error("COULD NOT CHECK: GateWorkspace is not where this expected it.");
  console.error("That type is the whole input to this check, so a rename here is");
  console.error("a prompt to update it, not a pass.");
  process.exit(2);
}

/** Field names, ignoring the doc comments between them. */
const fields = [...block[1]
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .matchAll(/^\s*([a-z_][a-z0-9_]*)\s*\??\s*:/gim)]
  .map((m) => m[1]);

if (!fields.length) {
  console.error("COULD NOT CHECK: GateWorkspace parsed to zero fields.");
  process.exit(2);
}

const findings = [];
for (const field of fields) {
  if (ALLOWED.has(field)) continue;
  /**
   * A WRITE, NOT A MENTION — AND `field:` ON ITS OWN IS A MENTION.
   *
   * The first version of this looked for `field:` anywhere outside a
   * `.select()`. It reported "none" both before and after send_on_holidays was
   * wired, because two things that are not writes match that shape:
   *
   *   send_on_holidays: boolean | null;          a TYPE field
   *   send_on_holidays: "Sends on public holidays"   a LABEL map entry
   *
   * A detector that cannot tell a type declaration from an update payload
   * reports the absence of the bug it was written for. So the write has to be
   * inside something that writes: the argument of insert/update/upsert, or an
   * assignment onto a patch object that such a call then sends.
   */
  const written = SOURCES.some((f) => {
    const src = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const key = new RegExp(`(?:^|[\\s,{])${field}\\s*:`, "m");
    // `patch.col = …`, or any local object the code assigns onto before
    // handing it to an update. The name is not assumed to be `patch`.
    if (new RegExp(`\\b[a-zA-Z_$][\\w$]*\\.${field}\\s*=[^=]`).test(src)) return true;
    for (const call of src.matchAll(/\.(?:insert|update|upsert)\(\s*\{([\s\S]{0,1200}?)\}\s*[,)]/g)) {
      if (key.test(call[1])) return true;
    }
    // COPYABLE_SETTINGS is a writer by proxy: settings-copy-write builds both
    // its SELECT and its UPDATE from that one list, so a column named there is
    // genuinely written. Matched as a bare string in the array, which is what
    // distinguishes it from a label map's `key: "value"`.
    if (/COPYABLE_SETTINGS\s*=/.test(src)
      && new RegExp(`^\\s*"${field}",`, "m").test(src)) return true;
    return false;
  });
  if (!written) findings.push(field);
}

console.log("\nSETTINGS THE GATE READS THAT NOTHING WRITES\n");
if (!findings.length) {
  console.log("  none\n");
  process.exit(0);
}
for (const f of findings) {
  console.log(`  ✗  ${f}`);
  console.log(`       read by the gate, and no insert, update or patch sets it.`);
  console.log(`       Whatever the column defaults to is the permanent behaviour.`);
}
console.log(
  `\n${findings.length} found. Give it a control and a writer, or add it to ALLOWED`
  + `\nin this file WITH THE REASON.\n`
);
process.exit(1);
