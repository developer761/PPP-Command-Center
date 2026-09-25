#!/usr/bin/env node
/**
 * Load every tab Mary actually works in, with real data, and read the HTML.
 *
 * `smoke-pages.mjs` walks the app directory, so it loads `/commercial/accounting`
 * once — which renders the Overview — and never touches a single `?view=`.
 * Mary's entire surface is query-param driven: payroll, labor payments,
 * purchases, deposits, the AR sheet. Seventy-three green pages said nothing
 * about any of them.
 *
 * It checks three things per URL, because a 200 is not the same as a working
 * screen:
 *   1. the status is 200 (not a 500, not a redirect to login)
 *   2. the HTML does not carry Next's error markers
 *   3. a string that only appears when THAT tab rendered is present
 *
 * The third is the point. Without it, a page that silently fell back to the
 * Overview would pass every check.
 *
 * Needs a dev server. Creates a throwaway admin, deletes it at the end, and
 * clears any left behind by a killed run.
 *
 *   npm run dev            # in another terminal
 *   node --env-file=.env.local scripts/smoke-accounting-tabs.mjs
 */
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const env = process.env;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// Self-healing: a killed run leaves a live admin account behind.
{
  const { data: stale } = await admin
    .from("profiles")
    .select("user_id")
    .like("email", "acct-smoke-%@example.invalid");
  for (const u of stale ?? []) {
    await admin.from("profiles").delete().eq("user_id", u.user_id);
    await admin.auth.admin.deleteUser(u.user_id).catch(() => {});
  }
  if ((stale ?? []).length) console.log(`  (cleared ${stale.length} leftover probe account(s))`);
}

const email = `acct-smoke-${Date.now()}@example.invalid`;
const password = "Smoke-" + Math.random().toString(36).slice(2) + "Aa1!";
const { data: created, error: cErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (cErr) {
  console.error("could not create the probe user:", cErr.message);
  process.exit(1);
}
const uid = created.user.id;
const cleanup = async () => {
  await admin.from("profiles").delete().eq("user_id", uid);
  await admin.auth.admin.deleteUser(uid).catch(() => {});
};

/**
 * Each tab, with a marker that ONLY that tab renders.
 * Mary is `role: admin`, so this probe is too — a lesser role would test a
 * different screen from the one she sees.
 */
const TABS = [
  ["payroll", "?view=payroll", "Hours to Gusto"],
  ["payroll · a week with hours", "?view=payroll&week=2026-09-14", "Actual cost from Gusto"],
  ["payroll · an empty week", "?view=payroll&week=2026-09-21", "No hours in this week yet"],
  ["labor payments", "?view=labor-out", "Record payment out"],
  ["labor payments · this week", "?view=labor-out&period=this_week", "This week"],
  ["labor payments · last week", "?view=labor-out&period=last_week", "Last week"],
  ["purchases", "?view=purchases", "Record purchase"],
  ["purchases · last month", "?view=purchases&period=last_month", "All time"],
  ["deposits", "?view=deposits", "All time"],
  ["receivables", "?view=receivables", "Receivables"],
  ["AR sheet", "?view=ar", "AR sheet"],
  ["balance owed", "?view=owed", "Balance owed"],
  ["sales tax", "?view=tax", "Sales tax"],
  ["reimbursements", "?view=reimbursements", "Reimbursements"],
  ["job costs", "?view=costs", "Job costs"],
  ["cash flow", "?view=cash", "Cash flow"],
  ["transactions", "?view=transactions", "Transactions"],
  ["AR aging", "?view=aging", "AR aging"],
  ["won, not invoiced", "?view=unbilled", "Won, not invoiced"],
  ["overview", "", "Overview"],
  // MEASUREMENT ROWS — page weight with a window applied, against the same
  // tab unfiltered. The point is what Mary's browser has to download.
  ["transactions · this month", "?view=transactions&tp=this_month", "Transactions"],
  ["transactions · this year", "?view=transactions&tp=this_year", "Transactions"],
  ["purchases · this month", "?view=purchases&period=this_month", "All time"],
  ["deposits · this month", "?view=deposits&period=this_month", "All time"],
];

const pass = [];
const fail = [];

try {
  await admin.from("profiles").insert({
    user_id: uid,
    email,
    full_name: "Accounting Smoke",
    role: "admin",
    is_admin: true,
    is_active: true,
    has_new_platform_access: true,
    has_command_center_access: true,
    auth_provider: "password",
  });

  const anon = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false } },
  );
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error("sign-in failed: " + sErr.message);
  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  const s = sess.session;
  const cookie =
    `sb-${ref}-auth-token=base64-` +
    Buffer.from(
      JSON.stringify({
        access_token: s.access_token,
        token_type: "bearer",
        expires_in: s.expires_in,
        expires_at: s.expires_at,
        refresh_token: s.refresh_token,
        user: s.user,
      }),
    ).toString("base64");

  console.log(`Loading ${TABS.length} accounting tabs as an admin…\n`);

  // One at a time, with a retry. The Labor payments tab renders ~2MB of HTML
  // unfiltered, and firing the next request straight after it made the dev
  // server drop connections — which reads as "15 tabs are broken" when the
  // truth was one heavy page and no breathing room. A probe that reports a
  // false failure is as bad as one that reports a false pass.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function load(url, cookie, attempt = 1) {
    try {
      return await fetch(url, { headers: { cookie }, redirect: "manual" });
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(1500 * attempt);
      return load(url, cookie, attempt + 1);
    }
  }

  for (const [label, qs, marker] of TABS) {
    const url = `${BASE}/commercial/accounting${qs}`;
    try {
      const res = await load(url, cookie);
      const body = res.status === 200 ? await res.text() : "";
      const errored =
        body.includes("__next_error__") ||
        body.includes("Application error: a server-side exception");
      if (res.status !== 200) fail.push(`${label} — HTTP ${res.status}`);
      else if (errored) fail.push(`${label} — rendered Next's error page`);
      else if (!body.includes(marker))
        // The check that matters: a 200 proves the route answered, not that
        // THIS tab drew. A silent fallback to Overview passes everything else.
        fail.push(`${label} — 200 but "${marker}" is not on the page`);
      else pass.push(`${label}  (${(body.length / 1024).toFixed(0)}kb)`);
    } catch (err) {
      fail.push(`${label} — ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(400);
  }
} finally {
  await cleanup();
}

for (const p of pass) console.log(`  ✅ ${p}`);
if (fail.length) {
  console.log(`\n❌ ${fail.length} of ${TABS.length} failed:`);
  for (const f of fail) console.log(`   ${f}`);
}
console.log(`\n${pass.length}/${TABS.length} tabs render.`);
process.exit(fail.length ? 1 : 0);
