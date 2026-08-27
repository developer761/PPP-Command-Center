/**
 * "Alert us when anything fails."  — Kate, R6.1
 *
 * Every failure on the paint / materials side goes to Slack. Kate asked for it
 * NOISY to begin with, on the reasoning that we cannot dial back what we never
 * see. So the bar for sending is "something didn't do what it was supposed to",
 * not "something we already decided was important".
 *
 * WHY NOT `lib/observability.ts`. That module is deliberately PII-safe — UUID
 * prefixes, kind labels, generic counts — because it pages on infrastructure
 * faults where the identity of the record does not change the response. These
 * alerts are the opposite: the ONLY useful thing about "a colour form bounced"
 * is which customer, on which job. An alert Kate cannot act on is noise she
 * will learn to ignore, which is worse than no alert. It also posts to the
 * COMMERCIAL incident channel, and routing residential materials failures there
 * would cross two engagements that are kept apart on purpose.
 *
 * IF THE ALERT ITSELF FAILS. Kate called this out specifically. Slack is tried
 * first; if the webhook is unset, errors, or returns non-2xx, the same message
 * is emailed to the ops recipients instead. If BOTH fail the failure is logged
 * at error level with a distinct marker, which is the last thing left that a
 * human can find. The one outcome that must never happen is silence.
 *
 * NEVER THROWS. This is called from inside catch blocks and webhook handlers.
 * If reporting a failure could itself fail the request, a bad webhook URL would
 * take down the very flows it was added to watch.
 */

import { opsAlertRecipients } from "@/lib/customer-form/sf-failure-alert";
import { sendEmail } from "@/lib/email/resend";

export type MaterialsAlertKind =
  | "supplier_order_bounced"
  | "supplier_order_send_failed"
  | "color_form_bounced"
  | "salesforce_write_rejected"
  | "alert_delivery_failed"
  | "unexpected_error";

export type MaterialsAlert = {
  kind: MaterialsAlertKind;
  /** One line, plain English, written for someone who has to act on it. */
  summary: string;
  /** Work order number where known — the first thing Kate will look for. */
  workOrder?: string | null;
  /** Anything else worth having in the message. Nulls are dropped. */
  detail?: Record<string, string | number | boolean | null | undefined>;
};

const LABEL: Record<MaterialsAlertKind, string> = {
  supplier_order_bounced: "Supplier order email bounced",
  supplier_order_send_failed: "Supplier order failed to send",
  color_form_bounced: "Colour form email bounced",
  salesforce_write_rejected: "Salesforce rejected a write",
  alert_delivery_failed: "An alert could not be delivered",
  unexpected_error: "Unexpected failure",
};

/**
 * What actually needs doing about it. A failure notice with no next step gets
 * read once and ignored afterwards.
 */
const NEXT_STEP: Record<MaterialsAlertKind, string> = {
  supplier_order_bounced:
    "The order shows as sent but the vendor never received it. Re-send to a corrected address, then fix the address in Supplier Settings.",
  supplier_order_send_failed:
    "Nothing reached the vendor. The person sending saw the error; nobody else was told. Re-send once the cause is clear.",
  color_form_bounced:
    "The customer never got the form and the job is waiting on colours. Confirm the address and re-send from the work order.",
  salesforce_write_rejected:
    "The hub saved it, Salesforce did not. Check the field and value below — the two are now out of step.",
  alert_delivery_failed:
    "An earlier alert could not be delivered. Check the Slack webhook and the ops email list.",
  unexpected_error: "Check the Vercel logs for this work order for the full trace.",
};

