/**
 * The write-back queue's invariants, exercised against the real database.
 *
 *   npm run check:writeback
 *
 * WHY THIS EXISTS RATHER THAN A UNIT TEST
 *
 * `npm test` here is deliberately pure-logic — no database, no browser — which
 * keeps it seconds and zero-flake, and means it structurally cannot see this
 * code. Two audits on 2026-10-15 said the same thing: every serious defect
 * found in the queue lived somewhere a green suite could not look. The atomic
 * claim, the retry back-off, the CHECK constraint and the "written but not
 * verified" flag are all database behaviour, and all four were either wrong or
 * unproven when they were written.
 *
 * So this is the layer that can see them. It follows `check:money`: real rows,
 * real constraints, assertions that can fail, and it cleans up after itself.
 *
 * 🔴 IT WRITES. Every row it creates is removed before it exits, including on
 * the failure paths — but it is a live database, so it refuses to run unless
 * the queue is quiet, and it never touches a row it did not create.
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const TABLE = "commercial_tomco_writeback_queue";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

/** Everything this run created, so the finally block can remove exactly that. */
const mine = new Set();
async function cleanup() {
  for (const id of mine) {
    const { error } = await sb.from(TABLE).delete().eq("id", id);
    if (error) console.log(`  🔴 could not remove probe row ${id}: ${error.message}`);
  }
}

console.log("\nThe Tomco write-back queue, against the real database\n");

