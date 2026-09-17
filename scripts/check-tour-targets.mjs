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
    const re = /href:\s*"([^"]+)"[\s\S]{0,400}?tourTarget:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) surfaces.push({ href: m[1], tourTarget: m[2] });
  }
  return { ROLES: [{ chapters: [{ surfaces }] }] };
});

const targets = [];
for (const r of ROLES) {
  for (const c of r.chapters) {
    for (const su of c.surfaces) {
      if (su.tourTarget) targets.push({ target: su.tourTarget, route: su.href });
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
      })
    ).toString("base64");

  const pages = new Map();
  let missing = 0;
  for (const { target, route } of targets) {
    if (!pages.has(route)) {
      const res = await fetch(BASE + route, {
        headers: { cookie },
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status !== 200) {
        console.log(`  DOWN  ${route} → HTTP ${res.status}`);
        pages.set(route, "");
      } else {
        pages.set(route, await res.text());
      }
    }
    const ok = pages.get(route).includes(`data-tour="${target}"`);
    if (!ok) missing++;
    console.log(`  ${ok ? "ok  " : "MISS"}  ${target.padEnd(32)} ${route}`);
  }

  console.log(
    missing === 0
      ? `\n✅ all ${targets.length} walkthrough targets are on their page`
      : `\n❌ ${missing} of ${targets.length} walkthrough targets are not rendered — those steps would spotlight nothing`
  );
  process.exitCode = missing === 0 ? 0 : 1;
} finally {
  await admin.from("profiles").delete().eq("user_id", uid);
  await admin.auth.admin.deleteUser(uid);
}
