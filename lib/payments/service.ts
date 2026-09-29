import "server-only";

import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { createClient as createSupabaseAdminClient, type SupabaseClient } from "@supabase/supabase-js";
import { etTodayIso } from "@/lib/date-et";
import { readPaymentsConfig, shouldWriteToSalesforce } from "@/lib/payments/config";
import {
  buildPaymentSchedule,
  formatCents,
  normalizeFunding,
  quoteCardCharge,
  quoteCharge,
  type CardFunding,
  type PaymentSchedule,
} from "@/lib/payments/schedule";
import { buildSfTransaction } from "@/lib/payments/sf-transaction";
import {
  CARD_ELEMENT_FLOW,
  isForwardMove,
  PPP_PAY_SOURCE,
  statusFromPaymentIntent,
  statusFromSession,
  type OurStatus,
} from "@/lib/payments/session-status";
import {
  createSalesforceTransaction,
  getPaymentInRecordTypeId,
  getWorkOrderPaymentStateById,
  isClosedForPayment,
  type WorkOrderPaymentState,
} from "@/lib/salesforce/payments";

/**
 * Online invoice payments — the server side of /pay/<token>.
 *
 * Flow: the invoice links to /pay/<token> → the page reads the Work Order live
 * from Salesforce and shows each milestone → a button POSTs to the checkout
 * route → createCheckout() re-reads Salesforce, recomputes the amount (it never
 * trusts a number from the browser) and opens a Stripe Checkout Session with
 * the method locked → Stripe tells us what happened, via the webhook AND via
 * the thank-you page, both of which call syncCheckoutSession(), which is
 * idempotent → on success the Salesforce Transaction__c is written, or stored
 * as a dry run (see lib/payments/config.ts).
 */

export type PaymentRow = {
  id: string;
  /** Bank payments (hosted Checkout). Null for card payments made on our page. */
  checkout_session_id: string | null;
  token: string;
  work_order_id: string;
  work_order_number: string;
  milestone_key: string;
  milestone_label: string;
  method: "card" | "ach";
  base_cents: number;
  fee_cents: number;
  total_cents: number;
  status: OurStatus | "refunded";
  livemode: boolean;
  payment_intent_id: string | null;
  checkout_url: string | null;
  customer_email: string | null;
  sf_writeback_status: "dry_run" | "written" | "failed" | null;
  sf_transaction_id: string | null;
  sf_payload: Record<string, unknown> | null;
  sf_writeback_detail: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  /** credit / debit / prepaid / unknown — card payments only. */
  card_funding: string | null;
};

export type PaymentLinkRow = {
  token: string;
  work_order_id: string;
  work_order_number: string;
  created_by: string | null;
  created_at: string;
  revoked_at: string | null;
};

let _sb: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (_sb) return _sb;
  _sb = createSupabaseAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _sb;
}

export function paymentsConfig() {
  return readPaymentsConfig(process.env);
}

let _stripe: Stripe | null = null;
export function getStripe(): Stripe {
  const cfg = paymentsConfig();
  if (cfg.stripeBlockedReason) throw new Error(cfg.stripeBlockedReason);
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!.trim());
  return _stripe;
}

/** Signature checking only — needs no API access, so it works (and the
 *  webhook still acknowledges events) even while the key is blocked above. */
let _verifier: Stripe | null = null;
export function stripeWebhookVerifier(): Stripe["webhooks"] {
  if (!_verifier) _verifier = new Stripe(process.env.STRIPE_SECRET_KEY?.trim() || "sk_test_signature_only");
  return _verifier.webhooks;
}

// ─── Links ──────────────────────────────────────────────────────────────────

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

export async function getPaymentLink(token: string): Promise<PaymentLinkRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const { data, error } = await db().from("payment_links").select("*").eq("token", token).maybeSingle();
  if (error) throw new Error(`payment_links read failed: ${error.message}`);
  return (data as PaymentLinkRow | null) ?? null;
}

/** The live link for a Work Order, creating one if there is none. Re-issuing
 *  returns the same token so a link already printed on an invoice keeps working. */
