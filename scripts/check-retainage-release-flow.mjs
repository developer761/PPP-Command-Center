/**
 * Can a job bill a change order AFTER its retainage was released — repeatedly?
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-retainage-release-flow.mjs
 *
 * WHY
 *
 * Stephanie, 2026-10-16, on the LMJ Cipla expansion — the job she calls a
 * billing nightmare:
 *
 *   "We billed the contract in full and then billed for retainage and then
 *    received payment on the job in full. After we received that payment, a
 *    change order came across and we had to bill for that plus retainage. This
 *    happened 2x, meaning there was a total of 3 retainage AIA's. I am trying
 *    to record it in Command and it is pulling details from the paid retainage
 *    AIA and giving me negative numbers... this is kind of something that
 *    happens often and we have to be able to record in real time."
 *
 * Two separate defects, and unit tests can only see one of them. The ARITHMETIC
 * (retainage was re-withheld on released work, so line 8 came out NEGATIVE) is
 * pure and pinned in __tests__/commercial/aia/retainage-is-withheld-once.ts.
 * The SEQUENCE is not: it needs real rows, a real status ladder, and a database
 * that until migration 20261016120000 carried a unique index allowing one
 * release per job. A green unit suite says nothing about whether she can
 * actually do this twice.
 *
 * So this walks her job, in order, through the same functions the screen calls:
 *
 *   App 1  ordinary, 5%     bill the contract in full          submit → paid
 *   App 2  RELEASE          line 8 = the retainage held        submit → paid
 *          another release now → REFUSED, nothing is held
 *   CO     approved, +$10
 *   App 3  ordinary, 5%     bill the CO — retainage is 5% OF THE CO,
 *                           not of the whole contract again    submit → paid
 *   App 4  RELEASE          ALLOWED. This is the one migration 162 forbade.
 *          another release while App 4 is draft → REFUSED
 *
 * SAFETY
 *
 * Creates its own account and opportunity under a loudly-named marker, works
 * only on those, hard-deletes in dependency order, and then proves the marker
 * returns nothing. It never touches a real job: this platform has twice been
 * left with a real deal in a wrong state by a check that "just looked".
 *
 * Amounts are kept to $20 and $1 so that if cleanup ever fails, what is
 * stranded is pocket change under a name nobody can mistake for work.
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    })
);
for (const [k, v] of Object.entries(env)) process.env[k] ??= v;

const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const MARK = "ZZ RETAINAGE RELEASE FLOW CHECK — DELETE ME";
const CONTRACT = 20_00;
/*
 * $1.00 on a $20.00 contract, which is Stephanie's "$1000 CO, 5% ret, $950 due
 * and $50 ret, $50 balance to finish" scaled by a thousand. The RATIO is the
 * point, not the size: with the old rule the re-withheld retainage ($1.05, 5%
 * of the whole $21.00) EXCEEDS the change order being billed, so line 8 goes
 * negative — the exact shape her job took. A larger change order would still
 * compute the wrong retainage but would not flip the sign, and the sign is
 * what she reported.
 */
const CO = 1_00;
const PCT = 5;

let failures = 0;
let accountId = null;
let oppId = null;
const usd = (c) => `$${(Number(c) / 100).toFixed(2)}`;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

