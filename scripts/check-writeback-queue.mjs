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
 * 🔴 THE FIRST VERSION OF THIS FILE WAS ITSELF THE BUG IT TESTS FOR.
 *
 * It inserted a plain pending `sale` row for a real sold deal and asserted, in
 * a comment, that "nothing here ever reaches Salesforce, because every probe
 * row is deleted before the cron can claim it". Nothing made that true. The
 * cron runs `* * * * *` against the same table, the probe was fully claimable
 * in four separate windows, and had the cron won the race it would have run
 * the real write path against the production org — then found the row deleted
 * underneath it, so `markDone` and `markVerifyFailed` would both have silently
 * matched zero rows. A test that can cause an unrecorded production write, and
 * a docblock claiming it cannot. Both of today's recurring faults, in the file
 * written to catch them.
 *
 * So now the probe is UNCLAIMABLE BY CONSTRUCTION, not by timing: every row it
 * creates is born with `attempts = MAX_ATTEMPTS` and a fresh `last_attempt_at`,
 * which are the two filters `claimPending` applies. Any block that needs those
 * cleared restores them in the same breath. The cron cannot see these rows at
 * all.
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const { createClient } = await import("@supabase/supabase-js");
const { MAX_ATTEMPTS } = await import("@/lib/salesforce/tomco-queue");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const TABLE = "commercial_tomco_writeback_queue";

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

/** Everything this run created, so cleanup removes exactly that and no more. */
const mine = new Set();
/** The fields that make a row invisible to `claimPending`. */
const PARKED = () => ({ attempts: MAX_ATTEMPTS, last_attempt_at: new Date().toISOString() });

async function cleanup() {
  for (const id of mine) {
    try {
      const { error } = await sb.from(TABLE).delete().eq("id", id);
      if (error) console.log(`  🔴 could not remove probe row ${id}: ${error.message}`);
    } catch (err) {
      // Never let one failure abandon the rest — this is the only thing
      // standing between a crash and a row left in a production queue.
      console.log(`  🔴 threw removing probe row ${id}: ${err?.message ?? err}`);
    }
  }
}

/*
 * `finally` does not run on a signal, and `npm run verify` is a long chain
 * somebody interrupts routinely. Without these, ^C left a probe row behind.
 */
let cleaning = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (cleaning) return;
    cleaning = true;
    console.log(`\n  ${sig} — removing probe rows before exiting`);
    await cleanup();
    process.exit(130);
  });
}

console.log("\nThe Tomco write-back queue, against the real database\n");