export async function issuePaymentLink(wo: { id: string; number: string }, createdBy: string | null): Promise<PaymentLinkRow> {
  const existing = await db()
    .from("payment_links")
    .select("*")
    .eq("work_order_id", wo.id)
    .is("revoked_at", null)
    .maybeSingle();
  if (existing.error) throw new Error(`payment_links read failed: ${existing.error.message}`);
  if (existing.data) return existing.data as PaymentLinkRow;

  // 16 random bytes → 22 url-safe chars. Unguessable, and not the WO number.
  const token = randomBytes(16).toString("base64url");
  const { data, error } = await db()
    .from("payment_links")
    .insert({ token, work_order_id: wo.id, work_order_number: wo.number, created_by: createdBy })
    .select("*")
    .single();
  if (error) {
    // Two admins issuing at once: the partial unique index lets one win; hand
    // back the winner rather than an error.
    if (error.code === "23505") return issuePaymentLink(wo, createdBy);
    throw new Error(`payment_links insert failed: ${error.message}`);
  }
  return data as PaymentLinkRow;
}

export async function revokePaymentLink(token: string): Promise<void> {
  const { error } = await db()
    .from("payment_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token", token)
    .is("revoked_at", null);
  if (error) throw new Error(`payment_links revoke failed: ${error.message}`);
}

// ─── What is owed ───────────────────────────────────────────────────────────

/**
 * Money we know about that Salesforce's BalanceOwed__c does not yet reflect:
 *   - ACH payments still clearing ('processing')
 *   - succeeded payments not written to Salesforce (every TEST payment, and a
 *     live one whose write failed) — otherwise the page would offer the same
 *     milestone again the moment the customer came back.
 * Once a row is 'written', Salesforce's own balance carries it.
 */
async function inFlightCents(workOrderId: string): Promise<number> {
  const { data, error } = await db()
    .from("stripe_payments")
    .select("base_cents, status, sf_writeback_status")
    .eq("work_order_id", workOrderId)
    .in("status", ["processing", "succeeded"]);
  if (error) throw new Error(`stripe_payments read failed: ${error.message}`);
  return (data ?? [])
    .filter((r) => r.status === "processing" || r.sf_writeback_status !== "written")
    .reduce((s, r) => s + (r.base_cents as number), 0);
}

export type PayState =
  | { kind: "not_found" }
  | { kind: "revoked"; link: PaymentLinkRow }
  | { kind: "closed"; link: PaymentLinkRow; wo: WorkOrderPaymentState }
  | { kind: "ok"; link: PaymentLinkRow; wo: WorkOrderPaymentState; schedule: PaymentSchedule };

export async function loadPayState(token: string): Promise<PayState> {
  const link = await getPaymentLink(token);
  if (!link) return { kind: "not_found" };
  if (link.revoked_at) return { kind: "revoked", link };
  const wo = await getWorkOrderPaymentStateById(link.work_order_id);
  if (!wo) return { kind: "not_found" };
  if (isClosedForPayment(wo.status)) return { kind: "closed", link, wo };
  const schedule = buildPaymentSchedule({
    terms: wo.terms,
    balanceOwed: wo.balanceOwed,
    inFlightCents: await inFlightCents(wo.id),
  });
  return { kind: "ok", link, wo, schedule };
}

export async function listPaymentsForToken(token: string): Promise<PaymentRow[]> {
  const { data, error } = await db()
    .from("stripe_payments")
    .select("*")
    .eq("token", token)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`stripe_payments read failed: ${error.message}`);
  return (data ?? []) as PaymentRow[];
}

// ─── Checkout ───────────────────────────────────────────────────────────────

/** Error CODES, not text: the pay page maps them to its own copy, so a URL
 *  can't be crafted to put arbitrary words on a PPP-branded page. */
