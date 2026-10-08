// End-to-end check of the pay-link system against a running server with
// PRODUCTION settings (PAYMENTS_PUBLIC=1, PAYMENTS_SF_WRITEBACK=on, org =
// production) and Stripe TEST keys. Test payments are never written to
// production Salesforce — the script proves that too. Cleans up after itself.
//
// Run (server on :3005 started with the same switches + STRIPE_WEBHOOK_SECRET,
// and `stripe listen --forward-to localhost:3005/api/stripe/webhook` running):
//   PAYMENTS_SF_WRITEBACK=on PAYMENTS_PUBLIC=1 E2E_WHSEC=whsec_… \
//     node --env-file=.env.local --import ./scripts/ts-resolve-register.mjs scripts/verify-payments-e2e.mjs
//
// Reads one real Work Order with a balance (read-only); every Stripe charge is
// test money and is refunded at the end.
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const B = "http://localhost:3005";
if (!process.env.STRIPE_SECRET_KEY.startsWith("sk_test_")) throw new Error("test key only");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const svc = await import("../lib/payments/service.ts");
const sfp = await import("../lib/salesforce/payments.ts");
const ledger = await import("../lib/payments/ledger.ts");
const { getSalesforceClient } = await import("../lib/salesforce/client.ts");

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
  ok ? pass++ : fail++;
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const $ = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const text = (html) => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ");
const ct = async (pm) => (await stripe.testHelpers.confirmationTokens.create({ payment_method: pm })).id;
const ct2 = ct;
const cardPost = async (token, path, body) => {
  const r = await fetch(`${B}/pay/${token}/card/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const pis = [];

// The booking step runs in THIS process — give it production's switches.
if (process.env.PAYMENTS_SF_WRITEBACK !== "on" || process.env.PAYMENTS_SF_ORG) throw new Error("run with PAYMENTS_SF_WRITEBACK=on and no PAYMENTS_SF_ORG");

// ── Setup: a real production Work Order with money owed (read-only) ─────────
const conn = await getSalesforceClient();
const wo = (await conn.query(
  "SELECT Id, WorkOrderNumber, BalanceOwed__c FROM WorkOrder WHERE BalanceOwed__c > 500 AND TotalPaymentsIn__c > 0 AND Total_Payment_Terms__c > 0 AND Status = 'Work In Progress' AND State IN ('NY','NJ') ORDER BY LastModifiedDate DESC LIMIT 1",
)).records[0];
const pub = await svc.issuePaymentLinkAndPublish({ id: wo.Id, number: wo.WorkOrderNumber }, "e2e-test");
const token = pub.link.token;
check("link created; Salesforce field write skipped cleanly (field not in production yet)",
  !pub.salesforce.ok && /isn't on Work Order/.test(pub.salesforce.reason), pub.salesforce.ok ? "WROTE?!" : pub.salesforce.reason);
check("link URL uses the production address", pub.url.startsWith("https://hub.precisionpaintingplus.net/pay/"), pub.url);

try {
  const st0 = await svc.loadPayState(token);
  const due0 = st0.schedule.milestones.find((m) => m.status === "due");
  const later = st0.schedule.milestones.find((m) => m.status === "upcoming");
  results.push(`      (test WO ${wo.WorkOrderNumber}: balance ${$(st0.schedule.balanceCents)}, due now ${due0.label} ${$(due0.remainingCents)})`);

  // ── A. Pay page ──────────────────────────────────────────────────────────
  const page = text(await (await fetch(`${B}/pay/${token}`)).text());
  check("pay page loads publicly (no login) with the Salesforce balance", page.includes(`Remaining balance ${$(st0.schedule.payableBalanceCents)}`), $(st0.schedule.payableBalanceCents));
  check("pay page shows the due term as Due now", page.includes(due0.label) && page.includes("Due now"));
  check("no admin preview banner on the public page", !page.includes("Admin preview"));
  check("bad link → friendly 'isn't valid' page", text(await (await fetch(`${B}/pay/AAAAAAAAAAAAAAAAAAAAAA`)).text()).includes("isn't valid"));

  // ── B. Checkout guards ───────────────────────────────────────────────────
  const post = (body) => fetch(`${B}/pay/${token}/checkout`, { method: "POST", body: new URLSearchParams(body), redirect: "manual" });
  if (later) check("paying a term that isn't due is refused", (await post({ milestone: later.key, method: "ach" })).headers.get("location")?.includes("err=not_due"));
  check("made-up payment method refused", (await post({ milestone: due0.key, method: "bitcoin" })).headers.get("location")?.includes("err=no_method"));
  check("card button goes to our card page, not hosted Checkout", (await post({ milestone: due0.key, method: "card" })).headers.get("location")?.includes(`/pay/${token}/card?m=`));

  // ── C. Bank (ACH) checkout ───────────────────────────────────────────────
  const achLoc = (await post({ milestone: due0.key, method: "ach" })).headers.get("location");
  const achRow = (await sb.from("stripe_payments").select("checkout_session_id").eq("token", token).eq("method", "ach").single()).data;
  const sess = await stripe.checkout.sessions.retrieve(achRow.checkout_session_id);
  check("bank checkout: Stripe hosted, bank-only, exact due amount, no fee",
    achLoc?.startsWith("https://checkout.stripe.com/") && sess.payment_method_types.join() === "us_bank_account" && sess.amount_total === due0.remainingCents,
    `${sess.payment_method_types} ${$(sess.amount_total)}`);
  check("bank checkout: Link wallet off, tagged with WO + covered term", sess.wallet_options?.link?.display === "never" && sess.metadata.work_order_number === wo.WorkOrderNumber && sess.metadata.covers === due0.key);
  await stripe.checkout.sessions.expire(sess.id);

  // ── D. Card: fee follows the card ────────────────────────────────────────
  const fee = Math.round(due0.remainingCents * 0.03);
  for (const [name, pm, expFee] of [["credit", "pm_card_visa", fee], ["debit", "pm_card_visa_debit", 0], ["prepaid", "pm_card_mastercard_prepaid", 0]]) {
    const q = await cardPost(token, "quote", { milestone: due0.key, confirmationToken: await ct(pm) });
    check(`card quote: ${name} → fee ${$(expFee)}`, q.body.quote?.funding === name && q.body.quote.feeCents === expFee && q.body.quote.totalCents === due0.remainingCents + expFee, q.body.quote ? `${q.body.quote.funding} ${$(q.body.quote.totalCents)}` : JSON.stringify(q.body));
  }
  const rowsBefore = (await sb.from("stripe_payments").select("id").eq("token", token)).data.length;
  const ch = await cardPost(token, "confirm", { milestone: due0.key, confirmationToken: await ct("pm_card_visa"), shownTotalCents: due0.remainingCents });
  const rowsAfter = (await sb.from("stripe_payments").select("id").eq("token", token)).data.length;
  check("credit card shown the debit price → refused, nothing charged, new total returned", ch.body.error === "amount_changed" && rowsAfter === rowsBefore && ch.body.quote?.totalCents === due0.remainingCents + fee);
  const dec = await cardPost(token, "confirm", { milestone: due0.key, confirmationToken: await ct("pm_card_chargeDeclined"), shownTotalCents: due0.remainingCents + fee });
  check("declined card → 'declined', recorded as failed", dec.body.error === "declined", dec.body.message);
  const tds = await cardPost(token, "confirm", { milestone: due0.key, confirmationToken: await ct("pm_card_threeDSecure2Required"), shownTotalCents: due0.remainingCents + fee });
  check("card needing the bank's security check → handed to the browser", tds.body.status === "requires_action" && Boolean(tds.body.clientSecret));
  check("made-up card token → 'bad card', not a server error", (await cardPost(token, "quote", { milestone: due0.key, confirmationToken: "ctoken_fake" })).body.error === "bad_card");

  // ── E. Real (test) debit payment; NOT booked until payout ────────────────
  const debitCt = await ct("pm_card_visa_debit");
  const paid = await cardPost(token, "confirm", { milestone: due0.key, confirmationToken: debitCt, shownTotalCents: due0.remainingCents });
  pis.push(paid.body.paymentIntentId);
  const pi1 = await stripe.paymentIntents.retrieve(paid.body.paymentIntentId);
  check("debit payment charged the base amount, no fee", paid.body.status === "succeeded" && pi1.amount === due0.remainingCents, $(pi1.amount));
  const again = await cardPost(token, "confirm", { milestone: due0.key, confirmationToken: debitCt, shownTotalCents: due0.remainingCents });
  check("same card submit twice → no second charge", (await stripe.paymentIntents.list({ limit: 5 })).data.filter((p) => p.metadata?.token === token && p.status === "succeeded").length === 1, again.body.error ?? again.body.status);
  let row1 = (await sb.from("stripe_payments").select("*").eq("payment_intent_id", pi1.id).single()).data;
  check("paid but NOT booked in Salesforce yet (waits for the payout)", row1.status === "succeeded" && row1.sf_writeback_status === null && /Waiting for the Stripe payout/.test(row1.sf_writeback_detail ?? ""));
  check("card type and customer recorded for the Payments tab", row1.card_funding === "debit" && Boolean(row1.customer_name));

  // ── F. Pay page after payment ────────────────────────────────────────────
  const st1 = await svc.loadPayState(token);
  const m1 = st1.schedule.milestones.find((m) => m.key === due0.key);
  check("paid term no longer payable (Processing until Salesforce has it)", m1.status === "processing" && st1.schedule.payableBalanceCents === st0.schedule.payableBalanceCents - due0.remainingCents);
  check("paying it again (new card) is refused", (await cardPost(token, "confirm", { milestone: due0.key, confirmationToken: await ct("pm_card_visa_debit"), shownTotalCents: due0.remainingCents })).body.error === "not_due");

  // ── G. Credit card for the full remaining balance ────────────────────────
  if (st1.schedule.payableBalanceCents >= 50) {
    const bal = st1.schedule.payableBalanceCents, balFee = Math.round(bal * 0.03);
    const b = await cardPost(token, "confirm", { milestone: "balance", confirmationToken: await ct("pm_card_visa"), shownTotalCents: bal + balFee });
    pis.push(b.body.paymentIntentId);
    const pi2 = await stripe.paymentIntents.retrieve(b.body.paymentIntentId);
    check("credit card, full balance: base + 3% charged", b.body.status === "succeeded" && pi2.amount === bal + balFee, `${$(bal)} + ${$(balFee)} = ${$(pi2.amount)}`);
    check("full-balance payment carries exactly the still-owed terms", pi2.metadata.covers === st1.schedule.milestones.filter((m) => m.key !== "extra" && m.remainingCents > 0).map((m) => m.key).join(","), pi2.metadata.covers);
    const st2 = await svc.loadPayState(token);
    check("nothing left to pay", st2.schedule.payableBalanceCents === 0);
  }

  // ── H. Webhooks (real ones, forwarded by the Stripe CLI) ─────────────────
  await new Promise((r) => setTimeout(r, 6000));
  const evts = (await sb.from("stripe_webhook_events").select("type,outcome").order("received_at", { ascending: false }).limit(20)).data;
  check("Stripe's payment webhooks reached us and were handled", evts.some((e) => e.type === "payment_intent.succeeded" && e.outcome?.startsWith("ok")), evts.slice(0, 4).map((e) => e.type).join(", "));

  // ── I. Payout: book in Salesforce (test → drafted, never sent) ───────────
  // Midnight UTC — exactly how Stripe stamps a payout's arrival_date (H1).
  await svc.bookClearedPayments(pis, "po_E2E", { clearedAt: "2026-10-08T00:00:00.000Z", fees: new Map(pis.map((p) => [p, { stripeFeeCents: 999 }])) });
  const booked = (await sb.from("stripe_payments").select("*").in("payment_intent_id", pis)).data;
  const t1 = booked.find((r) => r.payment_intent_id === pis[0]).sf_payload.transaction;
  check("Payment In follows finance's convention: ST1008, dated 10/8, Deposited", t1.ReferenceId__c === "ST1008" && t1.Date__c === "2026-10-08" && t1.Deposited__c === true);
  check("Payment In amount is the base only; Description starts 'Stripe pi_'", t1.Amount__c === due0.remainingCents / 100 && t1.Description__c.startsWith(`Stripe ${pis[0]}`), t1.Description__c.slice(0, 60));
  check("Payment Term marked paid in the draft", booked.find((r) => r.payment_intent_id === pis[0]).sf_payload.paymentTerms.some((u) => u.id === due0.key && u.fields.Paid_In_Full__c === true));
  check("TEST payment drafted, never sent to production Salesforce", booked.every((r) => r.sf_writeback_status === "dry_run" && /never written to production/.test(r.sf_writeback_detail)));
  const sfHits = await Promise.all(pis.map((p) => sfp.findTransactionByReference(p)));
  check("…and production Salesforce has no record of these payments", sfHits.every((h) => h === null));
  check("booking the same payout twice books nothing more", (await svc.bookClearedPayments(pis, "po_E2E")).booked === 0);

  // signed payout.paid for a REAL automatic test payout → handler lists it, books none of ours
  const s2 = new Stripe("sk_test_x");
  const payoutEvt = JSON.stringify({ id: "evt_e2e_payout_" + Date.now(), object: "event", type: "payout.paid", livemode: false, data: { object: { id: "po_1ULY3hLBQx7we8SjCJIkF6g9", object: "payout" } } });
  const whsec = process.env.E2E_WHSEC;
  const pr = await fetch(`${B}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": s2.webhooks.generateTestHeaderString({ payload: payoutEvt, secret: whsec }) }, body: payoutEvt });
  const pe = (await sb.from("stripe_webhook_events").select("outcome").eq("event_id", JSON.parse(payoutEvt).id).single()).data;
  check("payout.paid webhook: real payout read, its payments matched", pr.status === 200 && /payout: 6 payment/.test(pe?.outcome ?? ""), pe?.outcome);
  const dupe = await fetch(`${B}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": s2.webhooks.generateTestHeaderString({ payload: payoutEvt, secret: whsec }) }, body: payoutEvt });
  check("same webhook delivered twice → recognised as duplicate", (await dupe.json()).duplicate === true);
  check("forged webhook signature → rejected", (await fetch(`${B}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": s2.webhooks.generateTestHeaderString({ payload: payoutEvt, secret: "whsec_wrong" }) }, body: payoutEvt })).status === 400);

  // ── J. Refund ───────────────────────────────────────────────────────────
  await stripe.refunds.create({ payment_intent: pis[0] });
  await new Promise((r) => setTimeout(r, 7000));
  check("refund in Stripe → marked Refunded via webhook", (await sb.from("stripe_payments").select("status").eq("payment_intent_id", pis[0]).single()).data.status === "refunded");

  // ── K. Payments tab numbers (same code the page and export use) ──────────
  const all = (await sb.from("stripe_payments").select("*").eq("token", token)).data;
  const shown = ledger.filterLedger(all, { from: null, to: null, livemode: false });
  const t = ledger.totalsOf(shown);
  const paidRows = shown.filter((r) => r.status === "succeeded");
  check("Payments tab: base and fee add up separately; refund excluded",
    t.baseCents === paidRows.reduce((a, r) => a + r.base_cents, 0) && t.feeCents === paidRows.reduce((a, r) => a + r.fee_cents, 0) && t.refundedCount === 1,
    `base ${$(t.baseCents)} · fees ${$(t.feeCents)} · refunded ${t.refundedCount}`);

  // ── M. Pre-launch review fixes ───────────────────────────────────────────
  const fake = (over) => ({
    token, work_order_id: wo.Id, work_order_number: wo.WorkOrderNumber, milestone_key: "x", milestone_label: "x",
    method: "card", base_cents: 50000, fee_cents: 0, total_cents: 50000, status: "succeeded", livemode: false,
    // Explicit: a multi-row insert fills a column one row omits with NULL, not its default.
    sf_org: "production", ...over,
  });
  {
    // H2: a LIVE payment row and a SANDBOX row on this Work Order must not count here (test-mode, production server).
    const before = (await svc.loadPayState(token)).schedule.inFlightCents;
    const ins = await sb.from("stripe_payments").insert([
      fake({ payment_intent_id: "pi_E2E_LIVE_" + Date.now(), livemode: true }),
      fake({ payment_intent_id: "pi_E2E_SBX_" + Date.now(), sf_org: "sandbox" }),
    ]).select("id");
    if (ins.error) throw new Error("fake rows insert failed: " + ins.error.message);
    const after = (await svc.loadPayState(token)).schedule.inFlightCents;
    await sb.from("stripe_payments").delete().in("id", ins.data.map((r) => r.id));
    check("H2: real-money and sandbox payments don't count against this balance", after === before, `${$(before)} → ${$(after)}`);
  }
  {
    // H2: a sandbox link for the same Work Order is a different link, and doesn't open here.
    const sbxTok = "E2Esandbox" + Date.now();
    await sb.from("payment_links").insert({ token: sbxTok, work_order_id: wo.Id, work_order_number: wo.WorkOrderNumber, created_by: "e2e-test", sf_org: "sandbox" });
    const reissued = await svc.issuePaymentLink({ id: wo.Id, number: wo.WorkOrderNumber }, "e2e-test");
    const opened = await svc.loadPayState(sbxTok);
    await sb.from("payment_links").delete().eq("token", sbxTok);
    check("H2: sandbox and production links for one Work Order stay separate", reissued.token === token && opened.kind === "not_found");
  }
  {
    // H3: success event arrives AFTER the payout → booked on arrival, with the payout's date.
    const st = await svc.loadPayState(token);
    const dueNow = st.schedule.milestones.find((m) => m.status === "due");
    if (dueNow) {
      const c = await ct("pm_card_visa_debit");
      const r = await cardPost(token, "confirm", { milestone: dueNow.key, confirmationToken: c, shownTotalCents: dueNow.remainingCents });
      pis.push(r.body.paymentIntentId);
      // Let Stripe's real payment_intent.succeeded webhook land first, so the
      // reset below is the LAST word and the late-success path is what's tested.
      await new Promise((res) => setTimeout(res, 8000));
      await sb.from("stripe_payments").update({ status: "processing", sf_writeback_status: null }).eq("payment_intent_id", r.body.paymentIntentId);
      const res = await svc.bookClearedPayments([r.body.paymentIntentId], "po_E2E_LATE", { clearedAt: "2026-10-09T00:00:00.000Z", fees: new Map() });
      const mid = (await sb.from("stripe_payments").select("sf_writeback_status,payout_id").eq("payment_intent_id", r.body.paymentIntentId).single()).data;
      await svc.syncPaymentIntent(await stripe.paymentIntents.retrieve(r.body.paymentIntentId));
      // Stripe's real webhook for this payment can reach the server meanwhile
      // and take the booking itself (the claim lets exactly one through) —
      // wait for whichever did to finish, then check the result.
      let end;
      for (let i = 0; i < 30; i++) {
        end = (await sb.from("stripe_payments").select("*").eq("payment_intent_id", r.body.paymentIntentId).single()).data;
        if (end.sf_writeback_status && end.sf_writeback_status !== "booking") break;
        await new Promise((res) => setTimeout(res, 1000));
      }
      check("H3: payout first, success later → booked when it succeeds, dated by the payout",
        res.booked === 0 && mid.payout_id === "po_E2E_LATE" && end.sf_writeback_status === "dry_run" && end.sf_payload?.transaction?.ReferenceId__c === "ST1009",
        `${end.sf_writeback_status} ${end.sf_payload?.transaction?.ReferenceId__c}`);
    } else {
      results.push("      (H3 skipped — nothing left due on this Work Order)");
    }
  }
  {
    // H4: the same payout booked by two processes at once → booked exactly once.
    const target = pis[pis.length - 1];
    await sb.from("stripe_payments").update({ sf_writeback_status: null, sf_payload: null }).eq("payment_intent_id", target);
    const [a, b] = await Promise.all([svc.bookClearedPayments([target], "po_E2E_RACE"), svc.bookClearedPayments([target], "po_E2E_RACE")]);
    check("H4: two simultaneous bookings of one payment → exactly one", a.booked + b.booked === 1, `${a.booked} + ${b.booked}`);
  }
  {
    // M3: a bank checkout left open, then the customer pays by card → the bank checkout is closed first.
    const st = await svc.loadPayState(token);
    const dueNow = st.schedule.milestones.find((m) => m.status === "due");
    if (dueNow) {
      await post({ milestone: dueNow.key, method: "ach" });
      const ach = (await sb.from("stripe_payments").select("checkout_session_id").eq("token", token).eq("method", "ach").eq("status", "open").single()).data;
      const r = await cardPost(token, "confirm", { milestone: dueNow.key, confirmationToken: await ct("pm_card_visa_debit"), shownTotalCents: dueNow.remainingCents });
      if (r.body.paymentIntentId) pis.push(r.body.paymentIntentId);
      const sess = await stripe.checkout.sessions.retrieve(ach.checkout_session_id);
      check("M3: open bank checkout closed before the card is charged (no double payment)", sess.status === "expired" && r.body.status === "succeeded", `bank ${sess.status}, card ${r.body.status}`);
    } else {
      results.push("      (M3 skipped — nothing left due on this Work Order)");
    }
  }
  {
    // M4: five declined cards on one link in an hour → card payments lock for that link.
    await sb.from("stripe_payments").insert(Array.from({ length: 5 }, (_, i) => fake({ payment_intent_id: `pi_E2E_DECL_${Date.now()}_${i}`, status: "failed" })));
    const q = await cardPost(token, "quote", { milestone: "balance", confirmationToken: await ct("pm_card_visa") });
    check("M4: 5 declined cards in an hour → card payments locked on this link", q.body.error === "too_many", JSON.stringify(q.body));
    await sb.from("stripe_payments").delete().like("payment_intent_id", "pi_E2E_DECL_%");
  }

  // ── N. State rules (Katie, 2026-10-08) ───────────────────────────────────
  {
    const ct = (await conn.query("SELECT Id, WorkOrderNumber, State FROM WorkOrder WHERE State = 'CT' AND BalanceOwed__c > 100 AND Total_Payment_Terms__c > 0 AND Status NOT IN ('Closed','Canceled','Complete Paid in Full') LIMIT 1")).records[0];
    if (ct) {
      const l = await svc.issuePaymentLinkAndPublish({ id: ct.Id, number: ct.WorkOrderNumber, state: ct.State }, "e2e-test");
      try {
        const due = (await svc.loadPayState(l.link.token)).schedule.milestones.find((m) => m.status === "due");
        const q = await cardPost(l.link.token, "quote", { milestone: due.key, confirmationToken: await ct2("pm_card_visa") });
        const pg = text(await (await fetch(`${B}/pay/${l.link.token}`)).text());
        check("Connecticut job: credit card pays NO fee, and the page says so", q.body.quote?.funding === "credit" && q.body.quote.feeCents === 0 && pg.includes("Pay by card · no fee") && !pg.includes("3.00%"), `fee ${$(q.body.quote?.feeCents ?? -1)}`);
      } finally {
        await sb.from("payment_links").delete().eq("token", l.link.token);
      }
    } else results.push("      (CT check skipped — no open Connecticut job with a balance)");
    const co = (await conn.query("SELECT Id, WorkOrderNumber, State FROM WorkOrder WHERE State = 'CO' AND BalanceOwed__c > 0 LIMIT 1")).records[0];
    if (co) {
      let refused = "";
      try { await svc.issuePaymentLinkAndPublish({ id: co.Id, number: co.WorkOrderNumber, state: co.State }, "e2e-test"); } catch (e) { refused = e.message; }
      check("Colorado job: no link on this Stripe account", /own Stripe accounts/.test(refused), refused.slice(0, 60));
      const coTok = "E2Eco" + Date.now();
      await sb.from("payment_links").insert({ token: coTok, work_order_id: co.Id, work_order_number: co.WorkOrderNumber, created_by: "e2e-test", sf_org: "production" });
      const coPage = text(await (await fetch(`${B}/pay/${coTok}`)).text());
      await sb.from("payment_links").delete().eq("token", coTok);
      check("…and an old Colorado link shows 'closed', no Pay buttons", coPage.includes("Online payment is closed") && !coPage.includes("Pay by bank"));
    }
  }

  // ── L. Locked-down endpoints ─────────────────────────────────────────────
  check("Payments tab requires login", [307, 302].includes((await fetch(`${B}/dashboard/payments`, { redirect: "manual" })).status));
  check("Excel export requires admin", (await fetch(`${B}/api/payments/export`)).status === 403);
  check("link cron requires its secret", (await fetch(`${B}/api/cron/payment-links`)).status === 401);
  const cron = await (await fetch(`${B}/api/cron/payment-links`, { headers: { authorization: "Bearer local-cron-test" } })).json();
  check("link cron does nothing until PAYMENTS_AUTO_LINKS=on", cron.skipped === "PAYMENTS_AUTO_LINKS is not on", JSON.stringify(cron));
} finally {
  // ── Cleanup ──────────────────────────────────────────────────────────────
  for (const p of pis) await stripe.refunds.create({ payment_intent: p }).catch(() => {});
  await sb.from("stripe_payments").delete().eq("token", token);
  await sb.from("payment_links").delete().eq("token", token);
  await sb.from("stripe_webhook_events").delete().eq("livemode", false);
}
console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
