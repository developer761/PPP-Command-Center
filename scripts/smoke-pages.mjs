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
import { sessionCookie } from "./session-cookie.mjs";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

// Before anything else: is that server this app? Several projects on this
// machine use port 3000, and testing the wrong one reports with complete
// confidence about an app this repo does not contain.
const { assertThisApp } = await import("./assert-this-app.mjs");
await assertThisApp(BASE);

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

/**
 * SWEEP ANY PROBE USER A PREVIOUS RUN LEFT BEHIND.
 *
 * Cleanup lives in a `finally`, which does not run when the process is KILLED
 * — a timeout, a Ctrl-C, a dev server taken down mid-run. Each of those leaves
 * behind a fully-privileged account: is_admin, active, commercial access.
 *
 * Found 2026-09-22 while looking at something else: FOUR of them were sitting
 * in production, the oldest five days old, and they outnumbered the real
 * non-admin users on the platform. Nobody would ever think to look, because
 * the script that made them reports success.
 *
 * So the run starts by deleting every probe account it finds. Self-healing
 * beats remembering.
 */
{
  const { data: stale } = await admin
    .from("profiles")
    .select("user_id, email")
    .like("email", "smoke-%@example.invalid");
  for (const u of stale ?? []) {
    await admin.from("profiles").delete().eq("user_id", u.user_id);
    await admin.auth.admin.deleteUser(u.user_id).catch(() => {});
  }
  if ((stale ?? []).length > 0) {
    console.log(`  (cleared ${stale.length} probe account(s) a killed run left behind)`);
  }
}

