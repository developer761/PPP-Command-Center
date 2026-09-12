/**
 * The reply delay, against the real database.
 *
 * The unit tests prove the arithmetic. They cannot prove that the constraint
 * accepts what the settings form writes, that an inverted range is actually
 * refused rather than quietly stored, or that the default really is off for
 * every workspace already live — which is the thing that decides whether
 * shipping this changes anybody's behaviour today.
 *
 * Cleanup in a finally block.
 */
import { createClient } from "@supabase/supabase-js";
import { delayedRunAt, pickDelaySeconds, validateDelay } from "../lib/messaging/reply-delay.ts";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓  ${label}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗  ${label}${extra ? "  " + extra : ""}`); }
};

let original = null;
let wsId = null;

try {
  const { data: ws } = await sb.from("sms_sub_accounts")
    .select("id, name, time_zone, quiet_hours_start, quiet_hours_end, reply_delay_min_seconds, reply_delay_max_seconds")
    .eq("is_active", true).limit(1).single();
  wsId = ws.id;
  original = { min: ws.reply_delay_min_seconds, max: ws.reply_delay_max_seconds };

  console.log(`\nREPLY DELAY — real schema  (via ${ws.name})\n`);

  /* ── Off everywhere, so shipping changes nothing today ────────── */
  const { data: all } = await sb.from("sms_sub_accounts")
    .select("name, reply_delay_min_seconds, reply_delay_max_seconds");
  const on = all.filter((r) => (r.reply_delay_max_seconds ?? 0) > 0);
  ok("every workspace defaults to off — nothing changes until somebody sets it",
     on.length === 0, on.length ? `on for: ${on.map((r) => r.name).join(", ")}` : "");

  /* ── The constraint takes what the form writes ────────────────── */
  const { error: goodErr } = await sb.from("sms_sub_accounts")
    .update({ reply_delay_min_seconds: 120, reply_delay_max_seconds: 300 }).eq("id", wsId);
  ok("a 2-5 minute range is accepted", !goodErr, goodErr?.message ?? "");

  const { data: back } = await sb.from("sms_sub_accounts")
    .select("reply_delay_min_seconds, reply_delay_max_seconds").eq("id", wsId).single();
  ok("it stores what was written",
     back.reply_delay_min_seconds === 120 && back.reply_delay_max_seconds === 300);

  /* ── The things the code refuses, the database refuses too ────── */
  const inverted = await sb.from("sms_sub_accounts")
    .update({ reply_delay_min_seconds: 300, reply_delay_max_seconds: 120 }).eq("id", wsId);
  ok("an inverted range is refused, not silently stored", inverted.error !== null);
  ok("and the code refuses it with words first", validateDelay(300, 120) !== null);

  const tooLong = await sb.from("sms_sub_accounts")
    .update({ reply_delay_min_seconds: 0, reply_delay_max_seconds: 3600 }).eq("id", wsId);
  ok("an hour is refused by the constraint", tooLong.error !== null);
  ok("and by the code, before it gets there", validateDelay(0, 3600) !== null);

  const negative = await sb.from("sms_sub_accounts")
    .update({ reply_delay_min_seconds: -60, reply_delay_max_seconds: 300 }).eq("id", wsId);
  ok("a negative delay is refused", negative.error !== null);

  /* ── The refused writes did not damage the row ────────────────── */
  const { data: intact } = await sb.from("sms_sub_accounts")
    .select("reply_delay_min_seconds, reply_delay_max_seconds").eq("id", wsId).single();
  ok("a refused write left the previous range intact",
     intact.reply_delay_min_seconds === 120 && intact.reply_delay_max_seconds === 300);

  /* ── The scheduling actually moves, using this workspace's clock ─ */
  const cfg = { minSeconds: 120, maxSeconds: 300 };
  const hours = { startHour: ws.quiet_hours_start, endHour: ws.quiet_hours_end };
  // Midday in the workspace's own timezone, whatever that is.
  const noon = new Date();
  noon.setUTCHours(16, 0, 0, 0);
  const run = delayedRunAt({ now: noon, config: cfg, timeZone: ws.time_zone, quietHours: hours });
  const waited = (run.getTime() - noon.getTime()) / 1000;
  ok("a turn is scheduled into the future, inside the range",
     waited >= 120 && waited <= 300, `waited ${waited}s`);

  const draws = new Set();
  for (let i = 0; i < 100; i++) draws.add(pickDelaySeconds(cfg));
  ok("consecutive replies do not share one identical gap", draws.size > 5,
     `${draws.size} distinct`);

} finally {
  if (wsId && original) {
    await sb.from("sms_sub_accounts")
      .update({
        reply_delay_min_seconds: original.min ?? 0,
        reply_delay_max_seconds: original.max ?? 0,
      }).eq("id", wsId);
  }
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
