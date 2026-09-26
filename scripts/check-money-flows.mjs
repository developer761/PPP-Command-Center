/**
 * Do Mary's money writes actually work, end to end?
 *
 *   node --env-file=.env.local --loader ./scripts/app-module-loader.mjs scripts/check-money-flows.mjs
 *
 * WHY
 *
 * `check:delivery` covers Stephanie's three tools. This covers the other half
 * of the platform's writes: raising an invoice, recording a payment against
 * it, ticking that payment off the bank, and logging a purchase — which is
 * most of Mary's day.
 *
 * These are the writes with the least forgiving arithmetic on the platform.
 * An invoice that does not recompute, a payment that overpays a balance, a
 * tick that does not stick — each of those is money wrong on a screen somebody
 * reconciles a bank statement against.
 *
 * WHAT IT ASSERTS — the rules, not just that the row appeared
 *
 *   INVOICE    a line item moves the subtotal; the balance is total − paid;
 *              status derives rather than being typed.
 *
 *   PAYMENT    a payment reduces the balance by exactly its amount, and an
 *              OVERPAYMENT is capped at the balance rather than driving it
 *              negative. Accounting's own watch-out says the cap is announced
 *              — "the bank and the platform now disagree" — so the cap itself
 *              has to be real, and reported.
 *
 *   DEPOSIT    the bank tick persists and can be untricked. A deposit that
 *              bounced has to be reversible, and a tick that silently did not
 *              save is worse than a slow one: the next person reads it as
 *              reconciled.
 *
 *   PURCHASE   a cost lands against the job and reaches the cost rollup the
 *              margin is computed from.
 *
 * SAFETY — identical to check:delivery. Its own account and opportunity under
 * a loud marker, whole-cent amounts, hard delete in dependency order, then a
 * re-query by the marker to prove nothing is left. It never touches a real
 * job: this platform has twice been left with a real deal in a wrong state by
 * a test that "just looked".
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

const MARK = "ZZ MONEY FLOW CHECK — DELETE ME";
let failures = 0;
let accountId = null;
let oppId = null;
const money = (c) => `$${(c / 100).toFixed(2)}`;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

try {
  console.log(`\nMary's money writes, against a throwaway job\n`);

  const { data: prof } = await sb.from("profiles").select("user_id").limit(1).maybeSingle();
  const ACTOR = prof?.user_id ?? null;
  check("there is a user to act as", !!ACTOR);

  const { data: acct } = await sb
    .from("commercial_accounts").insert({ company_name: MARK }).select("id").maybeSingle();
  if (!acct) throw new Error("could not create the test account");
  accountId = acct.id;

  const { data: opp } = await sb
    .from("commercial_opportunities")
    .insert({
      account_id: accountId, title: MARK, status: "in_progress",
      sub_status: "wip_on_site", accepted_contract_cents: 10_000,
    })
    .select("id").maybeSingle();
  if (!opp) throw new Error("could not create the test opportunity");
  oppId = opp.id;
  check("a test job exists to work on", !!oppId);

  // ══ 1. AN INVOICE, AND ITS ARITHMETIC ════════════════════════════════════
  const { createCommercialInvoice, addLineItem, addPayment, getCommercialInvoice } =
    await import("../lib/commercial/invoices/db.ts");

  const made = await createCommercialInvoice({
    opportunity_id: oppId, account_id: accountId, created_by_user_id: ACTOR,
    notes: MARK, due_days: 30,
  });
  check("an invoice can be raised", made.ok, made.ok ? "" : made.error);

  if (made.ok) {
    const invId = made.invoice.id;
    check("it starts as a draft", made.invoice.status === "draft", String(made.invoice.status));
    check("and starts at zero", Number(made.invoice.subtotal_cents) === 0,
      money(Number(made.invoice.subtotal_cents)));

    const li = await addLineItem(invId, {
      description: MARK, quantity: 1, unit_price_cents: 10_000,
    });
    check("a line item can be added", li?.ok !== false, li?.error ?? "");

    const withLine = await getCommercialInvoice(invId);
    check("the line moves the subtotal",
      Number(withLine?.subtotal_cents) === 10_000, money(Number(withLine?.subtotal_cents)));
    check("the balance is what is owed", Number(withLine?.balance_cents) === 10_000,
      money(Number(withLine?.balance_cents)));

    // ── A PAYMENT REDUCES THE BALANCE BY EXACTLY ITS AMOUNT ────────────────
    const pay = await addPayment(invId, {
      amount_cents: 4_000, method: "check", reference: MARK, recorded_by_user_id: ACTOR,
    });
    check("a payment can be recorded", pay.ok, pay.error ?? "");
    check("it applies in full when it fits", pay.applied_cents === 4_000,
      money(pay.applied_cents ?? 0));

    const afterPay = await getCommercialInvoice(invId);
    check("the balance drops by exactly the payment",
      Number(afterPay?.balance_cents) === 6_000, money(Number(afterPay?.balance_cents)));
    check("and what is paid is recorded",
      Number(afterPay?.paid_cents) === 4_000, money(Number(afterPay?.paid_cents)));

    /*
     * THE OVERPAYMENT CAP. Accounting's own watch-out tells Mary what happens:
     * "If you enter more than the invoice is owed, the platform caps it at the
     * balance and says so in the green line. That means the bank and the
     * platform now disagree — check the amount before moving on."
     *
     * So the cap has to be real, and it has to ANNOUNCE itself. A silent cap
     * would leave her believing the bank and the platform agree.
     */
    const over = await addPayment(invId, {
      amount_cents: 999_999, method: "check", reference: MARK, recorded_by_user_id: ACTOR,
    });
    check("an overpayment is capped at the balance", over.ok && over.applied_cents === 6_000,
      money(over.applied_cents ?? 0));
    check("and the cap is announced, not silent", over.capped === true, String(over.capped));

    const settled = await getCommercialInvoice(invId);
    check("the balance never goes negative", Number(settled?.balance_cents) === 0,
      money(Number(settled?.balance_cents)));

    // ── THE BANK TICK, AND THAT IT COMES BACK OFF ──────────────────────────
    const { setPaymentDeposited } = await import("../lib/commercial/reports/transactions.ts");
    const { data: payRow } = await sb
      .from("commercial_invoice_payments").select("id").eq("invoice_id", invId)
      .order("created_at", { ascending: true }).limit(1).maybeSingle();
    check("the payment is on the ledger", !!payRow);

    if (payRow) {
      const tick = await setPaymentDeposited(payRow.id, true);
      check("it can be ticked off against the bank", tick.ok, tick.ok ? "" : tick.error);
      const { data: onDisk } = await sb
        .from("commercial_invoice_payments").select("deposited_at").eq("id", payRow.id).maybeSingle();
      check("and the tick is on disk, not just in the reply", !!onDisk?.deposited_at,
        String(onDisk?.deposited_at));

      // A deposit that bounced has to be reversible.
      const untick = await setPaymentDeposited(payRow.id, false);
      const { data: after } = await sb
        .from("commercial_invoice_payments").select("deposited_at").eq("id", payRow.id).maybeSingle();
      check("and it comes back off again", untick.ok && !after?.deposited_at,
        String(after?.deposited_at));
    }
  }

  // ══ 2. A PURCHASE REACHES THE COST ROLLUP ════════════════════════════════
  const { addPurchase, costBreakdownForProject } = await import("../lib/commercial/purchases/db.ts");
  const p = await addPurchase({
    opportunity_id: oppId, account_id: accountId, category: "materials", vendor: MARK,
    amount_cents: 2_500, hours: null, purchased_at: "2026-09-25",
    description: MARK, reimburse_to: null, created_by_user_id: ACTOR,
  });
  check("a purchase can be logged", p.ok, p.ok ? "" : p.error);

  const costs = await costBreakdownForProject(oppId);
  check("it reaches the cost rollup the margin is built from",
    (costs?.materials ?? 0) === 2_500, money(costs?.materials ?? 0));
} catch (err) {
  failures++;
  console.log("  FAIL  threw:", err instanceof Error ? err.message : String(err));
} finally {
  // Children first. Every link is ON DELETE RESTRICT, and deleting a parent
  // while a child still points at it does NOTHING rather than erroring.
  if (oppId) {
    const invIds = ((await sb.from("commercial_invoices").select("id").eq("opportunity_id", oppId)).data ?? [])
      .map((r) => r.id);
    if (invIds.length) {
      await sb.from("commercial_invoice_payments").delete().in("invoice_id", invIds);
      await sb.from("commercial_invoice_line_items").delete().in("invoice_id", invIds);
    }
    await sb.from("commercial_invoices").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_project_purchases").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_projects").delete().eq("opportunity_id", oppId);
    await sb.from("commercial_opportunities").delete().eq("id", oppId);
  }
  if (accountId) await sb.from("commercial_accounts").delete().eq("id", accountId);

  const { data: leftOpps } = await sb.from("commercial_opportunities").select("id").eq("title", MARK);
  const { data: leftAccts } = await sb.from("commercial_accounts").select("id").eq("company_name", MARK);
  const { data: leftBuys } = await sb.from("commercial_project_purchases").select("id").eq("vendor", MARK);
  const leftover = (leftOpps ?? []).length + (leftAccts ?? []).length + (leftBuys ?? []).length;
  check("nothing is left behind", leftover === 0, leftover ? `${leftover} row(s) still there` : "");

  console.log(
    failures === 0
      ? "\n✅ invoices, payments, the bank tick and purchases all work end to end\n"
      : `\n❌ ${failures} check(s) failed\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
