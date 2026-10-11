/**
 * Does every walkthrough step actually point at something?
 *
 * The guide's surfaces declare a `tourTarget`, and the tour spotlights the
 * element carrying that `data-tour`. If the attribute is not on the page, the
 * tour dims the screen and points at nothing — the exact failure the tour
 * component's own comments already describe once, from the version that
 * spotlighted sidebar rows a restructure had deleted.
 *
 * Nothing in the type system can see this: the target is a string on one side
 * and an attribute on the other, in different files, and both sides compile.
 * Only loading the page can tell you. So this loads them, as a signed-in user,
 * the same way `smoke-pages.mjs` does.
 *
 *   npm run dev              # in another terminal
 *   node scripts/check-tour-targets.mjs
 *
 * It caught seven missing hooks the first time it ran: the accounting tabs
 * behind "More" render from a second map that had not been tagged.
 */
import { readFileSync } from "node:fs";
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

/** The surfaces that declare a target, read from the guide itself. */
const { ROLES } = await import("../lib/commercial/guide/roles.ts").catch(async () => {
  // The guide is TypeScript; Node cannot import it directly on every version.
  // Fall back to reading the declarations out of the source, which is enough:
  // this script checks the PAGE end of the seam, not the guide's syntax.
  const sources = ["lib/commercial/guide/roles.ts", "lib/commercial/guide/roles-delivery.ts"];
  const surfaces = [];
  for (const f of sources) {
    const text = readFileSync(f, "utf8");
    // Pair each tourTarget with the href of the surface it belongs to.
    // Walk surface by surface so a control's hook is checked on ITS page.
    const blocks = text.split(/\n        \{\n          name:/);
    for (const b of blocks) {
      const href = /href:\s*"([^"]+)"/.exec(b);
      if (!href) continue;
      for (const m of b.matchAll(/tourTarget:\s*"([^"]+)"/g)) {
        surfaces.push({ href: href[1], tourTarget: m[1] });
      }
    }
  }
  return { ROLES: [{ chapters: [{ surfaces }] }] };
});

// `:job` / `:wonjob` are resolved at render time against a real job. Fill them
// the same way here, or every job-scoped hook would be checked against a URL
// that 404s and report a false miss.
const { getSampleJob, resolveJobHref } = await import("../lib/commercial/guide/sample-job.ts").catch(() => ({}));
let sample = { wonId: null, anyId: null };
if (getSampleJob) {
  sample = await getSampleJob();
} else {
  const won = await admin
    .from("commercial_opportunities")
    .select("id")
    .in("status", ["pre_construction", "in_progress", "billing"])
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const any = await admin
    .from("commercial_opportunities")
    .select("id")
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  sample = { wonId: won.data?.id ?? null, anyId: any.data?.id ?? null };
}
const fill = (href) =>
  resolveJobHref
    ? resolveJobHref(href, sample)
    : href.includes(":wonjob")
      ? sample.wonId && href.replace(":wonjob", sample.wonId)
      : href.includes(":job")
        ? sample.anyId && href.replace(":job", sample.anyId)
        : href;

const targets = [];
let unresolved = 0;
for (const r of ROLES) {
  for (const c of r.chapters) {
    for (const su of c.surfaces) {
      if (!su.tourTarget) continue;
      const route = fill(su.href);
      if (!route) {
        unresolved++;
        console.log(`  skip  ${su.tourTarget.padEnd(32)} ${su.href} (no job on the book to resolve it)`);
        continue;
      }
      targets.push({ target: su.tourTarget, route });
    }
  }
}
if (targets.length === 0) {
  console.error("No tour targets found — the parser above is out of step with the guide.");
  process.exit(1);
}

const email = `tourcheck-${Date.now()}@example.invalid`;
const password = "Tour-" + Math.random().toString(36).slice(2) + "Aa1!";
const { data: created, error: cErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  // Admin-made, like every Settings → Access account: the session-refresh
  // proxy's domain guard lets provisioned accounts in on any email.
  app_metadata: { provisioned: true },
});
if (cErr) {
  console.error("could not create the probe user:", cErr.message);
  process.exit(1);
}
const uid = created.user.id;

try {
  await admin.from("profiles").insert({
    user_id: uid,
    email,
    full_name: "Tour Check",
    role: "admin",
    is_admin: true,
    is_active: true,
    has_new_platform_access: true,
    has_command_center_access: true,
    auth_provider: "password",
  });
  const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: sess, error: sErr } = await anon.auth.signInWithPassword({ email, password });
  if (sErr) throw new Error("sign-in failed: " + sErr.message);
  const cookie = sessionCookie(env.NEXT_PUBLIC_SUPABASE_URL, sess.session);

  /**
   * A PAGE THAT NEVER LOADED IS NOT A MISSING TARGET.
   *
   * Both used to be counted as `missing`, and the summary read "53 of 53
   * walkthrough targets are not rendered — those steps would spotlight
   * nothing". Every page had in fact answered 307 and nothing at all was known
   * about any target. Somebody running `npm run verify` was told the
   * walkthrough was entirely broken; the truth was that port 3000 was serving
   * a different project, which assert-this-app.mjs now refuses up front.
   *
   * That guard makes this one redundant for that particular cause, and it
   * stays anyway: "could not load the page" and "the target is not on the
   * page" are different findings whatever the reason, and this check exists
   * because the second one is invisible to every other gate.
   *
   * The redirect's destination is printed, because "→ /login" and
   * "→ /onboarding" are different problems and the Location header is the one
   * thing that tells them apart.
   */
  const pages = new Map();
  let missing = 0;
  const unreachable = new Map();
  for (const { target, route } of targets) {
    if (!pages.has(route)) {
      const res = await fetch(BASE + route, {
        headers: { cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status !== 200) {
        const where = res.headers.get("location");
        console.log(`  DOWN  ${route} → HTTP ${res.status}${where ? ` → ${where}` : ""}`);
        pages.set(route, null);
        unreachable.set(route, `${res.status}${where ? ` → ${where}` : ""}`);
      } else {
        pages.set(route, await res.text());
      }
    }
    const html = pages.get(route);
    if (html === null) {
      console.log(`  ????  ${target.padEnd(32)} ${route} (page did not load — not checked)`);
      continue;
    }
    const ok = html.includes(`data-tour="${target}"`);
    if (!ok) missing++;
    console.log(`  ${ok ? "ok  " : "MISS"}  ${target.padEnd(32)} ${route}`);
  }

  const unchecked = targets.filter((t) => unreachable.has(t.route)).length;
  if (unreachable.size) {
    console.log(
      `\n⚠  ${unreachable.size} page(s) did not load as the probe user, so ${unchecked} target(s)`
      + ` were not checked. This is the script's own sign-in or ${BASE} being the wrong server —`
      + ` it says NOTHING about the walkthrough. First one: ${[...unreachable][0][0]} ${[...unreachable][0][1]}`
    );
  }
  const checked = targets.length - unchecked;
  console.log(
    missing === 0
      ? `\n✅ all ${checked} walkthrough targets that could be checked are on their page`
      : `\n❌ ${missing} of ${checked} checked walkthrough targets are not rendered — those steps would spotlight nothing`
  );
  // Either is a failure: a target that is gone, and a run that proved nothing.
  process.exitCode = missing === 0 && unreachable.size === 0 ? 0 : 1;
} finally {
  await admin.from("profiles").delete().eq("user_id", uid);
  await admin.auth.admin.deleteUser(uid);
}