export type CheckoutErrorCode = "unavailable" | "inactive" | "not_due" | "no_method" | "failed";
export type CheckoutResult = { ok: true; url: string } | { ok: false; code: CheckoutErrorCode; detail?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * BANK (ACH) payments, on Stripe's hosted Checkout. Card payments do not come
 * through here: hosted Checkout fixes the amount before the card is typed, so
 * it cannot charge the 3% to credit cards only. They run on /pay/<token>/card
 * (see payByCard below).
 */
export async function createCheckout(input: {
  token: string;
  milestoneKey: string;
  origin: string;
}): Promise<CheckoutResult> {
  const cfg = paymentsConfig();
  if (cfg.stripeBlockedReason) return { ok: false, code: "unavailable", detail: cfg.stripeBlockedReason };

  const state = await loadPayState(input.token);
  if (state.kind !== "ok") return { ok: false, code: "inactive" };
  const quote = quoteCharge(state.schedule, input.milestoneKey, "ach");
  if (!quote) return { ok: false, code: "not_due" };

  // A double-tap, or Back then Pay again: hand back the checkout already open
  // for the same thing at the same amount instead of opening a second one.
  const reuse = await db()
    .from("stripe_payments")
    .select("checkout_url")
    .eq("token", input.token)
    .eq("milestone_key", quote.milestoneKey)
    .eq("method", quote.method)
    .eq("total_cents", quote.totalCents)
    .eq("status", "open")
    .gt("created_at", new Date(Date.now() - 50 * 60_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (reuse.data?.checkout_url) return { ok: true, url: reuse.data.checkout_url as string };

  const wo = state.wo;
  const metadata = {
    source: PPP_PAY_SOURCE,
    token: input.token,
    work_order_id: wo.id,
    work_order_number: wo.number,
    milestone_key: quote.milestoneKey,
    milestone_label: quote.label,
    method: quote.method,
    base_cents: String(quote.baseCents),
    fee_cents: String(quote.feeCents),
  };

  const email = wo.contactEmail && EMAIL_RE.test(wo.contactEmail) ? wo.contactEmail : undefined;
  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["us_bank_account"],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: quote.totalCents,
          product_data: {
            name: `Precision Painting Plus — Invoice ${wo.number} · ${quote.label}`,
            description: "Bank transfer (ACH) — no service fee",
          },
        },
      },
    ],
    // Link off. Found in test 2026-09-29: with Link on, a checkout locked to
    // one method still offered others ("Bank ($5 back)", Klarna) through the
    // Link wallet. This checkout is bank-only and must stay that way.
    wallet_options: { link: { display: "never" } },
    customer_email: email,
    client_reference_id: wo.number,
    metadata,
    payment_intent_data: {
      metadata,
      description: `PPP Invoice ${wo.number} — ${quote.label} (ACH)`,
      // The thank-you page tells the customer a receipt is coming. Stripe only
      // sends one when asked (or when the account-wide setting is on), so ask.
      // Test mode never sends it.
      receipt_email: email,
    },
    success_url: `${input.origin}/pay/${input.token}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/pay/${input.token}`,
    // An hour, not Stripe's 24h default: the amount was computed from the
    // balance NOW, and a day-old checkout could collect a stale one.
    expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
  });
  if (!session.url) return { ok: false, code: "failed", detail: "Stripe returned no checkout URL" };

  const { error } = await db().from("stripe_payments").insert({
    checkout_session_id: session.id,
    token: input.token,
    work_order_id: wo.id,
    work_order_number: wo.number,
    milestone_key: quote.milestoneKey,
    milestone_label: quote.label,
    method: quote.method,
    base_cents: quote.baseCents,
    fee_cents: quote.feeCents,
    total_cents: quote.totalCents,
    status: "open",
    livemode: session.livemode,
    checkout_url: session.url,
    customer_email: wo.contactEmail,
  });
  if (error) {
    // No row means no way to reconcile what Stripe later sends. Kill the
    // session rather than let the customer pay into something we can't track.
    await getStripe().checkout.sessions.expire(session.id).catch(() => undefined);
    throw new Error(`stripe_payments insert failed: ${error.message}`);
  }
  return { ok: true, url: session.url };
}