const email = `smoke-${Date.now()}@example.invalid`;
const password = "Smoke-" + Math.random().toString(36).slice(2) + "Aa1!";
const { data: created, error: cErr } = await admin.auth.admin.createUser({
  email, password, email_confirm: true,
  // Admin-made, like every Settings → Access account: the session-refresh
  // proxy's domain guard lets provisioned accounts in on any email.
  app_metadata: { provisioned: true },
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
    // BOTH platforms. This said has_command_center_access: false, because the
    // smoke was written for Commercial — so `staticPages()` walked only
    // app/commercial and every /dashboard page 307'd to /commercial. "All 73
    // pages returned 200" was true and covered NONE of the residential
    // Command Center, which is the side being launched.
    // ALL THREE platforms, for the reason above: the probe user's flags decide
    // which trees it can see, and a tree it cannot see reports 20 pages "down"
    // (they redirect to /choose-platform) rather than being tested. This said
    // two platforms while the paths list walked three.
    is_active: true, has_new_platform_access: true, has_command_center_access: true,
    has_messaging_access: true,
    auth_provider: "password",
  });

  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error("sign-in failed: " + sErr.message);

  // Built by @supabase/ssr's own functions, in scripts/session-cookie.mjs.
  // The hand-rolled version here encoded plain base64 where the server decodes
  // base64URL, and was one of three copies of the same few lines.
  const cookie = sessionCookie(env.NEXT_PUBLIC_SUPABASE_URL, sess.session);

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

  // Materials ordering — the residential flow, and until 2026-09-09 NOT ONE of
  // its pages was in this list. 73 green pages said nothing about the surface
  // being launched. A real (work order, supplier) pair comes from a committed
  // build so the order screens render with data rather than a not-found.
  const { data: build } = await admin
    .from("supplier_order_builds")
    .select("work_order_id, supplier_account_id")
    .not("work_order_id", "is", null)
    .limit(1);

  const paths = [
    ...staticPages(),                              // /commercial/*
    ...staticPages("app/dashboard", "/dashboard"), // residential Command Center
    /**
     * AND CONNECT HUB, which was not here — the same omission the comment on
     * the probe user above describes, a third time.
     *
     * Every page of the SMS console: the dashboard, the agent settings, the
     * rules, the training hub, the review queues. That is the surface being
     * launched to Kate and the one being changed daily, and "all pages
     * returned 200" has never once included it.
     */
    ...staticPages("app/messaging", "/messaging"),
  ];
  if (build?.[0]) {
    const wo = encodeURIComponent(build[0].work_order_id);
    const sup = encodeURIComponent(build[0].supplier_account_id);
    paths.push(
      `/dashboard/materials/${wo}`,
      `/dashboard/materials/${wo}/order`,
      `/dashboard/materials/${wo}/order/${sup}`,
    );
  } else {
    // Never let a missing fixture read as coverage.
    console.log("  ⚠ no supplier_order_builds row — the 3 order pages were NOT smoke-tested");
  }
  if (acc?.[0]) paths.push(`/commercial/accounts/${acc[0].id}`, `/commercial/accounts/${acc[0].id}/edit`);
  if (inv?.[0]) paths.push(`/commercial/invoices/${inv[0].id}`);

  /**
   * ONE CONVERSATION OF EACH STATE, for the reason spelled out below about
   * opportunities: the thread page branches on state. An ai_active thread
   * renders the agent's drafts and the approve controls; a human_active one
   * renders the takeover banner and the reply box; an ended one renders
   * neither. Whichever came back first would be the only path covered.
   *
   * This is the screen somebody at PPP will have open all day, and until now
   * it was not loaded by anything.
   */
  for (const state of ["ai_active", "human_active", "ended"]) {
    const { data: conv } = await admin
      .from("sms_conversations").select("id").eq("state", state).limit(1);
    if (conv?.[0]) paths.push(`/messaging/${conv[0].id}`);
    else console.log(`  ⚠ no ${state} conversation — that thread state was NOT smoke-tested`);
  }
  // ONE DEAL OF EVERY STATUS, not just one deal.
  //
  // This picked a single opportunity and walked its tabs. But the detail page
  // branches hard on status: a won deal fetches financials, change orders,
  // submittals, closeout, retainage and the AIA roll-up, and a bid fetches none
  // of them — so whichever deal came back first was the only path covered, and
  // the other six statuses rendered in nobody's test. The page is 8,300 lines
  // and the most-edited file in the platform; that is the wrong one to cover
  // a seventh of.
  const OPP_TABS = [
    "", "?tab=info", "?tab=proposals", "?tab=docs", "?tab=activity",
    "?tab=project&sub=invoices", "?tab=project&sub=aia",
    "?tab=project&sub=change-orders", "?tab=project&sub=submittals",
  ];
  const OPP_STATUSES = [
    "post_sale_closed", "pre_construction", "proposal",
    "estimating", "billing", "in_progress", "pre_sale_closed",
  ];
  for (const st of OPP_STATUSES) {
    const { data, error } = await admin
      .from("commercial_opportunities")
      .select("id, account:commercial_accounts!inner(deleted_at)")
      .is("deleted_at", null)
      .is("account.deleted_at", null)
      .eq("status", st)
      .limit(1);
    // A bad column name here comes back as zero rows, and a silent zero reads
    // exactly like "no deal in that status" — which is how a probe reports
    // full coverage of nothing. (It did: `name` is not a column on this table.)
    if (error) { console.log(`  ⚠ status ${st} lookup FAILED (${error.message}) — NOT smoke-tested`); continue; }
    if (!data?.[0]) { console.log(`  ⚠ no live ${st} deal — that status was NOT smoke-tested`); continue; }
    for (const t of OPP_TABS) paths.push(`/commercial/opportunities/${data[0].id}${t}`);
  }
  if (opp?.[0]) {
    const id = opp[0].id;
    // The per-job report lives under a [dynamic] folder, so the directory walk
    // above cannot see it — the deepest new Reports page would have had zero
    // coverage.
    paths.push(`/commercial/reports/jobs/${id}`, `/commercial/reports/jobs/${id}?period=this_year`);
  }

  /**
   * Retry across a dev-server RESTART, not just a blip.
   *
   * `next dev` restarts itself when it nears its heap limit — loading the
   * residential Command Center pulls a Salesforce snapshot of ~17k
   * opportunities and ~20k work orders, which reaches that threshold on a
   * normal run. Every request in flight then fails with a bare `fetch failed`,
   * and so does every request after it until the server is listening again.
   *
   * The old version retried twice with NO delay, so both attempts landed
   * inside the same restart window and the rest of the run reported every
   * remaining page DOWN. That is precisely the false alarm AGENTS.md warns
   * about — "69 of 73 pages are down" was a dying server, not the code — and
   * it happened twice more today: 21 pages, then 71, all of which rendered
   * fine when asked again.
   *
   * So a connection error now WAITS for the port to come back rather than
   * counting it as a failure. A page that is genuinely broken still returns a
   * 500, which is a response, and is reported as it always was.
   */
  async function fetchWithRetry(url, cookie) {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await fetch(url, { headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        lastErr = e;
        // Give the server time to finish restarting, backing off up to ~8s.
        const waitMs = Math.min(500 * 2 ** attempt, 8000);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastErr;
  }

  let bad = 0;
  // SMOKE_ONLY=<substring> narrows the run when chasing one page.
  const only = process.env.SMOKE_ONLY;
  // SMOKE_EXTRA=<comma-separated paths> adds paths the directory walk cannot
  // find — a tab behind ?view=, a filtered report. Without it "is that form on
  // the page?" is unanswerable for anything that is not the default view.
  const extra = (process.env.SMOKE_EXTRA ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  // Deduped: the per-status sweep above and the single `opp` fixture can land
  // on the same deal, and loading the same URL twice is only slower, never
  // more coverage.
  const all = [...new Set([...paths, ...extra])];
  const list = only ? all.filter((p) => p.includes(only)) : all;
  for (const p of list) {
    let code = "ERR";
    let where = "";
    const started = Date.now();
    try {
      // A bare "DOWN" with the reason thrown away has been read as "the page is
      // broken" three times now, when the fetch itself had timed out against a
      // dev server still compiling. Say WHY, and give a slow page a second go
      // before calling it down.
      const res = await fetchWithRetry(BASE + p, cookie);
      code = String(res.status);
      // SMOKE_GREP=<text> — does the page actually CONTAIN this? A 200 says the
      // page rendered, never what it rendered, and "I removed that from the UI"
      // is a claim worth being able to check against the real bytes.
      if (process.env.SMOKE_GREP && code === "200") {
        const html = await res.text();
        const hits = html.split(process.env.SMOKE_GREP).length - 1;
        console.log(`  ${hits ? "FOUND" : "absent"}  ${String(hits).padStart(3)}×  "${process.env.SMOKE_GREP}"  on  ${p}`);
      }
      // A bare "307" says a page bounced but not WHERE, and the destination is
      // the whole diagnosis — /choose-platform is an access gate, /?error= is a
      // deactivated account, / is no session at all.
      if (code !== "200") where = res.headers.get("location") ?? "";
    } catch (e) {
      code = "DOWN";
      where = e instanceof Error ? `${e.message}${e.cause instanceof Error ? ` (${e.cause.message})` : ""}` : String(e);
    }
    const ms = Date.now() - started;
    if (code !== "200") { console.log(`  ${code}  ${p}${where ? `  →  ${where}` : ""}`); bad++; }
    // A page that loads is not the same as a page that loads in time. SLOW is
    // not a failure, but it is the thing somebody notices first.
    else if (ms > 3000 || process.env.SMOKE_TIMES) console.log(`  ${ms > 3000 ? "SLOW" : "  ok"}  ${String(ms).padStart(6)}ms  ${p}`);
  }
  console.log(bad === 0
    ? `✅ all ${list.length} pages returned 200`
    : `❌ ${bad} of ${list.length} pages did not return 200`);
  await cleanup();
  process.exit(bad === 0 ? 0 : 1);
} catch (err) {
  await cleanup();
  console.error("smoke failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
