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
  /** From address override. Defaults to channel-specific env var. */
  from?: string;
  /** Reply-To. Used for vendor emails so vendor replies hit the rep's inbox. */
  replyTo?: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  /** Useful for grouping in Resend dashboard + future webhooks. */
  tags?: Array<{ name: string; value: string }>;
  /**
   * Sender channel — picks the API key + default From address pair.
   *
   * - "customer" (default): customer-facing transactional email
   *   (color-form invites, supplier orders, vendor notifications).
   *   Reads RESEND_API_KEY + RESEND_FROM_ADDRESS.
   *   Today: orders@orders.precisionpaintingplus.net.
   *
   * - "commercial": INTERNAL team notifications for the Commercial CC
   *   (team-add, task-assigned, status-changed, win/loss debrief, etc.).
   *   Reads COMMERCIAL_RESEND_API_KEY + COMMERCIAL_RESEND_FROM_ADDRESS.
   *   Falls back to the customer envs if the commercial ones aren't
   *   set — so existing deploys keep working until Karan finishes the
   *   commercial subdomain setup. Once the new domain + key are added
   *   to Vercel, commercial emails automatically separate.
   *
   * Why two channels? Deliverability isolation — a customer marking a
   * team-add email as spam can't tank the customer-form-invite domain
   * reputation, and vice versa. Suppression lists stay separate.
   */
  channel?: "customer" | "commercial";
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
  // Channel routing — picks the right API key + From address.
  // Commercial path falls back to customer envs if commercial-specific
  // ones aren't configured yet, so existing deploys keep working until
  // Karan finishes setting up the commercial subdomain in Resend +
  // Vercel. Once those land, commercial emails automatically separate.
  const channel = input.channel ?? "customer";
  const apiKey =
    channel === "commercial"
      ? (process.env.COMMERCIAL_RESEND_API_KEY || process.env.RESEND_API_KEY)
      : process.env.RESEND_API_KEY;
  const defaultFrom =
    channel === "commercial"
      ? (process.env.COMMERCIAL_RESEND_FROM_ADDRESS || process.env.RESEND_FROM_ADDRESS)
      : process.env.RESEND_FROM_ADDRESS;
  if (!apiKey) {
    const msg = `${channel === "commercial" ? "COMMERCIAL_RESEND_API_KEY (or RESEND_API_KEY)" : "RESEND_API_KEY"} not set — cannot send email`;
    if (process.env.NODE_ENV !== "production") throw new Error(msg);
    return { ok: false, error: msg };
  }
  const from = input.from ?? defaultFrom;
  if (!from) {
    return {
      ok: false,
      error:
        channel === "commercial"
          ? "No sender — set COMMERCIAL_RESEND_FROM_ADDRESS (or RESEND_FROM_ADDRESS) env var or pass input.from explicitly"
          : "No sender — set RESEND_FROM_ADDRESS env var or pass input.from explicitly",
    };
  }

  // Auto-tag every send with its channel so the Resend dashboard can
  // filter "commercial only" vs "customer only" without each caller
  // having to remember to add it. Channel tag is appended to whatever
  // tags the caller already passed.
  const channelTag = { name: "channel", value: channel };
  const finalTags = input.tags ? [...input.tags, channelTag] : [channelTag];

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
    tags: finalTags,
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
/** HTML escape for customer-supplied values rendered inside the invite email
 *  template. PPP customers come from Salesforce so injection is unlikely, but
 *  these values cross our system boundary into a third-party email body, so
 *  we escape defensively. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendCustomerFormInvite(input: {
  to: string;
  customerName: string | null;
  workOrderNumber: string | null;
  formUrl: string;
  /** Optional per-send intro paragraph — overrides the global template. */
  introOverride?: string;
  /** Optional per-send subject — overrides the global template. */
  subjectOverride?: string;
  /** Sender info — Katie 2026-06-05: "CC the sender so customer can reply
   *  directly to their estimator, and include their phone number." Email
   *  must be a PPP-domain address (server-side enforced). */
  senderEmail?: string | null;
  /** Display name of the sender ("Katie B."). Shown in the email body
   *  alongside their phone so the customer knows who to call. */
  senderName?: string | null;
  /** Sender's phone — shown in the email body. Free-form so admin can
   *  use whatever format ("(516) 555-1234" / "516.555.1234"). */
  senderPhone?: string | null;
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

  // Use customer's FIRST name only in the greeting (matches Katie's HTML
  // template: "Hi Joseph,"). Falls back to "Hi there," when unknown.
  const firstName = vars.customer_name.trim().split(/\s+/)[0] ?? "";
  const greeting = firstName ? `Hi ${firstName},` : "Hi there,";
  const subject = input.subjectOverride ?? render(templates.email_subject, vars);
  const intro = input.introOverride ?? render(templates.email_intro, vars);
  const outro = render(templates.email_outro, vars);
  const signoff = render(templates.email_signoff, vars);

  // Plain-text fallback (always sent alongside the HTML for clients that
  // don't render HTML + for deliverability scoring).
  const senderBlock: string[] = [];
  if (input.senderName) senderBlock.push(input.senderName);
  senderBlock.push("Precision Painting Plus");
  if (input.senderPhone) senderBlock.push(`Direct: ${input.senderPhone}`);
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
    senderBlock.length > 1 ? `Thank you,\n${senderBlock.join("\n")}` : signoff,
  ].join("\n");

  // HTML body — matches the standard PPP transactional email template Katie
  // sent over (2026-06-03). Tahoma 10pt / orange #d35400 brand color, logo
  // hosted on PPP's Salesforce file server (the same URL PPP uses on every
  // other customer transactional email so it's already on the customer's
  // implicit-trust list). The work order number is shown in a gray box
  // with "Awaiting your color selections" status copy.
  const escName = firstName ? escapeHtml(firstName) : "there";
  const escWo = vars.wo_number ? escapeHtml(vars.wo_number) : "";
  const escUrl = encodeURI(input.formUrl); // safe-for-href
  const woBlock = escWo
    ? `<strong>Work Order:</strong> #${escWo}<br/>\n                <strong>Status:</strong> <span style="color:#c0392b;">Awaiting your color selections</span>`
    : `<strong>Status:</strong> <span style="color:#c0392b;">Awaiting your color selections</span>`;
  const html = `<table border="0" cellpadding="0" cellspacing="0" style="width:600px; font-family:tahoma,geneva,sans-serif; font-size:10pt; line-height:1.5; color:#333;">
  <tbody>
    <tr>
      <td style="padding:20px 20px 10px 20px; text-align:center;">
        <img alt="Precision Painting Plus" src="https://precisionplus.file.force.com/servlet/servlet.ImageServer?id=0156g000003hGa2AAE&amp;oid=00D6g000001XvD9EAK" width="200" height="55" />
      </td>
    </tr>
    <tr>
      <td style="padding:15px 20px 5px 20px;">
        <p style="margin:0 0 12px 0;">Hi ${escName},</p>
        <p style="margin:0 0 12px 0; font-size:11pt; font-weight:bold;">Thanks for choosing Precision Painting Plus!</p>
        <p style="margin:0 0 12px 0;">We're getting ready to start your paint job and need a few quick details from you &mdash; your color choices for each room.</p>
        <p style="margin:0 0 12px 0;">It should only take a couple of minutes.</p>
      </td>
    </tr>
    <tr>
      <td style="padding:5px 20px;">
        <table border="0" cellpadding="10" cellspacing="0" style="width:100%; background:#f5f5f5; border:1px solid #ddd;">
          <tbody>
            <tr>
              <td style="font-size:9pt;">
                ${woBlock}
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 20px 10px 20px; text-align:center;">
        <a href="${escUrl}" target="_blank" style="display:inline-block; padding:12px 28px; background-color:#d35400; color:#ffffff; text-decoration:none; font-weight:bold; font-size:11pt; border-radius:4px;">Select Your Colors</a>
      </td>
    </tr>
    <tr>
      <td style="padding:10px 20px;">
        <p style="margin:0 0 12px 0;">Once you submit your selections, we'll order materials and confirm your start date.</p>
        <p style="margin:0 0 12px 0; font-size:9pt; color:#777;"><em>This link is unique to your job &mdash; please don't share it.</em></p>
        <p style="margin:0 0 12px 0;">If you have questions or want to add anything, just reply to this email.</p>
      </td>
    </tr>
    <tr>
      <td style="padding:10px 20px 20px 20px; border-top:1px solid #ddd;">
        <p style="margin:0 0 4px 0;">Thank you,</p>
        ${input.senderName ? `<p style="margin:0 0 2px 0; font-weight:bold; color:#333;">${escapeHtml(input.senderName)}</p>` : ""}
        <p style="margin:0; font-weight:bold; color:#d35400;">Precision Painting Plus</p>
        ${input.senderPhone ? `<p style="margin:6px 0 0 0; font-size:10pt; color:#333;">Direct: <a href="tel:${encodeURIComponent(input.senderPhone.replace(/[^+\d]/g, ""))}" style="color:#d35400; text-decoration:none;">${escapeHtml(input.senderPhone)}</a></p>` : ""}
        <p style="margin:8px 0 0 0; font-size:9pt; color:#777;">
          825 East Gate Blvd, Ste 310, Garden City, NY 11530<br/>
          <a href="https://www.precisionpaintingplus.com" style="color:#d35400; text-decoration:none;">precisionpaintingplus.com</a>
        </p>
      </td>
    </tr>
  </tbody>
</table>`;

  // CC the sender so customer replies go back to their actual estimator,
  // not just the unattended Mail Hub inbox. Only PPP-owned domains —
  // belt-and-suspenders even though admin endpoint already validates.
  const senderEmail = input.senderEmail?.trim().toLowerCase() ?? "";
  const ccList =
    senderEmail &&
    (senderEmail.endsWith("@precisionpaintingplus.com") || senderEmail.endsWith("@precisionpaintingplus.net"))
      ? [senderEmail]
      : undefined;

  return sendEmail({
    to: input.to,
    cc: ccList,
    subject,
    text,
    html,
    tags: [
      { name: "kind", value: "customer_form_invite" },
      ...(input.workOrderNumber ? [{ name: "wo", value: input.workOrderNumber }] : []),
    ],
  });
}