// ─── Card payments (on our own page) ────────────────────────────────────────
//
// Why not hosted Checkout: it fixes the amount before the customer types a
// card, so it cannot tell a debit card (no fee — PPP's invoice says so) from a
// credit card (+3%). Here the customer enters the card in Stripe's Payment
// Element, the browser turns it into a ConfirmationToken WITHOUT charging, the
// server reads the card's funding type off that token, decides the fee, shows
// the customer the final amount, and only then charges it.

export type CardQuote = {
  funding: CardFunding;
  label: string;
  baseCents: number;
  feeCents: number;
  totalCents: number;
};

export type CardErrorCode = "unavailable" | "inactive" | "not_due" | "bad_card" | "amount_changed" | "declined" | "failed";
export type CardResult =
  | { ok: true; status: "succeeded" | "processing"; paymentIntentId: string }
  | { ok: true; status: "requires_action"; paymentIntentId: string; clientSecret: string }
  | { ok: false; code: CardErrorCode; message?: string; quote?: CardQuote };

const CT_RE = /^ctoken_[A-Za-z0-9]+$/;

async function readCardFunding(confirmationTokenId: string): Promise<CardFunding | null> {
  if (!CT_RE.test(confirmationTokenId)) return null;
  let ct: Stripe.ConfirmationToken;
  try {
    ct = await getStripe().confirmationTokens.retrieve(confirmationTokenId);
  } catch (err) {
    // No such token (made up, expired, or from another account) — a bad card,
    // not a server fault. Anything else (Stripe down) is a real failure.
    if ((err as { type?: string }).type === "StripeInvalidRequestError") return null;
    throw err;
  }
  const preview = ct.payment_method_preview;
  if (!preview || preview.type !== "card") return null;
  return normalizeFunding(preview.card?.funding);
}

/** Step 1: the card is entered. What will it cost? Charges nothing. */
export async function quoteCardPayment(input: {
  token: string;
  milestoneKey: string;
  confirmationTokenId: string;
}): Promise<{ ok: true; quote: CardQuote } | { ok: false; code: CardErrorCode; detail?: string }> {
  const cfg = paymentsConfig();
  if (cfg.cardBlockedReason) return { ok: false, code: "unavailable", detail: cfg.cardBlockedReason };
  const state = await loadPayState(input.token);
  if (state.kind !== "ok") return { ok: false, code: "inactive" };
  const funding = await readCardFunding(input.confirmationTokenId);
  if (!funding) return { ok: false, code: "bad_card" };
  const q = quoteCardCharge(state.schedule, input.milestoneKey, funding);
  if (!q) return { ok: false, code: "not_due" };
  return { ok: true, quote: { funding, label: q.label, baseCents: q.baseCents, feeCents: q.feeCents, totalCents: q.totalCents } };
}

/**
 * Step 2: the customer has seen the final amount and pressed Pay.
 *
 * Everything is recomputed — the balance from Salesforce, the card type from
 * Stripe — and if the result differs from what the customer was shown, nothing
 * is charged: they get the new amount to look at instead. The row is written
 * BEFORE the charge, so money can never arrive for a payment we have no record
 * of; if the row can't be written, the PaymentIntent is cancelled unconfirmed.
 */
