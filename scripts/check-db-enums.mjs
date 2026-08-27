/**
 * Can the database accept every value the app's own pickers offer?
 *
 * The "one list in two places" seam: a TypeScript const the UI renders from,
 * and a Postgres CHECK the row has to satisfy. TypeScript cannot see the
 * constraint, so the two drift in silence and the only symptom is a form that
 * refuses to submit — with the failure surfacing as a generic "couldn't save".
 *
 * It has already happened here. `commercial_team_members` held ZERO rows
 * because its CHECK predated the role picker by months: every submission of
 * that form had failed, and nothing said so. Migration 166 fixed it. This is
 * what would have caught it the day the picker changed.
 *
 * NOT part of the vitest suite, which is deliberately pure-logic and needs no
 * credentials (see vitest.config.ts). This talks to the real database, like
 * scripts/smoke-pages.mjs does. Run it after changing a picker or a CHECK:
 *
 *   node scripts/check-db-enums.mjs
 *
 * Everything it writes is rolled back before it exits.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// Read the app's lists straight from source, so this cannot drift from them.
const listFrom = (file, name) => {
  const src = readFileSync(file, "utf8");
  const m = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(src);
  if (!m) throw new Error(`could not find ${name} in ${file}`);
  return [...m[1].matchAll(/["'`]([a-z_]+)["'`]/g)].map((x) => x[1]);
};

const CONTACT_ROLES = listFrom("lib/commercial/contacts/roles.ts", "CONTACT_ROLES");
const ASSIGNMENT_ROLES = listFrom("lib/commercial/accounts/assignment-roles.ts", "ASSIGNMENT_ROLES");
const PROPOSAL_STATUSES = listFrom("lib/commercial/proposals/constants.ts", "PROPOSAL_STATUSES");

let failures = 0;
const report = (label, value, error) => {
  if (error) { failures++; console.log(`  ❌ ${label} "${value}" — ${error.message.split("\n")[0].slice(0, 90)}`); }
};

const { data: acct } = await sb.from("commercial_accounts").insert({ company_name: "ZZ enum-check" }).select("id").single();
const accountId = acct.id;
const { data: team } = await sb.from("commercial_teams").insert({ name: "ZZ enum-check team" }).select("id").single();
const { data: prof } = await sb.from("profiles").select("user_id").limit(1).single();
const { data: opp } = await sb.from("commercial_opportunities").insert({ account_id: accountId, title: "ZZ enum-check opp" }).select("id").single();

try {
  for (const role of CONTACT_ROLES) {
    const { data: c } = await sb.from("commercial_contacts").insert({ full_name: `ZZ ${role}` }).select("id").single();
    const { error } = await sb.from("commercial_account_contacts").insert({ account_id: accountId, contact_id: c.id, role }).select("id").single();
    report("commercial_account_contacts.role", role, error);
    await sb.from("commercial_account_contacts").delete().eq("contact_id", c.id);
    await sb.from("commercial_contacts").delete().eq("id", c.id);
  }
  for (const role of ASSIGNMENT_ROLES) {
    const { error } = await sb.from("commercial_team_members").insert({ team_id: team.id, user_id: prof.user_id, role }).select("id").single();
    report("commercial_team_members.role", role, error);
    await sb.from("commercial_team_members").delete().eq("team_id", team.id);
  }
  for (const status of PROPOSAL_STATUSES) {
    const { error } = await sb.from("commercial_proposals").insert({ opportunity_id: opp.id, revision_number: 1, status, header_json: {}, total_cents: 0 }).select("id").single();
    report("commercial_proposals.status", status, error);
    await sb.from("commercial_proposals").delete().eq("opportunity_id", opp.id);
  }
} finally {
  await sb.from("commercial_opportunities").delete().eq("account_id", accountId);
  await sb.from("commercial_teams").delete().eq("id", team.id);
  await sb.from("commercial_accounts").delete().eq("id", accountId);
}

const total = CONTACT_ROLES.length + ASSIGNMENT_ROLES.length + PROPOSAL_STATUSES.length;
if (failures) { console.error(`\n❌ ${failures} of ${total} picker values the database will not accept`); process.exit(1); }
console.log(`✅ all ${total} picker values are writable (contact roles, team roles, proposal statuses)`);
