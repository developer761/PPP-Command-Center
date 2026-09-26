/**
 * Do Stephanie's three delivery tools actually work, end to end?
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-delivery-flows.mjs
 *
 * WHY
 *
 * Every other check on this platform reads. `check:money` holds the money
 * surfaces against each other, `check:form-seams` proves every control posts
 * something somebody reads — but neither performs a single write. Nothing has
 * ever raised a submittal, approved a change order or issued a payment
 * application and then looked at what happened.
 *
 * Those three ARE Stephanie's job. Her handbook opens by saying so: "submittals
 * up front, change orders as the scope moves, AIA applications every month."
 *
 * WHAT IT ASSERTS — the seams, not the arithmetic
 *
 *   SUBMITTALS     the status DAG actually advances (draft → submitted →
 *                  under_review → approved), and a revision carries the
 *                  numbering forward. Her handbook warns twice that "Mark as
 *                  sent" does not email anybody; what it MUST do is move the
 *                  record, or she sends a package the platform still calls a
 *                  draft.
 *
 *   CHANGE ORDERS  an approved change order reaches the contract sum, and a
 *                  pending one does not. That is the whole point of the
 *                  approval step: until the GC says yes, the money is not
 *                  Tomco's to count.
 *
 *   AIA            the G702 arithmetic holds on real rows — line 3 is 1+2,
 *                  line 5 is the retainage percentage of line 4, line 6 is
 *                  4−5, line 8 is 6−7 — and an approved change order lands on
 *                  line 2 where the GC expects it.
 *
 * SAFETY
 *
 * Creates its own account and opportunity under a loudly-named marker, works
 * only on those, and hard-deletes everything in dependency order at the end —
 * then proves the marker returns nothing. It never touches a real job: this
 * platform has twice been left with a real deal in a wrong state by a test
 * that "just looked".
 *
 * Money is kept to whole cents on a $1.00 contract so that if cleanup ever
 * fails, what is stranded is a dollar under a name nobody can mistake for
 * work.
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

const MARK = "ZZ DELIVERY FLOW CHECK — DELETE ME";
const CONTRACT = 100; // $1.00, in cents
let failures = 0;
let accountId = null;
let oppId = null;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

try {
  console.log(`\nStephanie's three tools, against a throwaway job\n`);

  // ── A job of our own. Never a real one. ──────────────────────────────────
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

  // A REAL actor. commercial_change_orders.created_by_user_id is a foreign key
  // to auth.users, so a zero UUID is rejected — correctly, and it took a run to
  // learn. Any existing profile will do; nothing is attributed to them beyond
  // rows this script deletes.
  const { data: anyProfile } = await sb.from("profiles").select("user_id").limit(1).maybeSingle();
  const ACTOR = anyProfile?.user_id ?? null;
  check("there is a user to act as", !!ACTOR);

  // ══ 1. SUBMITTALS ════════════════════════════════════════════════════════
  const { createOpportunitySubmittal, changeSubmittalStatus, listOpportunitySubmittals } =
    await import("../lib/commercial/opportunities/submittals.ts");

  const made = await createOpportunitySubmittal({
    opportunity_id: oppId,
    to_company: MARK,
    re_subject: "flow check",
    created_by_user_id: null,
  });
  check("a submittal package can be raised", made.ok, made.ok ? "" : made.error);

  if (made.ok) {
    const sid = made.submittal.id;
    check(
      "it starts as a draft, numbered from 1",
      made.submittal.status === "draft" && made.submittal.submittal_number === 1,
      `status=${made.submittal.status} no=${made.submittal.submittal_number}`,
    );

    /*
     * A PACKAGE NEEDS SOMETHING IN IT. The tool refuses to send an empty one
     * — "Add at least one item before sending — empty submittals can't go to
     * the GC" — which is a rule worth having and one this script did not know
     * about until it tried.
     */
    const { error: itemErr } = await sb.from("commercial_opp_submittal_items").insert({
      submittal_id: sid, position: 1, copies: 1, description: MARK,
    });
    check("an item can be added to the package", !itemErr, itemErr?.message ?? "");

    // THE STEP HER HANDBOOK WARNS ABOUT. "Mark as sent to GC" does not email
    // anybody — so the one thing it owes her is moving the record.
    const sent = await changeSubmittalStatus({
      opportunity_id: oppId,
      submittal_id: sid,
      to_status: "submitted",
    });
    check("Mark as sent moves it to Submitted", sent.ok && sent.submittal.status === "submitted",
      sent.ok ? "" : sent.error);
    check("and stamps when it went", sent.ok && !!sent.submittal.sent_at,
      sent.ok ? String(sent.submittal.sent_at) : "");

    const recd = await changeSubmittalStatus({
      opportunity_id: oppId, submittal_id: sid, to_status: "under_review",
    });
    check("Mark received moves it to Under Review",
      recd.ok && recd.submittal.status === "under_review", recd.ok ? "" : recd.error);

    /*
     * "Revise & Resubmit" — one of the four answers a GC can give, and the one
     * that leads to the revision path below. Her handbook: "+ Create revision —
     * After a revise or reject — starts the next round, numbered Rev 2."
     */
    const appr = await changeSubmittalStatus({
      opportunity_id: oppId, submittal_id: sid, to_status: "revise_and_resubmit",
    });
    check("the GC's answer can be recorded",
      appr.ok && appr.submittal.status === "revise_and_resubmit", appr.ok ? "" : appr.error);

    // The DAG refuses nonsense. A decided package cannot silently reopen to
    // draft — that would restate a document the GC already holds.
    const back = await changeSubmittalStatus({
      opportunity_id: oppId, submittal_id: sid, to_status: "draft",
    });
    check("a decided package cannot be walked back to draft", !back.ok,
      back.ok ? "it was allowed" : back.error);

    const rev = await createOpportunitySubmittal({
      opportunity_id: oppId, to_company: MARK, revises_submittal_id: sid, created_by_user_id: null,
    });
    check(
      "a revision can be raised against it",
      rev.ok,
      rev.ok
        ? ""
        : /duplicate key/i.test(rev.error)
          ? `${rev.error}  ←  migration 20260925210000 is not applied yet`
          : rev.error,
    );
    if (rev.ok) {
      /*
       * A revision KEEPS the package id and increments the revision — the GC
       * holding SUB-001 gets SUB-001 Rev 2, not a new number. That is also
       * what made it impossible to save until migration 20260925210000: the
       * unique index was (opportunity_id, submittal_number) with no revision
       * in it, so every revision collided with its own parent.
       */
      check("the revision keeps the package id",
        rev.submittal.submittal_number === made.submittal.submittal_number,
        `#${rev.submittal.submittal_number} vs #${made.submittal.submittal_number}`);
      /*
       * The ORIGINAL is revision 0 and renders with no Rev label at all; the
       * first revision is 1 and renders "Rev 1". That is the construction
       * convention and it is what the screen does — her handbook said "Rev 2"
       * until this line printed the real number and I read it.
       */
      check("and increments the revision number",
        made.submittal.revision_number === 0 && rev.submittal.revision_number === 1,
        `original rev ${made.submittal.revision_number} -> revision rev ${rev.submittal.revision_number}`);
      check("the items come forward so she does not retype them",
        ((await sb.from("commercial_opp_submittal_items").select("id").eq("submittal_id", rev.submittal.id)).data ?? []).length === 1);
    }

    const listed = await listOpportunitySubmittals(oppId);
    check("both appear on the job", (listed ?? []).length === 2, `${(listed ?? []).length} listed`);

    /*
     * READ IT BACK FROM THE TABLE, not from what the function handed us.
     *
     * Every assertion above trusts the row `changeSubmittalStatus` returned.
     * That row does come from the database — the function updates and selects
     * — but it is still the writer reporting on its own work. If a later
     * trigger, rule or RLS policy quietly changed or rejected the row, the
     * returned object would not know.
     *
     * So the last word goes to a plain select, through a different client,
     * with no application code between it and the table.
     */
    const { data: onDisk } = await sb
      .from("commercial_opp_submittals")
      .select("status, sent_at, revision_number, submittal_number")
      .eq("id", sid)
      .maybeSingle();
    check("the status really persisted, read straight from the table",
      onDisk?.status === "revise_and_resubmit", `on disk: ${onDisk?.status}`);
    check("and so did the sent timestamp", !!onDisk?.sent_at, String(onDisk?.sent_at));
  }

  // ══ 2. CHANGE ORDERS ═════════════════════════════════════════════════════
  const { createChangeOrder, decideChangeOrder, netApprovedChangeOrderCents } =
    await import("../lib/commercial/change-orders/db.ts");

  const co = await createChangeOrder({
    opportunity_id: oppId,
    title: MARK,
    amount_cents: 50,
    created_by_user_id: ACTOR,
  });
  check("a change order can be raised", co.ok, co.ok ? "" : co.error);

  if (co.ok) {
    check("it starts pending, not approved", co.value.status === "pending", String(co.value.status));

    // THE POINT OF THE APPROVAL STEP. Until the GC says yes, the money is not
    // Tomco's to count — a pending CO must not reach the contract sum.
    const netBefore = await netApprovedChangeOrderCents(oppId);
    check("a PENDING change order does not move the contract sum", netBefore === 0, `net=${netBefore}`);

    const decided = await decideChangeOrder(co.value.id, "approved", ACTOR);
    check("it can be approved", decided.ok, decided.ok ? "" : decided.error);

    const netAfter = await netApprovedChangeOrderCents(oppId);
    check("an APPROVED change order does move it", netAfter === 50, `net=${netAfter}`);

    // A zero-value change order is not a change. Rejected at the door.
    const zero = await createChangeOrder({
      opportunity_id: oppId, title: MARK, amount_cents: 0,
      created_by_user_id: ACTOR,
    });
    check("a zero-amount change order is refused", !zero.ok, zero.ok ? "it was allowed" : zero.error);
  }

  // ══ 3. AIA ═══════════════════════════════════════════════════════════════
  const { createAiaApplication, upsertAiaLineItem, resolveG702, listAiaApplications } =
    await import("../lib/commercial/aia/db.ts");

  const app = await createAiaApplication({
    opportunity_id: oppId,
    original_contract_cents: CONTRACT,
    retainage_pct: 10,
    period_to: "2026-09-30",
  });
  check("a payment application can be raised", app.ok, app.ok ? "" : app.error);

  if (app.ok) {
    const appId = app.value.id;
    const line = await upsertAiaLineItem(appId, {
      description: MARK,
      scheduled_value_cents: CONTRACT,
      this_period_cents: 100,
    });
    check("a schedule-of-values line can be added", line.ok, line.ok ? "" : line.error);

    const g = await resolveG702(appId);
    check("the G702 computes", !!g);
    if (g) {
      // Each line of the certificate the GC receives, against its own rule.
      check("line 1 is the original contract", g.originalContractCents === CONTRACT,
        String(g.originalContractCents));
      check("line 2 carries the approved change order", g.netChangeOrdersCents === 50,
        String(g.netChangeOrdersCents));
      check("line 3 = line 1 + line 2 (+ tax)",
        g.contractSumToDateCents === g.originalContractCents + g.netChangeOrdersCents + g.salesTaxCents,
        `${g.contractSumToDateCents}`);
      check("line 5 is the retainage percentage of line 4",
        g.retainageCents === Math.round(g.totalCompletedStoredCents * 0.1),
        `${g.retainageCents} of ${g.totalCompletedStoredCents}`);
      check("line 6 = line 4 − line 5",
        g.totalEarnedLessRetainageCents === g.totalCompletedStoredCents - g.retainageCents,
        String(g.totalEarnedLessRetainageCents));
      check("line 8 = line 6 − line 7",
        g.currentPaymentDueCents === g.totalEarnedLessRetainageCents - g.previousCertificatesCents,
        String(g.currentPaymentDueCents));
      // Retainage is held, never billed. The single rule every money surface
      // on this platform repeats.
      check("retainage is withheld from what is due now",
        g.currentPaymentDueCents <= g.totalCompletedStoredCents,
        `${g.currentPaymentDueCents} vs ${g.totalCompletedStoredCents}`);
    }

    const apps = await listAiaApplications(oppId);
    check("it appears on the job", (apps ?? []).length === 1, `${(apps ?? []).length} listed`);
  }
} catch (err) {
  failures++;
  console.log("  FAIL  threw:", err instanceof Error ? err.message : String(err));
} finally {
  /**
   * CHILDREN FIRST. Every link here is ON DELETE RESTRICT, and deleting a
   * parent while a child still points at it does NOTHING rather than erroring
   * — PostgREST reports no rows affected. That is how a cleanup "passes" and
   * leaves a live opportunity on the book, which check-one-off-flow records
   * having done exactly once.
   */
  if (oppId) {
    await sb.from("commercial_aia_line_items").delete().in(
      "application_id",
      ((await sb.from("commercial_aia_applications").select("id").eq("opportunity_id", oppId)).data ?? [])
        .map((r) => r.id)
        .concat(["00000000-0000-0000-0000-000000000000"]),
    );
    await sb.from("commercial_aia_applications").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_change_orders").delete().eq("opportunity_id", oppId);
    const subIds = ((await sb.from("commercial_opp_submittals").select("id").eq("opportunity_id", oppId)).data ?? []).map((r) => r.id);
    if (subIds.length) await sb.from("commercial_opp_submittal_items").delete().in("submittal_id", subIds);
    await sb.from("commercial_opp_submittals").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_projects").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_opportunities").delete().eq("id", oppId);
  }
  if (accountId) await sb.from("commercial_accounts").delete().eq("id", accountId);

  // PROVE it, by the marker rather than by the ids we happen to hold.
  const { data: leftOpps } = await sb.from("commercial_opportunities").select("id").eq("title", MARK);
  const { data: leftAccts } = await sb.from("commercial_accounts").select("id").eq("company_name", MARK);
  const { data: leftCos } = await sb.from("commercial_change_orders").select("id").eq("title", MARK);
  const leftover =
    (leftOpps ?? []).length + (leftAccts ?? []).length + (leftCos ?? []).length;
  check("nothing is left behind", leftover === 0, leftover ? `${leftover} row(s) still there` : "");

  console.log(
    failures === 0
      ? "\n✅ submittals, change orders and AIA all work end to end\n"
      : `\n❌ ${failures} check(s) failed\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