export async function payByCard(input: {
  token: string;
  milestoneKey: string;
  confirmationTokenId: string;
  shownTotalCents: number;
  origin: string;
}): Promise<CardResult> {
  const quoted = await quoteCardPayment(input);
  if (!quoted.ok) return { ok: false, code: quoted.code };
  const q = quoted.quote;
  if (q.totalCents !== input.shownTotalCents) return { ok: false, code: "amount_changed", quote: q };

  const state = await loadPayState(input.token);
  if (state.kind !== "ok") return { ok: false, code: "inactive" };
  const wo = state.wo;
  const email = wo.contactEmail && EMAIL_RE.test(wo.contactEmail) ? wo.contactEmail : undefined;
  const feeNote = q.feeCents > 0 ? ` incl. ${formatCents(q.feeCents)} credit card fee` : "";

  const stripe = getStripe();
  const pi = await stripe.paymentIntents.create(
    {
      amount: q.totalCents,
      currency: "usd",
      payment_method_types: ["card"],
      description: `PPP Invoice ${wo.number} — ${q.label} (${q.funding} card${feeNote})`,
      receipt_email: email,
      metadata: {
        source: PPP_PAY_SOURCE,
        flow: CARD_ELEMENT_FLOW,
        token: input.token,
        work_order_id: wo.id,
        work_order_number: wo.number,
        milestone_key: input.milestoneKey,
        milestone_label: q.label,
        method: "card",
        card_funding: q.funding,
        base_cents: String(q.baseCents),
        fee_cents: String(q.feeCents),
      },
    },
    // A double-click sends the same token twice; Stripe hands back the same
    // PaymentIntent instead of making a second one.
    { idempotencyKey: `ppp-pay-${input.confirmationTokenId}` },
  );

  const existing = await db().from("stripe_payments").select("id").eq("payment_intent_id", pi.id).maybeSingle();
  if (!existing.data) {
    const { error } = await db().from("stripe_payments").insert({
      payment_intent_id: pi.id,
      token: input.token,
      work_order_id: wo.id,
      work_order_number: wo.number,
      milestone_key: input.milestoneKey,
      milestone_label: q.label,
      method: "card",
      card_funding: q.funding,
      base_cents: q.baseCents,
      fee_cents: q.feeCents,
      total_cents: q.totalCents,
      status: "open",
      livemode: pi.livemode,
      customer_email: wo.contactEmail,
    });
    if (error) {
      await stripe.paymentIntents.cancel(pi.id).catch(() => undefined);
      throw new Error(`stripe_payments insert failed: ${error.message}`);
    }
  }

  // The same token sent twice gets the same PaymentIntent back (idempotency
  // key above). If the first request already confirmed it, confirming again
  // is an error — report where it stands instead.
  if (pi.status !== "requires_payment_method" && pi.status !== "requires_confirmation") {
    await syncPaymentIntent(pi);
    if (pi.status === "requires_action" && pi.client_secret) {
      return { ok: true, status: "requires_action", paymentIntentId: pi.id, clientSecret: pi.client_secret };
    }
    if (pi.status === "succeeded" || pi.status === "processing") {
      return { ok: true, status: pi.status === "succeeded" ? "succeeded" : "processing", paymentIntentId: pi.id };
    }
    return { ok: false, code: "declined" };
  }

  let confirmed: Stripe.PaymentIntent;
  try {
    confirmed = await stripe.paymentIntents.confirm(pi.id, {
      confirmation_token: input.confirmationTokenId,
      return_url: `${input.origin}/pay/${input.token}/thanks`,
    });
  } catch (err) {
    // A decline. Stripe's own message ("Your card was declined.") is safe to
    // show — it comes from Stripe, not from anything in a URL.
    const e = err as { type?: string; message?: string; payment_intent?: Stripe.PaymentIntent };
    const latest = e.payment_intent ?? (await stripe.paymentIntents.retrieve(pi.id));
    await syncPaymentIntent(latest);
    if (e.type === "StripeCardError") return { ok: false, code: "declined", message: e.message };
    throw err;
  }

  await syncPaymentIntent(confirmed);
  if (confirmed.status === "requires_action" && confirmed.client_secret) {
    return { ok: true, status: "requires_action", paymentIntentId: confirmed.id, clientSecret: confirmed.client_secret };
  }
  if (confirmed.status === "succeeded" || confirmed.status === "processing") {
    return { ok: true, status: confirmed.status === "succeeded" ? "succeeded" : "processing", paymentIntentId: confirmed.id };
  }
  return { ok: false, code: "declined" };
}

/**
 * Bring a card-page payment's row in line with its PaymentIntent. Same rules
 * as syncCheckoutSession: forward only, one Salesforce write, safe to call from
 * the confirm route, the thank-you page and the webhook in any order.
 */
