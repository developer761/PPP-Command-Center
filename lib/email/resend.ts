import "server-only";

/**
 * Resend wrapper. Phase 2 uses this for:
 *   1. Customer form invitation emails (templated link to /select/[token])
 *   2. Vendor materials-order emails (admin-reviewed, may have CC/BCC)
 *
 * Sender domain pending Karan's decision — options:
 *   - gobkflow.com (already DKIM-verified for BKFlow)
 *   - precisionpaintingplus.net (would need PPP IT to add DKIM records)
 *   - orders.precisionpaintingplus.net (fresh subdomain, cleanest brand)
 *
 * Until that's set, RESEND_FROM_ADDRESS is read at runtime so deploy can
 * happen before the final decision; the address gets configured via Vercel
 * env var.
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
  | { ok: true; id: string }
  | { ok: false; error: string; statusCode?: number };

const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * Send a transactional email through Resend. Returns the Resend message id on
 * success (used for webhook correlation + status tracking in vendor_email_sends
 * and customer_form_tokens).
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
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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
      return { ok: true, id: "unknown" };
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
 * The template is intentionally minimal here — plain text + a single link.
 * The actual brand-styled HTML version will land once we have the form working
 * end-to-end. Plain text is universally deliverable.
 */
export async function sendCustomerFormInvite(input: {
  to: string;
  customerName: string | null;
  workOrderNumber: string | null;
  formUrl: string;
  /** Optional admin-customized intro paragraph. */
  introOverride?: string;
  /** Optional admin-customized subject. */
  subjectOverride?: string;
}): Promise<ResendSendResult> {
  const greeting = input.customerName ? `Hi ${input.customerName},` : "Hi,";
  const intro =
    input.introOverride ??
    `Thanks for choosing Precision Painting Plus! We're getting ready to start your paint job${
      input.workOrderNumber ? ` (Work Order #${input.workOrderNumber})` : ""
    } and need a few quick details from you — your color choices for each room.`;

  const subject =
    input.subjectOverride ??
    `Action needed: Pick your paint colors${
      input.workOrderNumber ? ` (WO #${input.workOrderNumber})` : ""
    }`;

  const text = [
    greeting,
    "",
    intro,
    "",
    "It should only take a couple of minutes:",
    "",
    input.formUrl,
    "",
    "Once you submit, we'll order materials and confirm your start date. The link is unique to your job — please don't share it.",
    "",
    "If you have questions or want to add anything, just reply to this email.",
    "",
    "Thanks,",
    "Precision Painting Plus",
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
