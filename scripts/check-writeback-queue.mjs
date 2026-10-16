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
 *
 * AND, SINCE 2026-10-16, A SECOND DEFENCE THAT DOES NOT DEPEND ON TIMING AT
 * ALL. Four blocks below deliberately clear those two fields to exercise the
 * real `claimPending`, so "unclaimable" is true except for the seconds when it
 * is the thing being tested — and spending the attempt at claim time made
 * those seconds longer. The probe therefore names a deal the write path cannot
 * reach Salesforce for: see `pickProbeDeal`. Both defences, because the first
 * one has a hole and the second one is not realistic on its own.
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

  /*
   * 🔴 A DELETED DEAL, AND THAT IS THE POINT.
   *
   * This used to probe with a live `post_sale_closed` deal — the most
   * realistic row, and the most dangerous one. `opportunity_id` carries a
   * foreign key, so the probe must name a REAL deal; the question is what the
   * production cron would do if it ever won the race for the probe row.
   * Against a live sold deal the answer is `runSale` → `updateExisting` or
   * `createNew` against Tomco's org: an unrecorded production write caused by
   * a test. The file's own docblock says that is the fault this file was
   * rewritten to stop making, and "unclaimable by construction" was the
   * defence. That defence has a seam: four blocks here deliberately clear
   * `attempts` and `last_attempt_at` to exercise the real `claimPending`, and
   * for those moments the row IS claimable. Spending the attempt at claim time
   * made those moments longer.
   *
   * A soft-deleted deal closes it. `loadSoldDeal` returns null the instant it
   * sees `deleted_at`, so the worst the cron can do with this row is
   * `markDone("the deal was deleted here")` — no Salesforce write exists on
   * that path at all. The sweep ignores deleted deals too, so nothing
   * re-queues it. Falls back to any not-sold deal, which reaches
   * `markDone("no longer a sold deal here…")` and is equally inert.
   *
   * Ordered, so a failure is reproducible — `.limit(1)` with no order returns
   * whatever Postgres feels like.
   */
  const pickProbeDeal = async () => {
    const { data: deleted } = await sb
      .from("commercial_opportunities")
      .select("id, title")
      .not("deleted_at", "is", null)
      .order("id")
      .limit(1)
      .maybeSingle();
    if (deleted) return { deal: deleted, why: "deleted here — the cron can only mark it done" };
    // `SOLD_STATUSES` in lib/salesforce/tomco-pairing.ts. Anything outside it
    // is not sold, so the write path returns before it reaches Salesforce.
    const sold = ["pre_sale_closed", "pre_construction", "in_progress", "billing", "post_sale_closed"];
    const { data: notSold } = await sb
      .from("commercial_opportunities")
      .select("id, title")
      .not("status", "in", `(${sold.join(",")})`)
      .is("deleted_at", null)
      .order("id")
      .limit(1)
      .maybeSingle();
    return { deal: notSold, why: "not sold here — the cron can only mark it done" };
  };
  const { deal, why: probeWhy } = await pickProbeDeal();
  check(
    "there is a deal to probe with that the cron could not write to Salesforce",
    !!deal,
    deal ? `${String(deal.title).slice(0, 40)} · ${probeWhy}` : "none found",
  );
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

  /*
   * 🔴 PUTTING BACK WHAT A CLAIM TOOK, FOR ROWS THAT ARE NOT OURS.
   *
   * `claimPending` now SPENDS AN ATTEMPT as it claims (see its docblock), so a
   * stray real row swept up by one of these `claimPending(50)` calls would
   * leave this script having quietly burned a third of somebody's retry budget
   * — the kind of damage a test is never allowed to do. The entry it hands
   * back carries the PRE-claim count, so restoring it is exact.
   *
   * Nothing should be claimable at all here; the first check refuses to run
   * otherwise. This is the belt to that braces.
   */
  const release = async (entries) => {
    for (const c of entries) {
      if (c.id === probeId) continue;
      await sb.from(TABLE).update({ claimed_at: null, attempts: c.attempts }).eq("id", c.id);
    }
  };

  await sb.from(TABLE).update({ attempts: 0, last_attempt_at: null, claimed_at: null }).eq("id", probeId);
  const [runA, runB] = await Promise.all([claimPending(50), claimPending(50)]);
  const gotA = runA.filter((r) => r.id === probeId).length;
  const gotB = runB.filter((r) => r.id === probeId).length;
  check(
    "two concurrent claimPending calls cannot both take one entry",
    gotA + gotB === 1,
    `A took it ${gotA}×, B took it ${gotB}×`,
  );
  await release([...runA, ...runB]);
  // Park it again the moment the race is over.
  await sb.from(TABLE).update({ claimed_at: null, ...PARKED() }).eq("id", probeId);

  // ── the claim spends the attempt, so a tick that DIES still pays ──────────
  //
  // `attempts` used to be written only by `markFailed`, which runs only if the
  // tick survives to call it. An entry that kills the tick — a maxDuration
  // overrun, an OOM, a deploy mid-flight — left the counter untouched, went
  // stale after CLAIM_STALE_MS, and was re-claimed with its full budget. For
  // ever, re-running real Salesforce writes every cycle. MAX_ATTEMPTS cannot
  // bound a failure whose nature is that the counter never gets written.
  await sb.from(TABLE).update({ attempts: 0, last_attempt_at: null, claimed_at: null, held_reason: null }).eq("id", probeId);
  const firstClaim = await claimPending(50);
  await release(firstClaim);
  const claimedEntry = firstClaim.find((c) => c.id === probeId);
  const { data: afterClaim } = await sb.from(TABLE).select("attempts").eq("id", probeId).maybeSingle();
  check(
    "claiming an entry spends an attempt, before anything can go wrong",
    Number(afterClaim?.attempts ?? -1) === 1 && claimedEntry?.attempts === 0,
    `row ${afterClaim?.attempts}, entry reports ${claimedEntry?.attempts} spent before the claim`,
  );

  /*
   * And the consequence that is the whole point: an entry that kills the tick
   * every time RUNS OUT. Each loop simulates a death — the claim happened, the
   * tick never reached `markFailed`, and ten minutes later `claimed_at` is
   * stale. Only `claimed_at` is cleared here; `attempts` is left exactly as the
   * claim left it, which is the state a dead tick leaves behind.
   */
  let deaths = 1; // the claim above was the first
  for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
    await sb.from(TABLE).update({ claimed_at: null }).eq("id", probeId);
    const again = await claimPending(50);
    await release(again);
    if (!again.some((c) => c.id === probeId)) break;
    deaths++;
  }
  check(
    "an entry that kills the tick every time stops being claimed",
    deaths === MAX_ATTEMPTS,
    `it was claimed ${deaths}× before the budget ran out (MAX_ATTEMPTS ${MAX_ATTEMPTS})`,
  );
  await sb.from(TABLE).update({ claimed_at: null, ...PARKED() }).eq("id", probeId);

  // ── the back-off, and that BOTH filters apply ─────────────────────────────
  await sb.from(TABLE).update({ attempts: 0, last_attempt_at: new Date().toISOString(), claimed_at: null }).eq("id", probeId);
  const inBackoff = await claimPending(50);
  check(
    "an entry inside the retry back-off is not claimed",
    !inBackoff.some((c) => c.id === probeId),
    "the two or() filters are ANDed, not replaced",
  );
  await release(inBackoff);
  await sb.from(TABLE).update({ claimed_at: null }).eq("id", probeId);

  /*
   * ── a held entry keeps its retry budget, and loses its claim ─────────────
   *
   * 🔴 RUN THROUGH A REAL CLAIM NOW, DELIBERATELY.
   *
   * This used to call `markHeld` on a row nothing had claimed, which proved
   * only that `markHeld` does not increment. That was the whole invariant when
   * `markFailed` was the only writer of `attempts`; it stopped being the whole
   * invariant the moment the CLAIM began spending one. "Does not increment"
   * and "does not spend" are now different statements, and only the second is
   * the thing the review queue depends on — a deal waiting on Katie is
   * re-claimed an hour later, and three of those would abandon it before
   * anybody could clear it. So the sequence here is the production one: claim
   * (which spends), then hold (which must refund).
   */
  await sb.from(TABLE).update({ attempts: 0, last_attempt_at: null, claimed_at: null, held_reason: null }).eq("id", probeId);
  const toHold = await claimPending(50);
  await release(toHold);
  const heldEntry = toHold.find((c) => c.id === probeId);
  await markHeld(probeId, "probe hold", { attemptsBeforeClaim: heldEntry?.attempts ?? 0 });
  const { data: afterHold } = await sb.from(TABLE).select("attempts, claimed_at").eq("id", probeId).maybeSingle();
  check(
    "holding does not spend an attempt",
    !!heldEntry && Number(afterHold?.attempts ?? -1) === 0,
    `claimed then held, attempts ${afterHold?.attempts}`,
  );
  check("holding releases the claim", afterHold?.claimed_at === null, "the claim set it moments before");

  /*
   * ── a failure spends one, and releases the claim ─────────────────────────
   *
   * Also through a real claim, for the mirror-image reason: the claim already
   * wrote `attempts + 1`, and `markFailed` writes the same number again. One
   * claim-and-fail cycle must still move the budget by exactly one — not two,
   * which is what an increment-from-the-row would now do.
   */
  await sb.from(TABLE).update({ attempts: 0, last_attempt_at: null, claimed_at: null, held_reason: null }).eq("id", probeId);
  const toFail = await claimPending(50);
  await release(toFail);
  const failedEntry = toFail.find((c) => c.id === probeId);
  await markFailed(probeId, failedEntry?.attempts ?? 0, "probe failure");
  const { data: afterFail } = await sb.from(TABLE).select("attempts, claimed_at, last_error").eq("id", probeId).maybeSingle();
  check(
    "a failure spends exactly one attempt",
    !!failedEntry && Number(afterFail?.attempts ?? -1) === 1,
    `claimed then failed, attempts ${afterFail?.attempts}`,
  );
  check("a failure releases the claim", afterFail?.claimed_at === null, "the claim set it moments before");

  // ── an entry out of retries stops being claimed ───────────────────────────
  await sb.from(TABLE).update({ attempts: MAX_ATTEMPTS, last_attempt_at: null, held_reason: null }).eq("id", probeId);
  const stalledClaim = await claimPending(50);
  check(
    "an entry out of retries is not claimed again",
    !stalledClaim.some((c) => c.id === probeId),
    "it waits for a person",
  );
  await release(stalledClaim);
  await sb.from(TABLE).update({ claimed_at: null }).eq("id", probeId);

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

  /*
   * ── `done_at` holds the instant the entry READ, not when it finished ─────
   *
   * The nightly sweep re-queues a thing only when `updated_at > done_at`. The
   * tick reads the deal and stamps the row ten to twenty seconds later —
   * Salesforce round trips plus the six-second wait for the rollups — so an
   * edit landing in that gap was written with an `updated_at` BELOW the
   * completion time and was never swept. Not by the tick, which is finished;
   * not by the sweep, which sees nothing newer. Salesforce would hold the
   * pre-edit figure for ever with both systems reporting success.
   *
   * Asserted here because this is the column the sweep reads. The sweep's own
   * decision is covered in __tests__/commercial/the-tick-stamps-when-it-read.
   */
  const readAt = new Date(Date.now() - 20_000).toISOString();
  await markDone(probeId, "probe: stamped from the read", { readAt });
  const { data: afterReadAt } = await sb.from(TABLE).select("done_at").eq("id", probeId).maybeSingle();
  check(
    "a finished entry is stamped when it read, not when it stopped writing",
    Date.parse(afterReadAt?.done_at ?? "") === Date.parse(readAt),
    `done_at ${afterReadAt?.done_at} for a read at ${readAt}`,
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
