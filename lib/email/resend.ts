import "server-only";

/**
 * Resend wrapper. Phase 2 uses this for:
 *   1. Customer form invitation emails (templated link to /select/[token])
 *   2. Vendor materials-order emails (admin-reviewed, may have CC/BCC)
 *
 * Sender domain options:
 *   - precisionpaintingplus.net (needs PPP IT to add DKIM records)
 *   - orders.precisionpaintingplus.net (fresh subdomain, cleanest brand)
 *
 * RESEND_FROM_ADDRESS is read at runtime so deploy can happen before the
 * final decision; the address gets configured via Vercel env var.
 */

type ResendSendInput = {
  to: string | string[];
  subject: string;
  /** Plain-text body. Always included for deliverability. */
  text: string;
  /** HTML body. Optional — Resend handles plain-text if not provided. */
  html?: string;
  /** From address override. Defaults to RESEND_FROM_ADDRESS. */
  from?: string;
  /** Reply-To. Used for vendor emails so vendor replies hit the rep's inbox. */
  replyTo?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  /** Useful for grouping in Resend dashboard + future webhooks. */
  tags?: Array<{ name: string; value: string }>;
};

type ResendSendResult =
  // id is null when Resend accepted the send (200) but returned no message id.
  // Callers MUST NOT persist a sentinel like "unknown" as resend_message_id —
  // two such rows would collide on threading. Persist only a non-null id.
  | { ok: true; id: string | null }
  | { ok: false; error: string; statusCode?: number };

const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * Send a transactional email through Resend. Returns the Resend message id on
 * success (used for webhook correlation + status tracking in supplier_orders,
 * inbox_messages, and customer_form_tokens).
 *
 * Fails LOUDLY in dev (throws) and SOFTLY in prod (returns error) so a single
 * misconfigured env doesn't kill the page render. The caller decides what to
 * do with the failure — typically log to sf_writes_audit or surface a "retry"
 * banner to the admin.
 */
export async function sendEmail(input: ResendSendInput): Promise<ResendSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const defaultFrom = process.env.RESEND_FROM_ADDRESS;
  if (!apiKey) {
    const msg = "RESEND_API_KEY not set — cannot send email";
    if (process.env.NODE_ENV !== "production") throw new Error(msg);
    return { ok: false, error: msg };
  }
  const from = input.from ?? defaultFrom;
  if (!from) {
    return {
      ok: false,
      error:
        "No sender — set RESEND_FROM_ADDRESS env var or pass input.from explicitly",
    };
  }

  const body = {
    from,
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
    ...(input.replyTo
      ? { reply_to: Array.isArray(input.replyTo) ? input.replyTo : [input.replyTo] }
      : {}),
    ...(input.cc ? { cc: Array.isArray(input.cc) ? input.cc : [input.cc] } : {}),
    ...(input.bcc ? { bcc: Array.isArray(input.bcc) ? input.bcc : [input.bcc] } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
  };

  try {
    // 10s timeout — Resend's API usually responds in <1s. Anything longer is
    // a hung connection, and without a timeout the function would block until
    // Vercel kills it at 60s, leaving a supplier_orders row in an ambiguous
    // state. Returning a normal failure lets the caller mark status='failed'
    // + surface a retry button.
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`[resend] send failed ${res.status}: ${text}`);
      return { ok: false, error: text || `HTTP ${res.status}`, statusCode: res.status };
    }
    let parsed: { id?: string } = {};
    try {
      parsed = JSON.parse(text) as { id?: string };
    } catch {
      // Resend usually returns JSON; if not, log raw and report success-without-id
    }
    if (!parsed.id) {
      console.warn(`[resend] response missing id: ${text}`);
      return { ok: true, id: null };
    }
    return { ok: true, id: parsed.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[resend] threw:", msg);
    return { ok: false, error: msg };
  }
}

/**
 * Convenience: send the customer color-form invitation email.
 *
 * Template copy now lives in lib/customer-form/templates.ts — admin can edit
 * subject + intro + outro + signoff via /dashboard/settings/templates without
 * a code deploy. Code defaults are the fallback if the templates table is
 * empty/unavailable.
 *
 * The `subjectOverride` + `introOverride` params are still honored — they
 * let the modal in materials-view.tsx provide per-send custom copy ahead of
 * the global template (rarely used; mostly for one-off VIP customers).
 */
export async function sendCustomerFormInvite(input: {
  to: string;
  customerName: string | null;
  workOrderNumber: string | null;
  formUrl: string;
  /** Optional per-send intro paragraph — overrides the global template. */
  introOverride?: string;
  /** Optional per-send subject — overrides the global template. */
  subjectOverride?: string;
}): Promise<ResendSendResult> {
  // Lazy import so the rest of the module stays edge-runtime-friendly (the
  // templates loader pulls supabase-js which is server-only).
  const { loadTemplates, render, buildVars } = await import("@/lib/customer-form/templates");
  const { templates } = await loadTemplates();
  const vars = buildVars({
    customerName: input.customerName,
    workOrderNumber: input.workOrderNumber,
    formUrl: input.formUrl,
  });

  const greeting = vars.customer_name ? `Hi ${vars.customer_name},` : "Hi there,";
  const subject = input.subjectOverride ?? render(templates.email_subject, vars);
  const intro = input.introOverride ?? render(templates.email_intro, vars);
  const outro = render(templates.email_outro, vars);
  const signoff = render(templates.email_signoff, vars);

  const text = [
    greeting,
    "",
    intro,
    "",
    "It should only take a couple of minutes:",
    "",
    input.formUrl,
    "",
    outro,
    "",
    signoff,
  ].join("\n");

  return sendEmail({
    to: input.to,
    subject,
    text,
    tags: [
      { name: "kind", value: "customer_form_invite" },
      ...(input.workOrderNumber ? [{ name: "wo", value: input.workOrderNumber }] : []),
    ],
  });
}
