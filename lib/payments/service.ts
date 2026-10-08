import "server-only";

import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { createClient as createSupabaseAdminClient, type SupabaseClient } from "@supabase/supabase-js";
import { etTodayIso } from "@/lib/date-et";
import { readPaymentsConfig, shouldWriteToSalesforce } from "@/lib/payments/config";
import {
  buildPaymentSchedule,
  buildPaymentTermUpdates,
  coveredTermIds,
  formatCents,
  normalizeFunding,
  quoteCardCharge,
  quoteCharge,
  type CardFunding,
  type PaymentSchedule,
} from "@/lib/payments/schedule";
import { buildSfTransaction } from "@/lib/payments/sf-transaction";
import { clearedPaymentsInPayout, depositDateOfArrival } from "@/lib/payments/payout";
import { writeSf } from "@/lib/salesforce/writeback";
import { getPaymentsSalesforceClient, paymentsOrg } from "@/lib/salesforce/payments-org";
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
  findTransactionByReference,
  getPaymentInRecordTypeId,
  getWorkOrderPaymentStateById,
  isClosedForPayment,
  listWorkOrdersNeedingPayLinks,
  setWorkOrderPaymentUrl,
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
  /** 'booking' = claimed by a process writing to Salesforce right now. */
  sf_writeback_status: "booking" | "dry_run" | "written" | "failed" | null;
  sf_transaction_id: string | null;
  sf_payload: Record<string, unknown> | null;
  sf_writeback_detail: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  /** credit / debit / prepaid / unknown — card payments only. */
  card_funding: string | null;
  customer_name: string | null;
  sf_org: "production" | "sandbox";
  payout_id: string | null;
  cleared_at: string | null;
  stripe_fee_cents: number | null;
};