try {
  // ── it is safe to run ─────────────────────────────────────────────────────
  const { error: readErr } = await sb.from(TABLE).select("id, claimed_at, verify_failed_at").limit(1);
  if (readErr) {
    console.log(`  FAIL  the queue is not ready — ${readErr.message}`);
    console.log("\nApply the migrations under supabase/migrations/*tomco_writeback_queue*.sql first.\n");
    process.exit(1);
  }

  const { count: pendingBefore } = await sb
    .from(TABLE)
    .select("id", { count: "exact", head: true })
    .is("done_at", null);
  /*
   * Refusing on a busy queue is not politeness. The probes below insert a
   * `sale` row for a real deal, and the partial unique index allows only one
   * pending sale per deal — so a probe could collide with genuine work, or
   * worse, the per-minute cron could claim a probe row and try to write it to
   * Salesforce. Quiet means nothing is in flight.
   */
  check("the queue is quiet enough to probe", (pendingBefore ?? 0) === 0, `${pendingBefore} pending`);
  if ((pendingBefore ?? 0) !== 0) {
    console.log("\nSomething is waiting to sync. Re-run when the queue has drained.\n");
    process.exit(1);
  }

  // A deal to hang probes off. Any sold one: nothing here ever reaches
  // Salesforce, because every probe row is deleted before the cron can claim
  // it, and the ones that are claimed are claimed by this script.
  const { data: deal } = await sb
    .from("commercial_opportunities")
    .select("id, title")
    .eq("status", "post_sale_closed")
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  check("there is a deal to probe with", !!deal, deal ? String(deal.title).slice(0, 40) : "none found");
  if (!deal) process.exit(1);

  const insert = async (row) => {
    const { data, error } = await sb.from(TABLE).insert(row).select("id").maybeSingle();
    if (data?.id) mine.add(data.id);
    return { data, error };
  };

  // ── the CHECK that a change order entry carries a change order ────────────
  const bad = await insert({ kind: "change_order", opportunity_id: deal.id, change_order_id: null });
  check(
    "a change_order entry with no change order is refused",
    !!bad.error && bad.error.code === "23514",
    bad.error ? `${bad.error.code}` : "🔴 it was ACCEPTED",
  );

  // ── one pending entry per thing ───────────────────────────────────────────
  const first = await insert({ kind: "sale", opportunity_id: deal.id });
  check("a sale can be queued", !first.error && !!first.data, first.error?.message ?? first.data?.id?.slice(0, 8));
  const second = await insert({ kind: "sale", opportunity_id: deal.id });
  check(
    "the same sale cannot be queued twice while one is pending",
    !!second.error && second.error.code === "23505",
    second.error ? second.error.code : "🔴 a second pending entry was ACCEPTED",
  );

  // ── the atomic claim ──────────────────────────────────────────────────────
  //
  // The defect this replaced: `claimPending` was a plain SELECT, so two
  // overlapping ticks both "claimed" the same entry and both wrote to
  // Salesforce. Raced here rather than reasoned about.
  const claim = () =>
    sb
      .from(TABLE)
      .update({ claimed_at: new Date().toISOString() })
      .eq("id", first.data.id)
      .is("done_at", null)
      .is("claimed_at", null)
      .select("id")
      .maybeSingle();
  const [a, b] = await Promise.all([claim(), claim()]);
  const winners = [a, b].filter((r) => r.data).length;
  check("two ticks racing for one entry produce exactly one winner", winners === 1, `${winners} winner(s)`);

  // ── the back-off, and that both filters apply ─────────────────────────────
  //
  // `claimPending` chains two `.or()` clauses. If PostgREST let the second
  // replace the first rather than ANDing them, the retry back-off would be
  // silently ignored and every held entry retried every minute.
  await sb.from(TABLE).update({ claimed_at: null, last_attempt_at: new Date().toISOString(), held_reason: "probe" }).eq("id", first.data.id);
  const { claimPending, peekPending } = await import("@/lib/salesforce/tomco-queue");
  const claimed = await claimPending(50);
  check(
    "an entry inside the retry back-off is not claimed",
    !claimed.some((c) => c.id === first.data.id),
    `${claimed.length} claimed`,
  );
  // Release anything this claimed so the cron is not left holding them.
  for (const c of claimed) await sb.from(TABLE).update({ claimed_at: null }).eq("id", c.id);

  // ── a held entry keeps its retry budget ───────────────────────────────────
  const { markHeld, markFailed, markDone, markVerifyFailed } = await import("@/lib/salesforce/tomco-queue");
  await sb.from(TABLE).update({ attempts: 0, last_attempt_at: null, held_reason: null }).eq("id", first.data.id);
  await markHeld(first.data.id, "probe hold");
  const { data: afterHold } = await sb.from(TABLE).select("attempts, claimed_at, held_reason").eq("id", first.data.id).maybeSingle();
  check("holding does not spend an attempt", Number(afterHold?.attempts ?? -1) === 0, `attempts ${afterHold?.attempts}`);
  check("holding releases the claim", afterHold?.claimed_at === null, String(afterHold?.claimed_at));

  // ── a failure spends one, and releases the claim ──────────────────────────
  await markFailed(first.data.id, 0, "probe failure");
  const { data: afterFail } = await sb.from(TABLE).select("attempts, claimed_at, last_error").eq("id", first.data.id).maybeSingle();
  check("a failure spends exactly one attempt", Number(afterFail?.attempts ?? -1) === 1, `attempts ${afterFail?.attempts}`);
  check("a failure releases the claim", afterFail?.claimed_at === null, String(afterFail?.claimed_at));

  // ── an entry out of retries stops being claimed ───────────────────────────
  await sb.from(TABLE).update({ attempts: 3, last_attempt_at: null, held_reason: null }).eq("id", first.data.id);
  const stalledClaim = await claimPending(50);
  check(
    "an entry out of retries is not claimed again",
    !stalledClaim.some((c) => c.id === first.data.id),
    "it waits for a person",
  );
  for (const c of stalledClaim) await sb.from(TABLE).update({ claimed_at: null }).eq("id", c.id);

  // ── and a person can put it back ──────────────────────────────────────────
  const { rearmStalled } = await import("@/lib/salesforce/tomco-queue");
  const rearmed = await rearmStalled(first.data.id);
  const { data: afterRearm } = await sb.from(TABLE).select("attempts, last_error").eq("id", first.data.id).maybeSingle();
  check(
    "the review screen's button really does re-queue it",
    rearmed.ok && Number(afterRearm?.attempts ?? -1) === 0 && afterRearm?.last_error === null,
    `attempts ${afterRearm?.attempts}`,
  );

  // ── a failed verification outlives being marked done ──────────────────────
  //
  // The defect: the retry found Salesforce already correct, said "nothing to
  // do", and `markDone` cleared the evidence. A sale at $0 in Katie's reports
  // read as a clean sync.
  await markVerifyFailed(first.data.id, "probe: the read-back disagreed");
  await markDone(first.data.id, "probe: nothing to do");
  const { data: afterDone } = await sb
    .from(TABLE)
    .select("done_at, last_error, verify_failed_at, verify_failed_reason")
    .eq("id", first.data.id)
    .maybeSingle();
  check("marking an entry done does not erase a failed verification", !!afterDone?.verify_failed_at, afterDone?.verify_failed_reason ?? "🔴 cleared");
  check("marking an entry done does clear the retry error", afterDone?.last_error === null, String(afterDone?.last_error));

  // ── and a verified write clears it ────────────────────────────────────────
  await markDone(first.data.id, "probe: written and verified", { verified: true });
  const { data: afterVerified } = await sb.from(TABLE).select("verify_failed_at").eq("id", first.data.id).maybeSingle();
  check(
    "a verified write clears it, so the flag can go green again",
    afterVerified?.verify_failed_at === null,
    String(afterVerified?.verify_failed_at),
  );

  // ── a plan run must not claim ─────────────────────────────────────────────
  await sb.from(TABLE).update({ done_at: null, claimed_at: null, attempts: 0, last_attempt_at: null, verify_failed_at: null }).eq("id", first.data.id);
  const peeked = await peekPending(50);
  const { data: afterPeek } = await sb.from(TABLE).select("claimed_at").eq("id", first.data.id).maybeSingle();
  check(
    "a plan run sees the entry without claiming it",
    peeked.some((p) => p.id === first.data.id) && afterPeek?.claimed_at === null,
    `peeked ${peeked.length}, claimed_at ${afterPeek?.claimed_at}`,
  );
} catch (err) {
  failures++;
  console.log(`  FAIL  the check itself threw — ${err?.message ?? err}`);
} finally {
  await cleanup();
  const { count } = await sb.from(TABLE).select("id", { count: "exact", head: true }).is("done_at", null);
  console.log(`\n  probe rows removed · ${count} entries pending`);
}

console.log(
  failures === 0
    ? "\nThe queue behaves as the code claims.\n"
    : `\n${failures} invariant${failures === 1 ? "" : "s"} broken.\n`,
);
process.exit(failures === 0 ? 0 : 1);
