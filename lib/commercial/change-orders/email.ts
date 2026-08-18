import "server-only";

import { commercialDb } from "@/lib/commercial/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { formatChangeOrderNumber } from "./constants";
import { formatCentsFull } from "@/lib/commercial/invoices/format";

/**
 * Email a change order to the GC for written approval.
 *
 * Stephanie, 2026-08-18: *"A change order is an addition to the contract,
 * however it requires us to first submit it in writing in proposal format and
 * then an approval from the customer."*
 *
 * The document already existed and is already the right shape — scope, dollar
 * impact, revised contract sum, the contractor's signature and an
 * "Accepted by (Owner / GC)" line. What was missing was the middle step of her
 * sentence: actually sending it. A CO could be created, printed and marked
 * approved, but the platform had no way to put it in front of the customer, so
 * that step happened in someone's mail client and left no trace on the job.
 *
 * Mirrors emailProposalToGc / emailInvoiceToGc / emailStatementToGc exactly:
 * human-reviewed (recipient, subject and message all come from a form; nothing
 * auto-sends), From is the operating company, and Brendan + ops are the
 * Reply-To and a silent BCC so a reply reaches somebody.
 *
 * Sending does NOT approve the CO. It stamps `sent_at` so the list can show
 * what's out and waiting; the status still moves to approved only when a person
 * records the customer's answer. Getting that backwards would let an unanswered
 * change order count toward the contract.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CO_COPY_EMAILS = (
  process.env.COMMERCIAL_INVOICE_COPY_EMAILS ||
  process.env.COMMERCIAL_PROPOSAL_COPY_EMAILS ||
  "brendan@tomcopainting.com,developer@precisionpaintingplus.net"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter((e) => EMAIL_RE.test(e));

export type EmailChangeOrderInput = {
  change_order_id: string;
  actor_user_id: string;
  to_email: string;
  cc_email?: string | null;
  subject: string;
  message: string;
};

export type EmailChangeOrderResult =
  | { ok: true; to_email: string }
  | { ok: false; error: string };

export async function emailChangeOrderToGc(
  input: EmailChangeOrderInput
): Promise<EmailChangeOrderResult> {
  const toEmail = (input.to_email ?? "").trim().toLowerCase();
  const ccEmail = (input.cc_email ?? "").trim().toLowerCase() || null;
  const subject = (input.subject ?? "").trim();
  const message = (input.message ?? "").trim();

  if (!EMAIL_RE.test(toEmail)) {
    return { ok: false, error: "That recipient address doesn't look like an email." };
  }
  if (ccEmail && !EMAIL_RE.test(ccEmail)) {
    return { ok: false, error: "That CC address doesn't look like an email." };
  }
  if (!subject) return { ok: false, error: "Give the email a subject." };
  if (!message) return { ok: false, error: "Write a short message to go with it." };

  const sb = commercialDb();
  const { data: co } = await sb
    .from("commercial_change_orders")
    .select("id, co_number, title, amount_cents, status, opportunity_id, deleted_at")
    .eq("id", input.change_order_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!co) return { ok: false, error: "That change order no longer exists." };

  const row = co as {
    id: string;
    co_number: number | null;
    title: string | null;
    amount_cents: number;
    status: string;
  };
  // A declined CO shouldn't be re-sent for approval — re-open or raise a new one.
  if (row.status === "declined") {
    return {
      ok: false,
      error: "This change order was declined. Raise a new one rather than re-sending this.",
    };
  }

  let pdf: Buffer;
  let fileBase = "ChangeOrder";
  try {
    const { buildChangeOrderPdfInput } = await import("./pdf-data");
    const built = await buildChangeOrderPdfInput(input.change_order_id);
    if (!built.ok) {
      return { ok: false, error: "That change order's deal or GC no longer exists." };
    }
    const { renderChangeOrderPdf } = await import("./pdf");
    pdf = await renderChangeOrderPdf(built.input);
    fileBase = built.fileBase;
  } catch (err) {
    console.error("[emailChangeOrderToGc] render failed:", err);
    return { ok: false, error: "The change-order PDF couldn't be generated, so nothing was sent." };
  }

  const oc = await getOperatingCompany();
  const fromAddr =
    process.env.COMMERCIAL_RESEND_FROM_ADDRESS || process.env.RESEND_FROM_ADDRESS;
  const from = fromAddr ? `${oc.name} <${fromAddr}>` : undefined;
  const replyTo = CO_COPY_EMAILS.length > 0 ? CO_COPY_EMAILS : oc.email || undefined;
  const bcc = CO_COPY_EMAILS.filter((e) => e !== toEmail && e !== ccEmail);
  const coNo = row.co_number != null ? formatChangeOrderNumber(row.co_number) : "Change Order";

  const { sendEmail } = await import("@/lib/email/resend");
  const r = await sendEmail({
    channel: "commercial",
    to: toEmail,
    ...(ccEmail ? { cc: ccEmail } : {}),
    subject,
    text: message,
    ...(from ? { from } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    attachments: [{ filename: `ChangeOrder_${fileBase}.pdf`, content: pdf }],
    tags: [
      { name: "kind", value: "change_order_to_gc" },
      { name: "change_order", value: input.change_order_id },
    ],
  });
  if (!r.ok) return { ok: false, error: `The change order didn't go out: ${r.error}` };

  // Stamp that it's out and awaiting an answer. Best-effort: the email has
  // already gone, so a failed stamp must not report the send as failed.
  const { error: stampErr } = await sb
    .from("commercial_change_orders")
    .update({ sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", input.change_order_id);
  if (stampErr) {
    console.warn(
      `[emailChangeOrderToGc] sent but sent_at stamp failed for ${input.change_order_id}: ${stampErr.message}`
    );
  }

  return { ok: true, to_email: toEmail };
}

/** Default body. Names the amount and asks for the one thing we need back. */
export function defaultChangeOrderMessage(input: {
  coNumber: number | null;
  title: string | null;
  amountCents: number;
  projectName: string | null;
}): string {
  const coNo =
    input.coNumber != null ? formatChangeOrderNumber(input.coNumber) : "the attached change order";
  const signed =
    input.amountCents < 0
      ? `a credit of ${formatCentsFull(Math.abs(input.amountCents))}`
      : formatCentsFull(input.amountCents);
  return [
    "Hello,",
    "",
    `Attached is ${coNo}${input.projectName ? ` for ${input.projectName}` : ""}${
      input.title ? ` — ${input.title}` : ""
    }, in the amount of ${signed}.`,
    "",
    "Please review, sign the acceptance block at the bottom, and return a copy so we can schedule the work. We won't proceed with it until we have your written approval.",
    "",
    "Please reply with any questions.",
    "",
    "Thank you.",
  ].join("\n");
}