export type PaymentLinkRow = {
  token: string;
  /** Which Salesforce this link belongs to — sandbox Work Order Ids are the same as production's. */
  sf_org: "production" | "sandbox";
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

/** The Salesforce org this server's payments code is on. Every link and
 *  payment row is scoped to it (see migration 20261008200000). */
function currentOrg(): "production" | "sandbox" {
  return paymentsOrg();
}

/** Real money or Stripe test money, from the key this server runs with. A
 *  test payment must never count against a real customer's balance. */
function currentLivemode(): boolean {
  return paymentsConfig().stripeMode === "live";
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

/**
 * The full URL a customer opens. PAYMENTS_LINK_BASE_URL wins (a sandbox test
 * pointing invoices at a laptop), then the app's public URL.
 */
export function paymentLinkUrl(token: string): string {
  const base = (
    process.env.PAYMENTS_LINK_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    "https://hub.precisionpaintingplus.net"
  ).replace(/\/$/, "");
  return `${base}/pay/${token}`;
}

/**
 * Issue (or re-issue) a Work Order's link AND put it in Salesforce's
 * Online_Payment_URL__c, which S-Docs prints on the invoice. Says whether the
 * Salesforce write happened — before Katie's field reaches an org, it can't.
 */
export async function issuePaymentLinkAndPublish(
  wo: { id: string; number: string },
  createdBy: string | null,
): Promise<{ link: PaymentLinkRow; url: string; salesforce: { ok: true } | { ok: false; reason: string } }> {
  const link = await issuePaymentLink(wo, createdBy);
  const url = paymentLinkUrl(link.token);
  const salesforce = await setWorkOrderPaymentUrl(wo.id, url, wo.number).catch((e: unknown) => ({
    ok: false as const,
    reason: e instanceof Error ? e.message : String(e),
  }));
  return { link, url, salesforce };
}

/**
 * Give every open Work Order that needs one a pay link (see
 * listWorkOrdersNeedingPayLinks for which). Bounded per run; run it again for
 * the rest. Returns what happened, for the admin page.
 */
export async function createLinksForOpenWorkOrders(
  createdBy: string | null,
  limit = 100,
): Promise<{
  found: number;
  published: number;
  failed: { number: string; reason: string }[];
  licenseeFilter: "applied" | "unavailable";
}> {
  const { workOrders: wos, licenseeFilter } = await listWorkOrdersNeedingPayLinks(limit);
  let published = 0;
  const failed: { number: string; reason: string }[] = [];
  for (const wo of wos) {
    try {
      const r = await issuePaymentLinkAndPublish(wo, createdBy);
      if (r.salesforce.ok) published++;
      else failed.push({ number: wo.number, reason: r.salesforce.reason });
    } catch (e) {
      failed.push({ number: wo.number, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { found: wos.length, published, failed, licenseeFilter };
}

/** The live link for a Work Order, creating one if there is none. Re-issuing
 *  returns the same token so a link already printed on an invoice keeps working. */
export async function issuePaymentLink(wo: { id: string; number: string }, createdBy: string | null): Promise<PaymentLinkRow> {
  const existing = await db()
    .from("payment_links")
    .select("*")
    .eq("work_order_id", wo.id)
    .eq("sf_org", currentOrg())
    .is("revoked_at", null)
    .maybeSingle();
  if (existing.error) throw new Error(`payment_links read failed: ${existing.error.message}`);
  if (existing.data) return existing.data as PaymentLinkRow;

  // 16 random bytes → 22 url-safe chars. Unguessable, and not the WO number.
  const token = randomBytes(16).toString("base64url");
  const { data, error } = await db()
    .from("payment_links")
    .insert({ token, work_order_id: wo.id, work_order_number: wo.number, created_by: createdBy, sf_org: currentOrg() })
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

/** Switch a link off and take it off the Work Order, so the next invoice falls
 *  back to the old Stripe link instead of printing a dead one. */
export async function revokePaymentLink(token: string): Promise<{ salesforce: { ok: true } | { ok: false; reason: string } }> {
  const { data, error } = await db()
    .from("payment_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("token", token)
    .is("revoked_at", null)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`payment_links revoke failed: ${error.message}`);
  const link = data as PaymentLinkRow | null;
  if (!link) return { salesforce: { ok: true } };
  const salesforce = await setWorkOrderPaymentUrl(link.work_order_id, null, link.work_order_number).catch((e: unknown) => ({
    ok: false as const,
    reason: e instanceof Error ? e.message : String(e),
  }));
  return { salesforce };
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
  // Only this org's payments, in this server's money mode. Test payments made
  // on a real Work Order before go-live are never booked into production, so
  // without the livemode filter they'd count as "already paid" forever.
  const { data, error } = await db()
    .from("stripe_payments")
    .select("base_cents, status, sf_writeback_status")
    .eq("work_order_id", workOrderId)
    .eq("sf_org", currentOrg())
    .eq("livemode", currentLivemode())
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
  // A sandbox link opened on the production server (or the reverse) points at
  // a Work Order in the other Salesforce — treat it as not found here.
  if (!link || (link.sf_org ?? "production") !== currentOrg()) return { kind: "not_found" };
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
    .eq("livemode", currentLivemode())
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
    covers: coveredTermIds(state.schedule, quote.milestoneKey),
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
    customer_name: wo.contactName,
    sf_org: currentOrg(),
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

export type CardErrorCode =
  | "unavailable"
  | "inactive"
  | "not_due"
  | "bad_card"
  | "amount_changed"
  | "declined"
  | "too_many"
  | "failed";
export type CardResult =
  | { ok: true; status: "succeeded" | "processing"; paymentIntentId: string }
  | { ok: true; status: "requires_action"; paymentIntentId: string; clientSecret: string }
  | { ok: false; code: CardErrorCode; message?: string; quote?: CardQuote };

const CT_RE = /^ctoken_[A-Za-z0-9]+$/;
/** Declined cards on one link in an hour before card payments lock for that link. */
export const MAX_CARD_DECLINES_PER_HOUR = 5;

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
  // A public card form is what fraudsters use to test stolen cards. Declines
  // are recorded per link, so this cap holds across every server instance
  // (the in-memory limiter in the route only sees its own).
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count: recentDeclines } = await db()
    .from("stripe_payments")
    .select("id", { count: "exact", head: true })
    .eq("token", input.token)
    .eq("method", "card")
    .eq("status", "failed")
    .gt("created_at", since);
  if ((recentDeclines ?? 0) >= MAX_CARD_DECLINES_PER_HOUR) return { ok: false, code: "too_many" };
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

  // A bank checkout still open for this link (the customer started ACH, came
  // back, chose card) could still be completed afterwards and pay the same
  // milestone twice. Close it first. If it can't be closed because it was
  // just completed, the bank payment is under way — don't take a card too.
  const openAch = await db()
    .from("stripe_payments")
    .select("id, checkout_session_id")
    .eq("token", input.token)
    .eq("method", "ach")
    .eq("status", "open");
  for (const r of openAch.data ?? []) {
    if (!r.checkout_session_id) continue;
    try {
      await stripe.checkout.sessions.expire(r.checkout_session_id);
      await db().from("stripe_payments").update({ status: "expired" }).eq("id", r.id).eq("status", "open");
    } catch {
      const sess = await stripe.checkout.sessions.retrieve(r.checkout_session_id).catch(() => null);
      if (sess && sess.status !== "expired") {
        if (sess.status === "complete") await syncCheckoutSession(sess);
        return { ok: false, code: "not_due" };
      }
    }
  }

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
        covers: coveredTermIds(state.schedule, input.milestoneKey),
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
      customer_name: wo.contactName,
      sf_org: currentOrg(),
    });
    // 23505 = the same PaymentIntent's row already exists: a double-tap's
    // other request got there first. That's fine — never cancel a payment the
    // other request may be confirming right now.
    if (error && error.code !== "23505") {
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
    // A double-tap's second confirm on a payment the first already moved
    // along: report where it actually is instead of an error.
    if (latest.status === "succeeded" || latest.status === "processing") {
      return { ok: true, status: latest.status === "succeeded" ? "succeeded" : "processing", paymentIntentId: latest.id };
    }
    if (latest.status === "requires_action" && latest.client_secret) {
      return { ok: true, status: "requires_action", paymentIntentId: latest.id, clientSecret: latest.client_secret };
    }
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
  if (next === "succeeded" && payment.payout_id) {
    // The payout already arrived (its event beat this one — a retry, say), so
    // this payment has cleared: book it now rather than wait for a payout that
    // has come and gone.
    payment = await recordInSalesforce(payment, payment.payout_id);
  } else if (next === "succeeded") {
    // Not booked yet — see lib/payments/payout.ts. The pay page already counts
    // it (so the customer isn't asked twice); Salesforce gets it at payout.
    const { data } = await db()
      .from("stripe_payments")
      .update({ sf_writeback_detail: "Paid. Waiting for the Stripe payout before booking in Salesforce." })
      .eq("id", payment.id)
      .is("sf_writeback_status", null)
      .select("*")
      .maybeSingle();
    if (data) payment = data as PaymentRow;
  }
  return { kind: "updated", payment };
}

async function recordInSalesforce(p: PaymentRow, payoutId?: string): Promise<PaymentRow> {
  const cfg = paymentsConfig();
  // Claim the row before touching Salesforce: two deliveries of one payout, or
  // an admin's "Book now" during a payout, must not both create a Payment In.
  // Only one UPDATE … WHERE sf_writeback_status is still bookable wins.
  const { data: claimed, error: claimErr } = await db()
    .from("stripe_payments")
    .update({ sf_writeback_status: "booking", updated_at: new Date().toISOString() })
    .eq("id", p.id)
    .or("sf_writeback_status.is.null,sf_writeback_status.eq.failed,sf_writeback_status.eq.dry_run")
    .select("*")
    .maybeSingle();
  if (claimErr) throw new Error(`stripe_payments claim failed: ${claimErr.message}`);
  if (!claimed) {
    const { data: now } = await db().from("stripe_payments").select("*").eq("id", p.id).single();
    return now as PaymentRow;
  }
  p = claimed as PaymentRow;
  let payload: Record<string, unknown> | null = null;
  let status: "dry_run" | "written" | "failed";
  let detail: string;
  let sfId: string | null = null;

  // The day the money reached the bank (the payout's arrival), or today when
  // an admin books early. Drives Date__c and the "ST"+MMDD Reference ID.
  const depositDateEt = (payoutId && p.cleared_at && depositDateOfArrival(p.cleared_at)) || etTodayIso();
  try {
    const wo = await getWorkOrderPaymentStateById(p.work_order_id);
    const fields = buildSfTransaction({
      recordTypeId: await getPaymentInRecordTypeId(),
      workOrderId: p.work_order_id,
      opportunityId: wo?.opportunityId ?? null,
      workOrderNumber: p.work_order_number,
      milestoneLabel: p.milestone_label,
      method: p.method,
      cardFunding: p.card_funding,
      baseCents: p.base_cents,
      feeCents: p.fee_cents,
      paymentIntentId: p.payment_intent_id,
      paidDateEt: depositDateEt,
      fromPayout: Boolean(payoutId),
    });
    // Which Payment Terms this payment completes, read live so a term already
    // marked paid (by an earlier online payment) isn't written twice.
    // What the customer's payment covered, captured when they paid (Stripe
    // metadata) — for a full-balance payment this is NOT "every open term".
    let covers: string[] | null = null;
    if (p.milestone_key === "balance" && p.payment_intent_id) {
      const pi = await getStripe().paymentIntents.retrieve(p.payment_intent_id).catch(() => null);
      const raw = pi?.metadata?.covers;
      covers = raw ? raw.split(",").filter(Boolean) : null;
    }
    const termUpdates = buildPaymentTermUpdates({
      milestoneKey: p.milestone_key,
      terms: wo?.terms ?? [],
      coveredTermIds: covers,
      paidDateEt: depositDateEt,
    });
    payload = { transaction: fields, paymentTerms: termUpdates };

    if (shouldWriteToSalesforce(cfg, p.livemode)) {
      const already = p.payment_intent_id ? await findTransactionByReference(p.payment_intent_id) : null;
      if (already) {
        sfId = already;
        detail = `Already booked as Transaction__c ${already} (same Stripe reference) — not created again.`;
      } else {
        sfId = await createSalesforceTransaction(fields);
        detail = `Created Transaction__c ${sfId}.`;
      }
      status = "written";
      // The money is booked; a term that fails to update is a label problem, not
      // a money problem. Say so in the detail rather than marking the whole
      // write failed — a retry would book the payment twice.
      const failed: string[] = [];
      for (const u of termUpdates) {
        const res = await writeSf(
          { sObject: "Payment_Term__c", recordId: u.id, fields: u.fields },
          {
            source: "online_payment",
            workOrderNumber: p.work_order_number,
            connection: paymentsOrg() === "sandbox" ? await getPaymentsSalesforceClient() : undefined,
          },
        );
        if (!res.ok) failed.push(`${u.id}: ${res.error}`);
      }
      if (termUpdates.length) {
        detail += failed.length
          ? ` Payment Term update FAILED — mark it paid by hand: ${failed.join("; ")}`
          : ` Marked ${termUpdates.length} Payment Term${termUpdates.length === 1 ? "" : "s"} paid.`;
      }
    } else {
      status = "dry_run";
      detail = !cfg.sfWritebackOn
        ? "Salesforce write-back is off (PAYMENTS_SF_WRITEBACK). Payload stored, not sent."
        : cfg.sfOrg === "sandbox"
          ? "Real-money payment — never written to a sandbox."
          : "Test-mode payment — never written to production Salesforce.";
    }
  } catch (err) {
    status = "failed";
    detail = err instanceof Error ? err.message : String(err);
  }

  if (payoutId) detail = `Cleared in Stripe payout ${payoutId}. ${detail}`;
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

/**
 * payout.paid — the money is on its way to PPP's bank, so the payments in it
 * have cleared. Book each one of ours in Salesforce (Payment In + Payment Term).
 * Safe to run twice: a payment already booked (sf_writeback_status set) is
 * skipped, and the Salesforce write itself refuses a duplicate pi_ reference.
 */
export async function bookPaidOutPayments(
  payoutId: string,
): Promise<{ inPayout: number; booked: number; failed: number }> {
  const stripe = getStripe();
  const txns: Parameters<typeof clearedPaymentsInPayout>[0] = [];
  for await (const t of stripe.balanceTransactions.list({ payout: payoutId, limit: 100, expand: ["data.source"] })) {
    txns.push(t as unknown as Parameters<typeof clearedPaymentsInPayout>[0][number]);
  }
  const cleared = clearedPaymentsInPayout(txns);
  if (!cleared.size) return { inPayout: 0, booked: 0, failed: 0 };
  const payout = await stripe.payouts.retrieve(payoutId);
  // Midnight UTC of the arrival day — see depositDateOfArrival.
  const clearedAt = new Date(payout.arrival_date * 1000).toISOString();
  const r = await bookClearedPayments([...cleared.keys()], payoutId, { clearedAt, fees: cleared });
  return { inPayout: cleared.size, ...r };
}

/**
 * Book the given cleared payments (ours only, not yet booked). Returns how
 * many booked. `cleared` records what the Payments tab shows about clearing —
 * when, which payout, what Stripe charged — before the Salesforce write.
 */
export async function bookClearedPayments(
  piIds: string[],
  payoutId: string,
  cleared?: { clearedAt: string; fees: Map<string, { stripeFeeCents: number | null }> },
): Promise<{ booked: number; failed: number }> {
  if (cleared) {
    for (const pi of piIds) {
      await db()
        .from("stripe_payments")
        .update({
          payout_id: payoutId,
          cleared_at: cleared.clearedAt,
          stripe_fee_cents: cleared.fees.get(pi)?.stripeFeeCents ?? null,
        })
        .eq("payment_intent_id", pi)
        .eq("sf_org", currentOrg())
        .is("payout_id", null);
    }
  }
  const { data, error } = await db()
    .from("stripe_payments")
    .select("*")
    .in("payment_intent_id", piIds)
    .eq("sf_org", currentOrg())
    .eq("status", "succeeded")
    .is("sf_writeback_status", null);
  if (error) throw new Error(`stripe_payments read failed: ${error.message}`);
  // A payment in this payout that isn't 'succeeded' here yet (its success event
  // is still being retried) now has payout_id set; advance() books it the
  // moment it succeeds.
  let booked = 0;
  let failed = 0;
  for (const row of (data ?? []) as PaymentRow[]) {
    const done = await recordInSalesforce(row, payoutId);
    if (done.sf_writeback_status === "failed") failed++;
    else if (done.sf_writeback_status !== "booking") booked++;
  }
  return { booked, failed };
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
    .eq("sf_org", currentOrg())
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as PaymentLinkRow[];
}

export async function listRecentPayments(limit = 50): Promise<PaymentRow[]> {
  const { data, error } = await db()
    .from("stripe_payments")
    .select("*")
    .eq("sf_org", currentOrg())
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as PaymentRow[];
}

/** Admin: book a succeeded payment in Salesforce now — after a failed write,
 *  a dry run since switched on, or to not wait for the payout (a person's call). */
export async function retrySalesforceWrite(paymentId: string): Promise<PaymentRow> {
  const { data, error } = await db().from("stripe_payments").select("*").eq("id", paymentId).single();
  if (error) throw new Error(error.message);
  const p = data as PaymentRow;
  if (p.status !== "succeeded") throw new Error(`Payment is ${p.status}, not succeeded.`);
  if (p.sf_writeback_status === "written") throw new Error(`Already written as ${p.sf_transaction_id}.`);
  if (p.sf_writeback_status === "booking") {
    // A booking that never finished (the process died mid-way). Only take it
    // over once it's clearly abandoned, never while it may still be running.
    if (Date.now() - new Date(p.updated_at).getTime() < 10 * 60_000) {
      throw new Error("A Salesforce booking for this payment is in progress. Try again in a few minutes.");
    }
    await db().from("stripe_payments").update({ sf_writeback_status: "failed" }).eq("id", p.id).eq("sf_writeback_status", "booking");
  }
  // Keep the payout: a payment that cleared is booked with its deposit date and
  // code, not today's, even when an admin retries it.
  return recordInSalesforce(p, p.payout_id ?? undefined);
}

/** Every online payment that moved money, newest first — the Payments tab filters these. */
export async function listLedgerPayments(max = 50_000): Promise<PaymentRow[]> {
  // Paged: Supabase returns at most 1,000 rows per request whatever .limit()
  // says, and the totals and export must not silently stop there.
  const out: PaymentRow[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await db()
      .from("stripe_payments")
      .select("*")
      .eq("sf_org", currentOrg())
      .in("status", ["processing", "succeeded", "refunded"])
      .order("created_at", { ascending: false })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as PaymentRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