try {
  const { error: readErr } = await sb.from(TABLE).select("id, claimed_at, verify_failed_at").limit(1);
  if (readErr) {
    console.log(`  FAIL  the queue is not ready — ${readErr.message}`);
    console.log("\nApply the migrations under supabase/migrations/*tomco_writeback_queue*.sql first.\n");
    process.exit(1);
  }

  /*
   * CLAIMABLE, not merely unfinished.
   *
   * The first version refused to run while anything had `done_at IS NULL` —
   * but held and stalled entries live in that state BY DESIGN, indefinitely,
   * waiting for a person. One deal waiting on Katie would have made
   * `npm run verify` exit 1 for ever, with a line that reads exactly like a
   * broken invariant. What actually matters is that no row is in flight.
   */
  const { data: inFlight } = await sb
    .from(TABLE)
    .select("id, attempts, last_attempt_at, held_reason")
    .is("done_at", null)
    .lt("attempts", MAX_ATTEMPTS);
  const claimable = (inFlight ?? []).filter((r) => !r.held_reason);
  check("nothing is in flight to collide with", claimable.length === 0, `${claimable.length} claimable, ${(inFlight ?? []).length - claimable.length} held`);
  if (claimable.length > 0) {
    console.log("\nSomething is mid-sync. Re-run when the queue has drained.\n");
    process.exit(1);
  }

  // Deterministic, so a failure is reproducible — `.limit(1)` with no order
  // returns whatever Postgres feels like.
  const { data: deal } = await sb
    .from("commercial_opportunities")
    .select("id, title")
    .eq("status", "post_sale_closed")
    .is("deleted_at", null)
    .order("id")
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
  const bad = await insert({ kind: "change_order", opportunity_id: deal.id, change_order_id: null, ...PARKED() });
  check(
    "a change_order entry with no change order is refused",
    !!bad.error && bad.error.code === "23514",
    bad.error ? bad.error.code : "🔴 it was ACCEPTED",
  );

  // ── one pending entry per thing ───────────────────────────────────────────
  const first = await insert({ kind: "sale", opportunity_id: deal.id, ...PARKED() });
  check("a sale can be queued", !first.error && !!first.data, first.error?.message ?? first.data?.id?.slice(0, 8));
  if (!first.data) {
    console.log("\nCould not create the probe row; the rest cannot run.\n");
    process.exit(1);
  }
  const probeId = first.data.id;
  const second = await insert({ kind: "sale", opportunity_id: deal.id, ...PARKED() });
  check(
    "the same sale cannot be queued twice while one is pending",
    !!second.error && second.error.code === "23505",
    second.error ? second.error.code : "🔴 a second pending entry was ACCEPTED",
  );

  // ── the atomic claim, raced through claimPending ITSELF ───────────────────
  //
  // The first version raced a hand-rolled copy of the UPDATE, which proved
  // Postgres does compare-and-swap and nothing about our code: strip the CAS
  // out of `claimPending` and that check stayed green. This races the real
  // function, so the regression it exists to catch actually fails it.
  const { claimPending, peekPending, markHeld, markFailed, markDone, markVerifyFailed, rearmStalled } = await import(
    "@/lib/salesforce/tomco-queue"
  );
  await sb.from(TABLE).update({ attempts: 0, last_attempt_at: null, claimed_at: null }).eq("id", probeId);
  const [runA, runB] = await Promise.all([claimPending(50), claimPending(50)]);
  const gotA = runA.filter((r) => r.id === probeId).length;
  const gotB = runB.filter((r) => r.id === probeId).length;
  check(
    "two concurrent claimPending calls cannot both take one entry",
    gotA + gotB === 1,
    `A took it ${gotA}×, B took it ${gotB}×`,
  );
  // Park it again the moment the race is over.
  await sb.from(TABLE).update({ claimed_at: null, ...PARKED() }).eq("id", probeId);

  // ── the back-off, and that BOTH filters apply ─────────────────────────────
  await sb.from(TABLE).update({ attempts: 0, last_attempt_at: new Date().toISOString(), claimed_at: null }).eq("id", probeId);
  const inBackoff = await claimPending(50);
  check(
    "an entry inside the retry back-off is not claimed",
    !inBackoff.some((c) => c.id === probeId),
    "the two or() filters are ANDed, not replaced",
  );
  for (const c of inBackoff) await sb.from(TABLE).update({ claimed_at: null }).eq("id", c.id);

  // ── a held entry keeps its retry budget, and loses its claim ──────────────
  //
  // The sentinel matters: `claimed_at` was already null in the first version,
  // so "holding releases the claim" could not fail.
  await sb.from(TABLE).update({ attempts: 0, claimed_at: new Date().toISOString(), ...PARKED() }).eq("id", probeId);
  await sb.from(TABLE).update({ attempts: 0 }).eq("id", probeId);
  await markHeld(probeId, "probe hold");
  const { data: afterHold } = await sb.from(TABLE).select("attempts, claimed_at").eq("id", probeId).maybeSingle();
  check("holding does not spend an attempt", Number(afterHold?.attempts ?? -1) === 0, `attempts ${afterHold?.attempts}`);
  check("holding releases the claim", afterHold?.claimed_at === null, "it was set before the call");

  // ── a failure spends one, and releases the claim ──────────────────────────
  await sb.from(TABLE).update({ claimed_at: new Date().toISOString() }).eq("id", probeId);
  await markFailed(probeId, 0, "probe failure");
  const { data: afterFail } = await sb.from(TABLE).select("attempts, claimed_at, last_error").eq("id", probeId).maybeSingle();
  check("a failure spends exactly one attempt", Number(afterFail?.attempts ?? -1) === 1, `attempts ${afterFail?.attempts}`);
  check("a failure releases the claim", afterFail?.claimed_at === null, "it was set before the call");

  // ── an entry out of retries stops being claimed ───────────────────────────
  await sb.from(TABLE).update({ attempts: MAX_ATTEMPTS, last_attempt_at: null, held_reason: null }).eq("id", probeId);
  const stalledClaim = await claimPending(50);
  check(
    "an entry out of retries is not claimed again",
    !stalledClaim.some((c) => c.id === probeId),
    "it waits for a person",
  );
  for (const c of stalledClaim) await sb.from(TABLE).update({ claimed_at: null }).eq("id", c.id);

  // ── and a person can put it back ──────────────────────────────────────────
  const rearmed = await rearmStalled(probeId);
  const { data: afterRearm } = await sb.from(TABLE).select("attempts, last_error").eq("id", probeId).maybeSingle();
  check(
    "the review screen's button really does re-queue it",
    rearmed.ok && Number(afterRearm?.attempts ?? -1) === 0 && afterRearm?.last_error === null,
    `attempts ${afterRearm?.attempts}`,
  );
  await sb.from(TABLE).update(PARKED()).eq("id", probeId);

  // ── a failed verification outlives being marked done ──────────────────────
  //
  // Sentinel again: `last_error` had been wiped by rearmStalled, so
  // "marking done clears the retry error" could not fail either.
  await sb.from(TABLE).update({ last_error: "probe sentinel" }).eq("id", probeId);
  await markVerifyFailed(probeId, "probe: the read-back disagreed");
  await markDone(probeId, "probe: nothing to do");
  const { data: afterDone } = await sb
    .from(TABLE)
    .select("last_error, verify_failed_at, verify_failed_reason")
    .eq("id", probeId)
    .maybeSingle();
  check("marking an entry done does not erase a failed verification", !!afterDone?.verify_failed_at, afterDone?.verify_failed_reason ?? "🔴 cleared");
  check("marking an entry done does clear the retry error", afterDone?.last_error === null, "a sentinel was set before the call");

  // ── and a verified write clears it ────────────────────────────────────────
  await markDone(probeId, "probe: written and verified", { verified: true });
  const { data: afterVerified } = await sb.from(TABLE).select("verify_failed_at").eq("id", probeId).maybeSingle();
  check(
    "a verified write clears it, so the flag can go green again",
    afterVerified?.verify_failed_at === null,
    String(afterVerified?.verify_failed_at),
  );

  // ── a plan run must not claim ─────────────────────────────────────────────
  await sb.from(TABLE).update({ done_at: null, claimed_at: null, verify_failed_at: null, attempts: 0, last_attempt_at: null }).eq("id", probeId);
  const peeked = await peekPending(50);
  const { data: afterPeek } = await sb.from(TABLE).select("claimed_at").eq("id", probeId).maybeSingle();
  check(
    "a plan run sees the entry without claiming it",
    peeked.some((p) => p.id === probeId) && afterPeek?.claimed_at === null,
    `peeked ${peeked.length}, claimed_at ${afterPeek?.claimed_at}`,
  );
  await sb.from(TABLE).update(PARKED()).eq("id", probeId);
} catch (err) {
  failures++;
  console.log(`  FAIL  the check itself threw — ${err?.message ?? err}`);
} finally {
  await cleanup();
  /*
   * PROVE the cleanup worked. The first version printed "probe rows removed"
   * unconditionally and exited 0 with a live row still in the queue if a
   * delete had failed — an assertion in the shape of a log line.
   */
  const ids = [...mine];
  if (ids.length > 0) {
    const { data: left, error } = await sb.from(TABLE).select("id").in("id", ids);
    if (error) {
      failures++;
      console.log(`\n  FAIL  could not confirm the probe rows are gone — ${error.message}`);
    } else {
      check("every probe row this run created is gone", (left ?? []).length === 0, `${(left ?? []).length} left behind`);
    }
  }
}

console.log(
  failures === 0
    ? "\nThe queue behaves as the code claims.\n"
    : `\n${failures} invariant${failures === 1 ? "" : "s"} broken.\n`,
);
process.exit(failures === 0 ? 0 : 1);
