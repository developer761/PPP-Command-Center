/**
 * The switches for online payments, and why each defaults to OFF.
 *
 * Pure (reads the env object it is handed) so the guards are tested directly —
 * a safety switch nobody has watched refuse is not a safety switch.
 *
 *   STRIPE_SECRET_KEY        sk_test_… / rk_test_… only. A live key is refused
 *                            unless STRIPE_LIVE_ENABLED=1 — so pasting the
 *                            wrong key during testing cannot take real money.
 *   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY  pk_test_… — the browser half of the key
 *                            pair, for the card form. Must be the same mode as
 *                            the secret key.
 *   STRIPE_WEBHOOK_SECRET    whsec_… for /api/stripe/webhook. Without it the
 *                            webhook rejects everything.
 *   PAYMENTS_PUBLIC=1        /pay/<token> opens without signing in. Until then
 *                            it is admin-only — nothing is customer-facing.
 *   PAYMENTS_SF_ORG=sandbox  The payments code talks to a Salesforce SANDBOX
 *                            (lib/salesforce/payments-org.ts). Local testing.
 *   PAYMENTS_SF_WRITEBACK=on Create the Transaction__c in Salesforce. Off, the
 *                            payload is built and stored as a dry run. Even on,
 *                            TEST-mode payments are never written: a fake
 *                            payment must never reach PPP's real books.
 */

export type PaymentsConfig = {
  stripeKeyPresent: boolean;
  stripeMode: "test" | "live" | null;
  /** Why checkout is unavailable, or null if it is available. */
  stripeBlockedReason: string | null;
  /** NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY — the browser half, for the card form. */
  publishableKey: string | null;
  /** Why card payments are unavailable (bank payments may still work). */
  cardBlockedReason: string | null;
  webhookSecretPresent: boolean;
  publicPages: boolean;
  sfWritebackOn: boolean;
  /** PAYMENTS_SF_ORG — which Salesforce the payments code talks to. */
  sfOrg: "production" | "sandbox";
};

export function readPaymentsConfig(env: Record<string, string | undefined>): PaymentsConfig {
  const key = env.STRIPE_SECRET_KEY?.trim() ?? "";
  const mode: PaymentsConfig["stripeMode"] = /^(sk|rk)_test_/.test(key)
    ? "test"
    : /^(sk|rk)_live_/.test(key)
      ? "live"
      : null;

  let blocked: string | null = null;
  if (!key) blocked = "STRIPE_SECRET_KEY is not set.";
  else if (!mode) blocked = "STRIPE_SECRET_KEY is not a Stripe secret or restricted key (sk_… / rk_…).";
  else if (mode === "live" && env.STRIPE_LIVE_ENABLED?.trim() !== "1") {
    blocked = "STRIPE_SECRET_KEY is a LIVE key and live payments are not switched on (STRIPE_LIVE_ENABLED=1). Use the test key while testing.";
  }

  // The card form runs in the browser with the publishable key. A test
  // publishable key beside a live secret key (or the reverse) fails at the
  // worst moment — mid-payment — so refuse the pairing up front.
  const pk = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim() ?? "";
  const pkMode = pk.startsWith("pk_test_") ? "test" : pk.startsWith("pk_live_") ? "live" : null;
  let cardBlocked: string | null = blocked;
  if (!cardBlocked) {
    if (!pk) cardBlocked = "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set.";
    else if (!pkMode) cardBlocked = "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not a publishable key (pk_…).";
    else if (pkMode !== mode) {
      cardBlocked = `The publishable key is ${pkMode} mode but the secret key is ${mode} mode — they must match.`;
    }
  }

  return {
    publishableKey: pk || null,
    cardBlockedReason: cardBlocked,
    stripeKeyPresent: Boolean(key),
    stripeMode: mode,
    stripeBlockedReason: blocked,
    webhookSecretPresent: Boolean(env.STRIPE_WEBHOOK_SECRET?.trim()),
    // Trimmed: a value pasted into a dashboard with a trailing space or newline
    // must not read as "off" (a preview 404'd on exactly that suspicion).
    publicPages: env.PAYMENTS_PUBLIC?.trim() === "1",
    sfWritebackOn: env.PAYMENTS_SF_WRITEBACK?.trim() === "on",
    sfOrg: env.PAYMENTS_SF_ORG?.trim() === "sandbox" ? "sandbox" : "production",
  };
}

/**
 * Should THIS payment be written to Salesforce? Write-back must be on, and:
 *   - against PRODUCTION, the payment must be real money — a Stripe test
 *     payment never reaches PPP's real books;
 *   - against a SANDBOX, the reverse — only test payments, since that's the
 *     whole point of testing there, and real money never belongs in a sandbox.
 */
export function shouldWriteToSalesforce(cfg: PaymentsConfig, paymentLivemode: boolean): boolean {
  if (!cfg.sfWritebackOn) return false;
  return cfg.sfOrg === "sandbox" ? !paymentLivemode : paymentLivemode;
}