try {
  console.log("\nStephanie's Cipla sequence, against a throwaway job\n");

  const { data: acct, error: acctErr } = await sb
    .from("commercial_accounts")
    .insert({ company_name: MARK })
    .select("id")
    .maybeSingle();
  if (acctErr || !acct) throw new Error(`could not create the test account: ${acctErr?.message}`);
  accountId = acct.id;

  const { data: opp, error: oppErr } = await sb
    .from("commercial_opportunities")
    .insert({
      account_id: accountId,
      title: MARK,
      status: "in_progress",
      sub_status: "wip_on_site",
      accepted_contract_cents: CONTRACT,
    })
    .select("id")
    .maybeSingle();
  if (oppErr || !opp) throw new Error(`could not create the test opportunity: ${oppErr?.message}`);
  oppId = opp.id;
  check("a test job exists to work on", !!oppId);

  // A REAL actor: created_by_user_id is a foreign key to auth.users.
  const { data: anyProfile } = await sb.from("profiles").select("user_id").limit(1).maybeSingle();
  const ACTOR = anyProfile?.user_id ?? null;
  check("there is a user to act as", !!ACTOR);

  const {
    createAiaApplication,
    upsertAiaLineItem,
    updateAiaApplication,
    resolveG702,
    listAiaLineItemsWithRelease,
    retainageHeldForOpportunity,
  } = await import("../lib/commercial/aia/db.ts");
  const { lineRetainageCents } = await import("../lib/commercial/aia/constants.ts");
  const { createChangeOrder, decideChangeOrder } = await import(
    "../lib/commercial/change-orders/db.ts"
  );

  /** Walk an application to paid, the way the screen does. */
  const issue = async (id) => {
    const a = await updateAiaApplication(id, { status: "submitted" }, ACTOR);
    if (!a.ok) return a;
    return updateAiaApplication(id, { status: "paid" }, ACTOR);
  };

  // ══ App 1 — bill the contract in full, 5% held ═══════════════════════════
  const a1 = await createAiaApplication({
    opportunity_id: oppId,
    original_contract_cents: CONTRACT,
    retainage_pct: PCT,
    period_to: "2026-07-31",
    created_by_user_id: ACTOR,
  });
  check("App 1 can be raised", a1.ok, a1.ok ? "" : a1.error);
  if (!a1.ok) throw new Error("cannot continue without App 1");

  // The seed may have filled the sheet from a proposal; this job has none.
  const l1 = await upsertAiaLineItem(a1.value.id, {
    description: `${MARK} base`,
    item_no: "1",
    scheduled_value_cents: CONTRACT,
    this_period_cents: CONTRACT,
  });
  check("the contract line can be billed in full", l1.ok, l1.ok ? "" : l1.error);

  const g1 = await resolveG702(a1.value.id);
  check(
    "App 1 holds 5% of the contract",
    g1.retainageCents === 1_00 && g1.currentPaymentDueCents === 19_00,
    `line 5 ${usd(g1.retainageCents)} · line 8 ${usd(g1.currentPaymentDueCents)}`,
  );
  const i1 = await issue(a1.value.id);
  check("App 1 reaches paid", i1.ok, i1.ok ? "" : i1.error);

  // ══ App 2 — the release ══════════════════════════════════════════════════
  check(
    "the job now reports retainage held",
    (await retainageHeldForOpportunity(oppId)) === 1_00,
    usd(await retainageHeldForOpportunity(oppId)),
  );

  const a2 = await createAiaApplication({
    opportunity_id: oppId,
    is_retainage_release: true,
    period_to: "2026-08-31",
    created_by_user_id: ACTOR,
  });
  check("the FIRST retainage release can be raised", a2.ok, a2.ok ? "" : a2.error);
  if (!a2.ok) throw new Error("cannot continue without the first release");

  const g2 = await resolveG702(a2.value.id);
  check(
    "it certifies exactly the retainage held, and nothing is left to finish",
    g2.retainageCents === 0 && g2.currentPaymentDueCents === 1_00 && g2.balanceToFinishCents === 0,
    `line 5 ${usd(g2.retainageCents)} · line 8 ${usd(g2.currentPaymentDueCents)} · line 9 ${usd(g2.balanceToFinishCents)}`,
  );

  // One release in draft at a time — the backstop that replaced the old index.
  const dup = await createAiaApplication({
    opportunity_id: oppId,
    is_retainage_release: true,
    created_by_user_id: ACTOR,
  });
  check(
    "a SECOND release while one is still in draft is refused",
    !dup.ok && /already a retainage release in draft/i.test(dup.error ?? ""),
    dup.ok ? "it was allowed" : dup.error,
  );

  const i2 = await issue(a2.value.id);
  check("the release reaches paid", i2.ok, i2.ok ? "" : i2.error);

  const none = await createAiaApplication({
    opportunity_id: oppId,
    is_retainage_release: true,
    created_by_user_id: ACTOR,
  });
  check(
    "a release with NOTHING held is refused, in words",
    !none.ok && /no retainage held/i.test(none.error ?? ""),
    none.ok ? "it was allowed" : none.error,
  );

  // ══ The change order that arrives after the job was paid in full ═════════
  const co = await createChangeOrder({
    opportunity_id: oppId,
    title: MARK,
    amount_cents: CO,
    created_by_user_id: ACTOR,
  });
  check("a change order can be raised", co.ok, co.ok ? "" : co.error);
  if (co.ok) {
    const decided = await decideChangeOrder(co.value.id, "approved", ACTOR);
    check("it can be approved", decided.ok, decided.ok ? "" : decided.error);
  }

  // ══ App 3 — bill the change order ════════════════════════════════════════
  const a3 = await createAiaApplication({
    opportunity_id: oppId,
    retainage_pct: PCT,
    period_to: "2026-09-30",
    created_by_user_id: ACTOR,
  });
  check("App 3 can be raised after a release", a3.ok, a3.ok ? "" : a3.error);
  if (!a3.ok) throw new Error("cannot continue without App 3");

  // The seed carries the sheet forward and appends the new change-order row.
  const a3lines = await listAiaLineItemsWithRelease(a3.value);
  const coRow = a3lines.find((l) => l.change_order_id === (co.ok ? co.value.id : null));
  check("the change order joined the schedule of values", !!coRow, `${a3lines.length} line(s)`);
  if (coRow) {
    const billed = await upsertAiaLineItem(a3.value.id, { id: coRow.id, this_period_cents: CO });
    check("the change order can be billed in full", billed.ok, billed.ok ? "" : billed.error);
  }

  const g3 = await resolveG702(a3.value.id);
  /*
   * THE DEFECT, IN ONE ASSERTION. Before 2026-10-16 line 5 here was 5% of
   * $30.00 — the whole contract withheld a second time — so line 6 fell below
   * the previous certificate and line 8 came out at minus $1.00. On her real
   * job the same shape read MINUS $3,431.36.
   */
  check(
    "retainage is 5% OF THE CHANGE ORDER, not of the whole contract again",
    g3.retainageCents === 5,
    `line 5 ${usd(g3.retainageCents)} on line 4 ${usd(g3.totalCompletedStoredCents)}`,
  );
  check(
    "the certificate does not ask the GC for a NEGATIVE payment",
    g3.currentPaymentDueCents >= 0,
    `line 8 ${usd(g3.currentPaymentDueCents)}`,
  );
  check(
    "it asks for the change order less its own retainage, and that is all that is left",
    g3.currentPaymentDueCents === 95 && g3.balanceToFinishCents === 5,
    `line 8 ${usd(g3.currentPaymentDueCents)} · line 9 ${usd(g3.balanceToFinishCents)}`,
  );

  // The cover sheet and the continuation sheet have to foot.
  const g3lines = await listAiaLineItemsWithRelease(a3.value);
  const perLine = g3lines.reduce((n, l) => n + lineRetainageCents(l, PCT), 0);
  check(
    "the G703 retainage column totals G702 line 5",
    perLine === g3.retainageCents,
    `${usd(perLine)} vs ${usd(g3.retainageCents)} across ${g3lines.length} line(s)`,
  );

  const i3 = await issue(a3.value.id);
  check("App 3 reaches paid", i3.ok, i3.ok ? "" : i3.error);

  // ══ App 4 — the SECOND release. The one migration 162 forbade. ═══════════
  const a4 = await createAiaApplication({
    opportunity_id: oppId,
    is_retainage_release: true,
    period_to: "2026-10-31",
    created_by_user_id: ACTOR,
  });
  check(
    "a SECOND retainage release can be raised on the same job",
    a4.ok,
    a4.ok ? "" : a4.error,
  );

  if (a4.ok) {
    const g4 = await resolveG702(a4.value.id);
    check(
      "it certifies the change order's retainage, and only that",
      g4.retainageCents === 0 && g4.currentPaymentDueCents === 5 && g4.balanceToFinishCents === 0,
      `line 5 ${usd(g4.retainageCents)} · line 8 ${usd(g4.currentPaymentDueCents)} · line 9 ${usd(g4.balanceToFinishCents)}`,
    );
    const i4 = await issue(a4.value.id);
    check("the second release reaches paid", i4.ok, i4.ok ? "" : i4.error);
    check(
      "the job ends with nothing held",
      (await retainageHeldForOpportunity(oppId)) === 0,
      usd(await retainageHeldForOpportunity(oppId)),
    );
  }
} catch (err) {
  failures++;
  console.log("  FAIL  threw:", err instanceof Error ? err.message : String(err));
} finally {
  /**
   * CHILDREN FIRST. Every link here is ON DELETE RESTRICT, and deleting a
   * parent while a child still points at it does NOTHING rather than erroring
   * — PostgREST reports no rows affected. That is how a cleanup "passes" and
   * leaves a live opportunity on the book.
   */
  if (oppId) {
    const appIds = (
      (await sb.from("commercial_aia_applications").select("id").eq("opportunity_id", oppId)).data ?? []
    )
      .map((r) => r.id)
      .concat(["00000000-0000-0000-0000-000000000000"]);
    await sb.from("commercial_aia_line_items").delete().in("application_id", appIds);
    await sb.from("commercial_aia_applications").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_change_orders").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_projects").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_opportunities").delete().eq("id", oppId);
  }
  if (accountId) await sb.from("commercial_accounts").delete().eq("id", accountId);

  // PROVE it, by the MARKER rather than by the ids we happen to hold.
  const { data: leftOpps } = await sb.from("commercial_opportunities").select("id").eq("title", MARK);
  const { data: leftAccts } = await sb.from("commercial_accounts").select("id").eq("company_name", MARK);
  const { data: leftCos } = await sb.from("commercial_change_orders").select("id").eq("title", MARK);
  const leftover = (leftOpps ?? []).length + (leftAccts ?? []).length + (leftCos ?? []).length;
  check("nothing is left behind", leftover === 0, leftover ? `${leftover} row(s) still there` : "");
}

console.log(
  failures === 0
    ? "\n✅ A job can bill, hold, release, bill again and release again.\n"
    : `\n❌ ${failures} step(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
