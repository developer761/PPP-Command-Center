/**
 * Do the snippet table's guarantees actually hold in the database?
 *
 * Unit tests prove resolveSnippets picks the right one from an array. They
 * cannot prove that the partial unique index closes the NULLs-are-distinct
 * hole, or that `btrim` in the index agrees with `.trim()` in JavaScript —
 * both of which are properties of Postgres, not of our code.
 *
 * Writes real rows and deletes them in a finally block, the same shape
 * verify-shared-faqs-e2e.mjs and verify-workspace-config-e2e.mjs use.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { resolveSnippets, checkSnippet } from "../lib/messaging/snippets.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}`); }
  else { fail++; console.log(`  ✗  ${label}  ${extra}`); }
};

const made = [];
const add = async (workspace_id, name, body) => {
  const { data, error } = await sb.from("sms_snippets")
    .insert({ workspace_id, name, body, is_active: true }).select("id").maybeSingle();
  if (data?.id) made.push(data.id);
  return { id: data?.id ?? null, error };
};

const TAG = "zzprobe";

try {
  const { data: ws } = await sb.from("sms_sub_accounts").select("id, name").limit(2);
  const [A, B] = ws;
  console.log(`\nworkspaces: ${A.name} / ${B.name}\n`);

  // 1. The shared tier exists at all.
  const shared = await add(null, `${TAG} Availability`, "Hi {{customer_name}}, what days work?");
  ok("a shared snippet inserts (workspace_id may be NULL)", !shared.error, shared.error?.message);

  // 2. The PARTIAL index. The ordinary unique index cannot see these, because
  //    Postgres treats NULLs as distinct — (NULL,'x') can repeat forever.
  const dupShared = await add(null, `${TAG} AVAILABILITY`, "A different answer.");
  ok("a second SHARED snippet with the same name is refused",
     dupShared.error?.code === "23505", JSON.stringify(dupShared.error)?.slice(0, 120));

  // 3. Same name in a WORKSPACE is allowed — that is the override, not a clash.
  const localSame = await add(A.id, `${TAG} Availability`, "This region's answer.");
  ok("the same name IS allowed for one workspace (that is the override)",
     !localSame.error, localSame.error?.message);

  // 4. And a second one in the same workspace is refused.
  const dupLocal = await add(A.id, `${TAG} availability `, "Third answer.");
  ok("a second snippet with that name in the SAME workspace is refused",
     dupLocal.error?.code === "23505", JSON.stringify(dupLocal.error)?.slice(0, 120));

  // 5. Another workspace is unaffected by either.
  const otherWs = await add(B.id, `${TAG} Availability`, "Other region's answer.");
  ok("another workspace may still have its own with that name",
     !otherWs.error, otherWs.error?.message);

  /**
   * 6. btrim vs .trim(). The index normalises with btrim, which strips ASCII
   *    SPACE only; JavaScript's .trim() strips tabs, newlines and Unicode
   *    space too. A name that differs only by a TAB is therefore two rows to
   *    Postgres and one to us — the resolver would silently drop one and the
   *    rep would never know the other existed.
   */
  const tabbed = await add(null, `${TAG} Availability\t`, "Tab-suffixed.");
  const btrimAgrees = tabbed.error?.code === "23505";
  ok("a name differing only by a TAB is refused too (btrim matches .trim())",
     btrimAgrees,
     btrimAgrees ? "" : "IT IS NOT — the DB allows two rows the resolver collapses to one");

  // 7. Precedence, read back out of the database rather than from an array.
  const { data: rows } = await sb.from("sms_snippets")
    .select("name, body, workspace_id").like("name", `${TAG}%`);
  const forA = resolveSnippets(
    rows.filter((r) => r.workspace_id === null || r.workspace_id === A.id)
        .map((r) => ({ ...r, shared: r.workspace_id === null }))
  );
  const availability = forA.filter((s) => /Availability/i.test(s.name));
  ok("the workspace's own snippet wins, and there is only one of that name",
     availability.length === 1 && availability[0].body === "This region's answer.",
     JSON.stringify(availability.map((s) => s.body)));

  // 8. The one content rule, checked against the real merge-field list.
  ok("a snippet using a field nothing fills is refused",
     checkSnippet({ name: "x", body: "Hi, {{estimator_name}} will call." }).length === 1);
  ok("a snippet using the real merge fields is allowed",
     checkSnippet({ name: "x", body: "Hi {{customer_name}}, call {{workspace_phone}}." }).length === 0);
} catch (e) {
  fail++; console.log("  ✗  threw:", e.message);
} finally {
  for (const id of made) await sb.from("sms_snippets").delete().eq("id", id);
  const { data: left } = await sb.from("sms_snippets").select("id").like("name", `${TAG}%`);
  console.log(`\ncleaned up ${made.length} rows — ${left?.length ?? "?"} probe rows remaining`);
  console.log(`${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