export async function syncPaymentIntent(pi: Stripe.PaymentIntent): Promise<SyncOutcome> {
  if (pi.metadata?.source !== PPP_PAY_SOURCE || pi.metadata?.flow !== CARD_ELEMENT_FLOW) {
    // Bank payments are synced through their Checkout Session.
    return { kind: "ignored", reason: "not a card-page payment" };
  }
  const { data: row, error } = await db().from("stripe_payments").select("*").eq("payment_intent_id", pi.id).maybeSingle();
  if (error) throw new Error(`stripe_payments read failed: ${error.message}`);
  if (!row) return { kind: "ignored", reason: `no stripe_payments row for ${pi.id}` };
  return advance(row as PaymentRow, statusFromPaymentIntent(pi.status), {});
}

// ─── Sync (webhook + thank-you page) ────────────────────────────────────────

export type SyncOutcome =
  | { kind: "ignored"; reason: string }
  | { kind: "unchanged"; payment: PaymentRow }
  | { kind: "updated"; payment: PaymentRow };

/**
 * Bring our row in line with a Checkout Session. Safe to call any number of
 * times, from anywhere: the status only moves forward, and the Salesforce
 * write happens only on the call that actually moves a row to 'succeeded'
 * (a conditional UPDATE decides the winner, so a webhook and the thank-you
 * page racing each other still produce one write).
 */
export async function syncCheckoutSession(session: Stripe.Checkout.Session, eventType?: string): Promise<SyncOutcome> {
  if (session.metadata?.source !== PPP_PAY_SOURCE) return { kind: "ignored", reason: "not a Command Center checkout" };

  const { data: row, error } = await db()
    .from("stripe_payments")
    .select("*")
    .eq("checkout_session_id", session.id)
    .maybeSingle();
  if (error) throw new Error(`stripe_payments read failed: ${error.message}`);
  if (!row) return { kind: "ignored", reason: `no stripe_payments row for ${session.id}` };
  const current = row as PaymentRow;

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  return advance(current, statusFromSession(session, eventType), {
    payment_intent_id: paymentIntentId ?? current.payment_intent_id,
  });
}

/**
 * Move a row to `next` if that is forward. A conditional UPDATE (…WHERE status
 * = the status we read) decides the winner when two callers race, and only the
 * winner writes to Salesforce.
 */
async function advance(
  current: PaymentRow,
  next: OurStatus,
  extra: Record<string, string | null>,
): Promise<SyncOutcome> {
  if (!isForwardMove(current.status, next)) return { kind: "unchanged", payment: current };
  const now = new Date().toISOString();
  const { data: moved, error: moveErr } = await db()
    .from("stripe_payments")
    .update({
      status: next,
      ...extra,
      updated_at: now,
      ...(next === "succeeded" ? { paid_at: now } : {}),
    })
    .eq("id", current.id)
    .eq("status", current.status)
    .select("*")
    .maybeSingle();
  if (moveErr) throw new Error(`stripe_payments update failed: ${moveErr.message}`);
  if (!moved) {
    // Someone else moved it between our read and write. Their call handles
    // whatever follows (including the Salesforce write).
    return { kind: "unchanged", payment: current };
  }
  let payment = moved as PaymentRow;
  if (next === "succeeded") payment = await recordInSalesforce(payment);
  return { kind: "updated", payment };
}

