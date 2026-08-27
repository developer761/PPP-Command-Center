/**
 * Load every Commercial page through the RUNNING app, as a signed-in user.
 *
 * Why this exists: on 2026-08-22 a route with a conflicting dynamic slug
 * (`[id]` beside `[applicationId]`) shipped with tsc clean, 1400 tests green
 * and `next build` EXIT 0 — and the dev server would not boot. Nothing in the
 * normal verification path can see that, because compiling the code is not the
 * same as starting the router.
 *
 * Usage:
 *   npm run dev            # in another terminal
 *   node scripts/smoke-pages.mjs
 *
 * Creates a throwaway user with commercial access, loads every page, prints
 * anything that is not 200, and deletes the user again. Read-only on your data.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const { createClient } = await import("@supabase/supabase-js");
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

/** Every static (non-dynamic) page under app/commercial. */
function staticPages(dir = "app/commercial", path = "/commercial") {
  const out = [];
  const entries = readdirSync(dir);
  if (entries.includes("page.tsx")) out.push(path);
  for (const e of entries) {
    const full = join(dir, e);
    if (!statSync(full).isDirectory()) continue;
    if (e.startsWith("[")) continue; // dynamic — covered by the real-record list
    const seg = e.startsWith("(") && e.endsWith(")") ? "" : `/${e}`;
    out.push(...staticPages(full, path + seg));
  }
  return out;
}

const email = `smoke-${Date.now()}@example.invalid`;
const password = "Smoke-" + Math.random().toString(36).slice(2) + "Aa1!";
const { data: created, error: cErr } = await admin.auth.admin.createUser({
  email, password, email_confirm: true,
});
if (cErr) { console.error("could not create the probe user:", cErr.message); process.exit(1); }
const uid = created.user.id;

async function cleanup() {
  await admin.from("profiles").delete().eq("user_id", uid);
  await admin.auth.admin.deleteUser(uid);
}

try {
  await admin.from("profiles").insert({
    user_id: uid, email, full_name: "Smoke Probe", role: "admin", is_admin: true,
    is_active: true, has_new_platform_access: true, has_command_center_access: false,
    auth_provider: "password",
  });

  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error("sign-in failed: " + sErr.message);

  const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];
  const s = sess.session;
  const cookie =
    `sb-${ref}-auth-token=base64-` +
    Buffer.from(JSON.stringify({
      access_token: s.access_token, token_type: "bearer", expires_in: s.expires_in,
      expires_at: s.expires_at, refresh_token: s.refresh_token, user: s.user,
    })).toString("base64");

  // Real records, so the dynamic routes are exercised too — a page that only
  // renders with data is exactly where a runtime error hides.
  //
  // The opportunity and invoice pick their PARENT too. Filtering on the row's
  // own `deleted_at` alone picked up an ORPHAN — a live job whose GC had been
  // deleted — and every one of its twelve tab URLs then smoke-tested the
  // not-found page and passed. Twelve green checks that touched none of the
  // code they were meant to cover. `!inner` is the Supabase idiom for "the
  // parent must exist AND match the filter below".
  const [{ data: acc }, { data: opp }, { data: inv }] = await Promise.all([
    admin.from("commercial_accounts").select("id").is("deleted_at", null).limit(1),
    admin
      .from("commercial_opportunities")
      .select("id, account:commercial_accounts!inner(deleted_at)")
      .is("deleted_at", null)
      .is("account.deleted_at", null)
      .limit(1),
    admin
      .from("commercial_invoices")
      .select("id, account:commercial_accounts!inner(deleted_at)")
      .is("deleted_at", null)
      .is("account.deleted_at", null)
      .limit(1),
  ]);

  const paths = [...staticPages()];
  if (acc?.[0]) paths.push(`/commercial/accounts/${acc[0].id}`, `/commercial/accounts/${acc[0].id}/edit`);
  if (inv?.[0]) paths.push(`/commercial/invoices/${inv[0].id}`);
  if (opp?.[0]) {
    const id = opp[0].id;
    for (const t of ["", "?tab=info", "?tab=proposals", "?tab=docs", "?tab=activity",
                     "?tab=project&sub=invoices", "?tab=project&sub=aia",
                     "?tab=project&sub=change-orders", "?tab=project&sub=submittals"]) {
      paths.push(`/commercial/opportunities/${id}${t}`);
    }
  }

  let bad = 0;
  for (const p of paths) {
    let code = "ERR";
    try {
      const res = await fetch(BASE + p, { headers: { cookie }, redirect: "manual" });
      code = String(res.status);
    } catch (e) {
      code = "DOWN";
    }
    if (code !== "200") { console.log(`  ${code}  ${p}`); bad++; }
  }
  console.log(bad === 0
    ? `✅ all ${paths.length} pages returned 200`
    : `❌ ${bad} of ${paths.length} pages did not return 200`);
  await cleanup();
  process.exit(bad === 0 ? 0 : 1);
} catch (err) {
  await cleanup();
  console.error("smoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
