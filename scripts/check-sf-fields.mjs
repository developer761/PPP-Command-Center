/**
 * Does every field our SOQL selects actually exist in Salesforce?
 *
 * The failure this exists for (2026-09-09): `Account.Email__c` was in the
 * snapshot's account SELECT and does not exist in PPP's org. SOQL fails the
 * WHOLE query on one bad field, and the catch fell back to a narrower field
 * list — which also dropped PersonEmail, Phone and all four Billing address
 * fields. Result: 0 of 7,000 cached accounts had an address while Salesforce
 * had 89,057 of 92,076. Nothing failed. No test could see it: the unit suite
 * is credential-free and the fallback made the query "succeed".
 *
 * Read-only. Describes each object once and checks the field names we ask for.
 */
import { createClient } from "@supabase/supabase-js";
import jsforce from "jsforce";
import { readFileSync, readdirSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const FILES = readdirSync("lib/salesforce").filter((f) => f.endsWith(".ts")).map((f) => `lib/salesforce/${f}`);

/**
 * Resolve `${CONST}` against a `const CONST = ...` in the same file.
 *
 * Handles backticks, "double" and 'single' quotes, and an array of string
 * literals that gets .join()ed. The first version only did backticks, so
 * `const richFields = \`${baseFields}, ...\`` — where baseFields is a plain
 * double-quoted string — stayed unresolved, and the three non-existent User
 * fields inside it went unreported.
 */
function expand(text, src, depth = 0) {
  if (depth > 6) return text;
  return text.replace(/\$\{(\w+)\}/g, (whole, name) => {
    // A name declared more than once in the file is scoped, and a regex has no
    // scope. `const fields = ...` appears FOUR times in queries.ts — one per
    // query — so resolving it to the first declaration attributed one object's
    // field list to four different objects and invented 17 "missing" fields
    // that the code never asks for. Refuse rather than guess; the caller
    // reports these as unresolved, which is a blind spot, not a pass.
    const declared = [...src.matchAll(new RegExp("const\\s+" + name + "\\s*=", "g"))].length;
    if (declared !== 1) return whole;
    for (const q of ["`", '"', "'"]) {
      const re = new RegExp("const\\s+" + name + "\\s*=\\s*" + q + "([\\s\\S]*?)" + q, "m");
      const m = src.match(re);
      if (m) return expand(m[1], src, depth + 1);
    }
    // const X = ["A", "B__c", ...]  →  "A, B__c"
    const arr = src.match(new RegExp("const\\s+" + name + "\\s*=\\s*\\[([\\s\\S]*?)\\]", "m"));
    if (arr) {
      const items = [...arr[1].matchAll(/["'`]([A-Za-z0-9_.]+)["'`]/g)].map((x) => x[1]);
      if (items.length) return items.join(", ");
    }
    return whole;
  });
}

// object -> Set(field), and where we saw it
const wanted = new Map();
const seenAt = new Map();

let unparsed = 0;
for (const file of FILES) {
  const raw = readFileSync(file, "utf8");
  // Strip comments FIRST. A `SELECT` inside a comment made the non-greedy
  // capture run on until some later `FROM`, swallowing prose as a field list —
  // 25 matches in one file, most of them fiction. Same lesson as
  // check-schema-drift.mjs: never match against unparsed source.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/[^\n]*/gm, " ");
  // The field list may only LOOK like a field list — identifiers, commas,
  // dots and ${...} interpolations. Anything else means we mis-parsed.
  for (const m of src.matchAll(/SELECT\s+([A-Za-z0-9_,.\s${}]+?)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    const object = m[2];
    const fieldsRaw = expand(m[1], raw).replace(/\s+/g, " ").trim();
    if (/COUNT\(|\bSELECT\b/i.test(fieldsRaw)) continue;
    // Anything still holding an unresolved ${...} we could not expand.
    if (fieldsRaw.includes("${")) { unparsed++; continue; }
    for (let f of fieldsRaw.split(",")) {
      f = f.trim();
      if (!f || f.includes("${") || f.includes("(")) continue;
      // Relationship paths: only the first hop is checkable here.
      const head = f.split(".")[0];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(head)) continue;
      if (f.includes(".")) continue;
      if (!wanted.has(object)) wanted.set(object, new Set());
      wanted.get(object).add(f);
      seenAt.set(`${object}.${f}`, file);
    }
  }
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const { data: cred } = await sb.from("system_credentials").select("*");
const get = (k) => cred.find((r) => (r.key ?? r.name ?? "").includes(k))?.value;
const conn = new jsforce.Connection({
  oauth2: { loginUrl: env.SF_LOGIN_URL, clientId: env.SF_CONSUMER_KEY, clientSecret: env.SF_CONSUMER_SECRET },
});
const rr = await conn.oauth2.refreshToken(get("refresh"));
conn.accessToken = rr.access_token;
conn.instanceUrl = rr.instance_url ?? get("instance");

let checked = 0, bad = 0, skipped = 0;
const problems = [];

for (const [object, fields] of [...wanted].sort()) {
  let desc;
  try {
    desc = await conn.sobject(object).describe();
  } catch {
    skipped++;
    console.log(`  ?  ${object.padEnd(22)} not describable (alias or sub-object) — ${fields.size} field(s) unchecked`);
    continue;
  }
  const real = new Set(desc.fields.map((f) => f.name.toLowerCase()));
  const missing = [...fields].filter((f) => !real.has(f.toLowerCase()));
  checked += fields.size;
  bad += missing.length;
  const mark = missing.length ? "✗" : "✓";
  console.log(`  ${mark}  ${object.padEnd(22)} ${String(fields.size).padStart(3)} field(s)${missing.length ? `  — ${missing.length} DO NOT EXIST` : ""}`);
  for (const f of missing) problems.push(`${object}.${f}  (${seenAt.get(`${object}.${f}`)})`);
}

console.log(`\n  CHECKED ${checked} field references across ${wanted.size - skipped} object(s).`);
console.log(`  ${skipped} object(s) not describable · ${unparsed} SELECT(s) with interpolation we could not resolve.`);
if (checked < 40) {
  console.log(`\n  ⚠ Only ${checked} references checked — that is too few for this codebase.`);
  console.log(`  Treat this run as INCONCLUSIVE, not as a pass. Fix the parser first.`);
  process.exit(1);
}
if (problems.length) {
  console.log(`\n  ${problems.length} FIELD(S) DO NOT EXIST IN SALESFORCE:`);
  for (const p of problems) console.log(`    ✗ ${p}`);
  console.log(`\n  One bad name fails the entire SELECT it sits in. If that query has a\n  fallback, the fallback silently drops OTHER fields too — which is how\n  every account address went blank for months.`);
  process.exit(1);
}
console.log("  ✅ every selected field exists.");
