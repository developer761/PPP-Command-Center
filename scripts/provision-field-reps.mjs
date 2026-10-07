#!/usr/bin/env node
/**
 * THE FALLBACK FOR WHEN GOOGLE SIGN-IN ISN'T AN OPTION.
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs \
 *        scripts/provision-field-reps.mjs            # DRY RUN — shows the plan
 *
 *   … scripts/provision-field-reps.mjs --commit      # actually creates them
 *   … scripts/provision-field-reps.mjs --commit --only a.solomon@,alan@
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * Checked 2026-10-06, the night before the all-staff rollout: 25 active field
 * reps in Salesforce, 24 with no Command Center account. The plan is that they
 * create one themselves by signing in with Google — which works, and is the
 * better route, but ONLY if PPP IT has issued them a Google Workspace account
 * on the PPP domain. Nothing this app can see says whether they have.
 *
 * If it turns out some don't, the alternative was an admin filling in Settings
 * → Access & Users twenty-four times — about six interactions each, with a
 * generated password that is shown once and has to be copied somewhere before
 * moving on. That is a bad thing to discover with twenty people waiting.
 *
 * So this does the same thing in one command, through the SAME audited
 * function the Access page calls (createPasswordUser → audit row, is_admin
 * mirrored, Command Center access only), and prints the email/password pairs
 * in a form that can be pasted into a message.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────
 *
 *   · DRY RUN unless --commit. The default prints the plan and writes nothing.
 *   · Only ever creates ACTIVE Salesforce field reps (Profile *Standard.Field)
 *     whose email is on a PPP domain. It cannot invent a person.
 *   · Skips anyone who already has a profile, on either PPP domain spelling.
 *   · Role is always `rep` — never admin. Promotions stay a deliberate act in
 *     Settings → Access & Users.
 *   · Passwords are random per person and printed ONCE, here. Nothing is
 *     emailed; handing them over stays a human step on purpose.
 *
 * Read the plan, then re-run with --commit. If Google works for everyone, this
 * never needs to run at all — which is the hope, not the assumption.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}

const { getSalesforceClient } = await import("@/lib/salesforce/client");
const { createPasswordUser } = await import("@/lib/auth/user-management");
const { createClient } = await import("@supabase/supabase-js");

const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const onlyArg = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? "";
const ONLY = onlyArg ? onlyArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : null;

/** Readable but not guessable: two words joined by digits beats a hex blob
 *  somebody has to read down a phone line. 12+ chars, well over the 8 minimum. */
function makePassword() {
  const words = ["paint", "brush", "roller", "primer", "satin", "eggshell", "ladder", "canvas", "gallon", "sprayer"];
  const w = () => words[randomBytes(1)[0] % words.length];
  const n = 100 + (randomBytes(2).readUInt16BE(0) % 900);
  return `${w()}-${n}-${w()}`;
}

const conn = await getSalesforceClient();
const { records } = await conn.query(
  `SELECT Id, Name, Email, IsActive, Profile.Name FROM User
   WHERE IsActive = true AND Profile.Name LIKE '%Standard.Field%' ORDER BY Name`
);

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
const { data: profiles, error: profErr } = await sb.from("profiles").select("email,is_active");
if (profErr) {
  console.error("Could not read profiles — refusing to guess who already exists:", profErr.message);
  process.exit(1);
}
const existing = new Set((profiles ?? []).map((p) => String(p.email ?? "").toLowerCase()));
const otherDomain = (e) =>
  e.endsWith("@precisionpaintingplus.net")
    ? e.replace(/\.net$/, ".com")
    : e.replace(/\.com$/, ".net");

const candidates = [];
const skipped = [];
for (const r of records) {
  const email = String(r.Email ?? "").trim().toLowerCase();
  const name = String(r.Name ?? "").trim();
  if (!email) { skipped.push([name || "(no name)", "no email on the Salesforce user"]); continue; }
  if (!/@precisionpaintingplus\.(com|net)$/.test(email)) { skipped.push([email, "not a PPP domain"]); continue; }
  if (existing.has(email) || existing.has(otherDomain(email))) { skipped.push([email, "already has an account"]); continue; }
  if (ONLY && !ONLY.some((o) => email.includes(o))) { skipped.push([email, "not in --only"]); continue; }
  candidates.push({ email, name });
}

console.log(`\n  Active Salesforce field reps : ${records.length}`);
console.log(`  Already have an account      : ${records.length - candidates.length - skipped.filter(([, r]) => r !== "already has an account").length}`);
console.log(`  WOULD CREATE                 : ${candidates.length}`);
if (skipped.length) {
  console.log(`\n  Skipped (${skipped.length}):`);
  for (const [who, why] of skipped) console.log(`    · ${who.padEnd(44)} ${why}`);
}

if (candidates.length === 0) {
  console.log("\n  Nothing to do.\n");
  process.exit(0);
}

if (!COMMIT) {
  console.log(`\n  These ${candidates.length} would be created as role "rep", Command Center only:`);
  for (const c of candidates) console.log(`    + ${c.email.padEnd(44)} ${c.name}`);
  console.log(`\n  DRY RUN — nothing was written. Re-run with --commit to create them.\n`);
  process.exit(0);
}

console.log(`\n  Creating ${candidates.length} account(s)…\n`);
const made = [];
let failed = 0;
for (const c of candidates) {
  const password = makePassword();
  const res = await createPasswordUser({
    email: c.email,
    password,
    full_name: c.name || null,
    role: "rep",
    actor: { user_id: "script:provision-field-reps", email: "script:provision-field-reps" },
  });
  if (res.ok) {
    made.push({ ...c, password });
    console.log(`    ✓ ${c.email}`);
  } else {
    failed++;
    console.log(`    ✗ ${c.email} — ${res.error}`);
  }
}

console.log(`\n  ${made.length} created, ${failed} failed.`);
if (made.length) {
  console.log(`\n  ── HAND THESE OVER. They are not stored anywhere and are not shown again. ──\n`);
  for (const m of made) {
    console.log(`  ${m.name || m.email}`);
    console.log(`    hub.precisionpaintingplus.net`);
    console.log(`    ${m.email}`);
    console.log(`    ${m.password}\n`);
  }
  console.log(`  Tell them to set their state under Account settings before they order —`);
  console.log(`  until they do they see every vendor instead of their own state's.\n`);
}
process.exit(failed ? 1 : 0);
