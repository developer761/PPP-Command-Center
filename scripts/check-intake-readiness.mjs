/**
 * WHAT WOULD HAPPEN TO REAL LEADS IF WE FLIPPED SENDING ON TODAY.
 *
 *   node --env-file=.env.local scripts/check-intake-readiness.mjs [days]
 *
 * READ ONLY. Writes nothing.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * Every other check in this repo asks whether the CODE is right. This one
 * asks whether the WORLD is ready, using the only evidence that cannot be
 * faked: the leads Salesforce is actually sending us, right now, and what the
 * live intake decided about each one.
 *
 * It matters because the intake pipeline has two independent halves and they
 * fail for unrelated reasons:
 *
 *   decideIntake    does this lead match a workspace, in a live region, with
 *                   a contactable phone, not on the suppression list?
 *   enrolLeadWith   do we have consent, and is a workflow switched on?
 *
 * Routing is decided FIRST, so a lead that reaches the consent gate has
 * already proved the whole routing half works for it. That makes "refused for
 * consent" the GOOD outcome to see in bulk today: it means everything
 * upstream is correct and the only thing missing is the thing Katie is
 * fixing.
 *
 * A lead stuck on region_not_live or no_matching_workspace is a different
 * problem entirely, and one that no amount of consent will solve.
 *
 * Measured 2026-10-12 over 24h: 68 leads, 53 of them refused only for
 * consent. So 78% of live traffic routes end to end today.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const DAYS = Number(process.argv[2] ?? 7);

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const rows = [];
for (let p = 0; ; p++) {
  const { data, error } = await sb.from("sf_lead_inbound")
    .select("status, triage_reason, created_at, workspace_id, payload")
    .order("id").range(p * 500, p * 500 + 499);
  if (error) {
    console.error(`COULD NOT CHECK: ${error.message}`);
    console.error("This is NOT a pass.");
    process.exit(2);
  }
  rows.push(...data);
  if (data.length < 500) break;
}

const cutoff = Date.now() - DAYS * 86_400_000;
const recent = rows.filter((r) => new Date(r.created_at).getTime() >= cutoff);

/**
 * The reasons are free text with a prefix, so they are bucketed by what they
 * MEAN rather than matched exactly — a reason string is written for a person
 * reading one row, not for counting.
 */
const bucket = (r) => {
  const t = String(r.triage_reason ?? "");
  if (/no SMS consent is recorded/i.test(t)) return "routed, waiting on consent";
  if (/opted out/i.test(t)) return "refused: they opted out";
  if (/no active workflow/i.test(t)) return "routed, no workflow switched on";
  if (/region_not_live/i.test(t)) return "workspace matched but NOT LIVE";
  if (/no_matching_workspace/i.test(t)) return "no workspace matches";
  if (/not_serviced/i.test(t)) return "outside the service area";
  if (/no_contactable_phone/i.test(t)) return "no phone to text";
  if (!t) return r.status === "enrolled" ? "ENROLLED" : `(no reason) ${r.status}`;
  return t.split(":")[0].trim().slice(0, 44);
};

const counts = new Map();
for (const r of recent) counts.set(bucket(r), (counts.get(bucket(r)) ?? 0) + 1);

const total = recent.length;
const pct = (n) => `${((n / (total || 1)) * 100).toFixed(0)}%`;

console.log(`\nINTAKE READINESS — ${total} real lead(s) in the last ${DAYS} day(s)\n`);
if (!total) {
  console.log("  No leads in the window. Nothing to conclude — widen it with an argument.\n");
  process.exit(0);
}
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${pct(n).padStart(4)}  ${k}`);
}

/**
 * The headline. Everything that got as far as the consent gate has already
 * proved routing works for it, so these are the leads that would become
 * conversations the moment consent arrives and a workflow is on.
 */
const routedOk = (counts.get("routed, waiting on consent") ?? 0)
  + (counts.get("routed, no workflow switched on") ?? 0)
  + (counts.get("ENROLLED") ?? 0);
const routingBroken = (counts.get("workspace matched but NOT LIVE") ?? 0)
  + (counts.get("no workspace matches") ?? 0)
  + (counts.get("outside the service area") ?? 0)
  + (counts.get("no phone to text") ?? 0);

console.log(`\n  ${routedOk} of ${total} (${pct(routedOk)}) route end to end — workspace, region and phone all good.`);
console.log(`  ${routingBroken} of ${total} (${pct(routingBroken)}) would NOT reach a conversation even with consent.`);

/** Which workspaces the live traffic is actually landing in. */
const { data: ws } = await sb.from("sms_sub_accounts").select("id, name, is_active");
const wsById = Object.fromEntries((ws ?? []).map((w) => [w.id, w]));
const byWs = new Map();
for (const r of recent) {
  if (!r.workspace_id) continue;
  const w = wsById[r.workspace_id];
  const k = w ? `${w.name}${w.is_active ? "" : "  (NOT ACTIVE)"}` : "(unknown workspace)";
  byWs.set(k, (byWs.get(k) ?? 0) + 1);
}
if (byWs.size) {
  console.log(`\n  ── where the traffic is landing ──`);
  for (const [k, n] of [...byWs].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
}

console.log(
  `\n  Nothing here is a pass or a failure — it is the state of the world.`
  + `\n  "routed, waiting on consent" in bulk is the GOOD shape: everything`
  + `\n  upstream is correct and the only gap is the one Katie is closing.`
  + `\n  Leads stuck on region or workspace matching are a different problem,`
  + `\n  and consent will not fix any of them.\n`
);
process.exit(0);