async function recordInSalesforce(p: PaymentRow): Promise<PaymentRow> {
  const cfg = paymentsConfig();
  let payload: Record<string, unknown> | null = null;
  let status: "dry_run" | "written" | "failed";
  let detail: string;
  let sfId: string | null = null;

  try {
    const fields = buildSfTransaction({
      recordTypeId: await getPaymentInRecordTypeId(),
      workOrderId: p.work_order_id,
      workOrderNumber: p.work_order_number,
      milestoneLabel: p.milestone_label,
      method: p.method,
      cardFunding: p.card_funding,
      baseCents: p.base_cents,
      feeCents: p.fee_cents,
      paymentIntentId: p.payment_intent_id,
      paidDateEt: etTodayIso(),
    });
    payload = fields;
    if (shouldWriteToSalesforce(cfg, p.livemode)) {
      sfId = await createSalesforceTransaction(fields);
      status = "written";
      detail = `Created Transaction__c ${sfId}.`;
    } else {
      status = "dry_run";
      detail = !p.livemode
        ? "Test-mode payment — never written to Salesforce."
        : "Salesforce write-back is off (PAYMENTS_SF_WRITEBACK). Payload stored, not sent.";
    }
  } catch (err) {
    status = "failed";
    detail = err instanceof Error ? err.message : String(err);
  }

  const { data, error } = await db()
    .from("stripe_payments")
    .update({
      sf_writeback_status: status,
      sf_transaction_id: sfId,
      sf_payload: payload,
      sf_writeback_detail: detail,
      updated_at: new Date().toISOString(),
    })
    .eq("id", p.id)
    .select("*")
    .single();
  if (error) throw new Error(`stripe_payments write-back record failed: ${error.message}`);
  return data as PaymentRow;
}

/** charge.refunded — a refund issued in the Stripe dashboard. Marks the row;
 *  reversing it in Salesforce stays a person's job (the office already books
 *  refunds as Payment_Out / Customer_Refund). */
export async function markRefunded(paymentIntentId: string): Promise<PaymentRow | null> {
  const { data, error } = await db()
    .from("stripe_payments")
    .update({ status: "refunded", updated_at: new Date().toISOString() })
    .eq("payment_intent_id", paymentIntentId)
    .eq("status", "succeeded")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`stripe_payments refund update failed: ${error.message}`);
  return (data as PaymentRow | null) ?? null;
}

// ─── Webhook idempotency ────────────────────────────────────────────────────

/** True if this event has already been handled successfully. */
/** Throws if the table can't be read or written: without it a redelivered
 *  event can't be recognised, so the webhook must 500 (Stripe retries) rather
 *  than carry on with duplicate protection silently off. */
export async function claimWebhookEvent(e: { id: string; type: string; livemode: boolean }): Promise<boolean> {
  const read = await db().from("stripe_webhook_events").select("outcome").eq("event_id", e.id).maybeSingle();
  if (read.error) throw new Error(`stripe_webhook_events read failed: ${read.error.message}`);
  if (read.data?.outcome?.startsWith("ok")) return true;
  const write = await db()
    .from("stripe_webhook_events")
    .upsert({ event_id: e.id, type: e.type, livemode: e.livemode, outcome: null }, { onConflict: "event_id" });
  if (write.error) throw new Error(`stripe_webhook_events write failed: ${write.error.message}`);
  return false;
}

export async function finishWebhookEvent(id: string, outcome: string): Promise<void> {
  await db().from("stripe_webhook_events").update({ outcome: outcome.slice(0, 1000) }).eq("event_id", id);
}

// ─── Admin ──────────────────────────────────────────────────────────────────

export async function listRecentLinks(limit = 25): Promise<PaymentLinkRow[]> {
  const { data, error } = await db()
    .from("payment_links")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as PaymentLinkRow[];
}

export async function listRecentPayments(limit = 50): Promise<PaymentRow[]> {
  const { data, error } = await db()
    .from("stripe_payments")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as PaymentRow[];
}

/** Admin: try the Salesforce write again for a succeeded payment whose write
 *  failed (or was a dry run and write-back has since been switched on). */
export async function retrySalesforceWrite(paymentId: string): Promise<PaymentRow> {
  const { data, error } = await db().from("stripe_payments").select("*").eq("id", paymentId).single();
  if (error) throw new Error(error.message);
  const p = data as PaymentRow;
  if (p.status !== "succeeded") throw new Error(`Payment is ${p.status}, not succeeded.`);
  if (p.sf_writeback_status === "written") throw new Error(`Already written as ${p.sf_transaction_id}.`);
  return recordInSalesforce(p);
}
