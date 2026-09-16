/**
 * Create the two Commercial logins Katie confirmed (2026-09-15), through the
 * app's own createPasswordUser — same path as Settings → Access, so the profile
 * flags, the provisioned marker and the access_audit row all match.
 *
 *   node --env-file=.env.local --conditions=react-server --experimental-strip-types \
 *     --import ./scripts/ts-resolve-register.mjs scripts/provision-commercial-logins.mjs
 *
 * Passwords are generated with the CSPRNG and written to a 0600 file on the
 * Desktop — they are never printed into a transcript or committed. Re-running is
 * safe: an existing profile is reported, not overwritten.
 */
import { randomInt } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createPasswordUser } from "../lib/auth/user-management.ts";

const PEOPLE = [
  { email: "mary@tomcopainting.com", full_name: "Mary O'Sullivan", role: "account_manager", why: "Finance — needs Accounting" },
  { email: "k.polanco@precisionpaintingplus.com", full_name: "Kelvi Polanco", role: "rep", why: "Field user — Project Manager" },
];

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data: actorRow } = await sb.from("profiles").select("user_id,email").eq("email", "developer@precisionpaintingplus.net").single();
if (!actorRow) { console.error("no developer@ profile to act as"); process.exit(1); }
const actor = { user_id: actorRow.user_id, email: actorRow.email };

function password() {
  const lower = "abcdefghijkmnpqrstuvwxyz", upper = "ABCDEFGHJKLMNPQRSTUVWXYZ", nums = "23456789";
  const all = lower + upper + nums;
  const pick = (s) => s[randomInt(s.length)];
  const chars = [pick(lower), pick(upper), pick(nums), ...Array.from({ length: 11 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}

const lines = [`Commercial logins — created ${new Date().toISOString()}`, ""];
for (const p of PEOPLE) {
  const pw = password();
  const r = await createPasswordUser({
    email: p.email, password: pw, full_name: p.full_name, role: p.role, actor,
    platforms: { commandCenter: false, commercial: true },
  });
  if (r.ok) {
    lines.push(`${p.full_name}  <${p.email}>`, `  password: ${pw}`, `  role: ${p.role} (${p.why})`, "");
    console.log(`created  ${p.email}  (${p.role})`);
  } else {
    lines.push(`${p.full_name}  <${p.email}>  NOT created: ${r.error}`, "");
    console.log(`SKIPPED  ${p.email}  — ${r.error}`);
  }
}

const out = join(homedir(), "Desktop", "PPP", "tomco-logins.txt");
writeFileSync(out, lines.join("\n"));
chmodSync(out, 0o600);
console.log(`\npasswords written to ${out} (readable only by you) — share them with Katie, then delete the file`);