/** Human-readable message body, shared by the Slack and email paths. */
export function buildAlertText(a: MaterialsAlert): string {
  const lines = [`${LABEL[a.kind]} — ${a.summary}`];
  if (a.workOrder) lines.push(`Work order: ${a.workOrder}`);
  for (const [k, v] of Object.entries(a.detail ?? {})) {
    if (v === null || v === undefined || v === "") continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push(`What to do: ${NEXT_STEP[a.kind]}`);
  return lines.join("\n");
}

/** Slack Block Kit payload — the same text, laid out so it scans. */
export function buildSlackPayload(a: MaterialsAlert): Record<string, unknown> {
  const fields = Object.entries(a.detail ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .slice(0, 8)   // Slack rejects a section with more than 10 fields.
    .map(([k, v]) => ({ type: "mrkdwn", text: `*${k}*\n${v}` }));
  if (a.workOrder) fields.unshift({ type: "mrkdwn", text: `*Work order*\n${a.workOrder}` });

  return {
    text: `${LABEL[a.kind]} — ${a.summary}`,   // notification + fallback text
    blocks: [
      { type: "header", text: { type: "plain_text", text: LABEL[a.kind], emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: a.summary } },
      ...(fields.length ? [{ type: "section", fields }] : []),
      { type: "context", elements: [{ type: "mrkdwn", text: `_${NEXT_STEP[a.kind]}_` }] },
    ],
  };
}

/**
 * Light dedup only.
 *
 * Kate asked to start noisy, so this exists purely to stop a retry storm — a
 * webhook Resend re-delivers five times in a second, or a cron looping over a
 * broken batch — turning into five identical Slack posts. A minute is short
 * enough that a genuinely recurring failure keeps reporting.
 */
const DEDUP_MS = 60_000;
const recentlySent = new Map<string, number>();

function seenRecently(key: string): boolean {
  const now = Date.now();
  for (const [k, at] of recentlySent) if (now - at > DEDUP_MS) recentlySent.delete(k);
  if (recentlySent.has(key)) return true;
  recentlySent.set(key, now);
  return false;
}

async function postToSlack(a: MaterialsAlert): Promise<{ ok: boolean; detail: string }> {
  const url = process.env.PPP_MATERIALS_SLACK_WEBHOOK?.trim();
  if (!url) return { ok: false, detail: "PPP_MATERIALS_SLACK_WEBHOOK not set" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSlackPayload(a)),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok
      ? { ok: true, detail: "slack" }
      : { ok: false, detail: `slack returned ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `slack threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function emailFallback(a: MaterialsAlert, why: string): Promise<{ ok: boolean; detail: string }> {
  const to = opsAlertRecipients();
  if (to.length === 0) return { ok: false, detail: "no ops recipients configured" };
  try {
    await sendEmail({
      to,
      subject: `[PPP alert] ${LABEL[a.kind]}${a.workOrder ? ` — WO ${a.workOrder}` : ""}`,
      text: `${buildAlertText(a)}\n\n---\nSent by email because Slack was unavailable (${why}).`,
    });
    return { ok: true, detail: "email" };
  } catch (err) {
    return { ok: false, detail: `email threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Report a materials/paint failure. Safe to call from anywhere, including a
 * catch block that is already handling an error.
 */
export type AlertDelivery = {
  delivered: boolean;
  /** Which channel carried it, or why nothing did. */
  via: "slack" | "email" | "none" | "suppressed";
  detail: string;
};

/**
 * Deliver an alert and SAY which channel carried it.
 *
 * Separate from the fire-and-forget wrapper so the admin test button can report
 * what actually happened. "Sent" with no channel named is the kind of answer
 * that lets a misconfigured webhook look healthy.
 */
export async function deliverMaterialsAlert(
  a: MaterialsAlert,
  opts: { bypassDedup?: boolean } = {}
): Promise<AlertDelivery> {
  console.error(`[materials-alert:${a.kind}] ${a.summary}`, a.workOrder ?? "", a.detail ?? {});
  try {
    if (!opts.bypassDedup) {
      const key = `${a.kind}|${a.workOrder ?? ""}|${a.summary}`;
      if (seenRecently(key)) return { delivered: true, via: "suppressed", detail: "identical alert within 60s" };
    }
    const slack = await postToSlack(a);
    if (slack.ok) return { delivered: true, via: "slack", detail: "posted to the materials channel" };

    const email = await emailFallback(a, slack.detail);
    if (email.ok) {
      console.warn(`[materials-alert] Slack unavailable (${slack.detail}); delivered by email instead.`);
      return { delivered: true, via: "email", detail: `Slack unavailable (${slack.detail}) — emailed ops instead` };
    }

    console.error(
      `[materials-alert:UNDELIVERED] Nobody was told about this failure. slack=${slack.detail}; email=${email.detail}. Original: ${buildAlertText(a)}`
    );
    return { delivered: false, via: "none", detail: `slack: ${slack.detail}; email: ${email.detail}` };
  } catch (err) {
    console.error("[materials-alert] alerting itself threw:", err);
    return { delivered: false, via: "none", detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function alertMaterialsFailure(a: MaterialsAlert): Promise<void> {
  // Fire-and-forget wrapper. Callers in hot paths do not want the result and
  // must never be blocked by a slow Slack round-trip.
  await deliverMaterialsAlert(a);
}
