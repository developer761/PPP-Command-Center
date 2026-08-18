import "server-only";

import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { getOpenInvoiceStatementForAccount } from "./statement";
import { formatCentsFull } from "./format";

/**
 * Email the AR statement to a GC (Katie).
 *
 * The statement PDF has existed as a download since Phase 1C, but chasing
 * money is the job — and doing it meant downloading the PDF, opening a mail
 * client, and attaching it by hand, every time, for every GC. Invoices and
 * proposals both send from inside the platform; the one document whose entire
 * purpose is to get paid did not.
 *
 * Mirrors emailInvoiceToGc exactly: human-reviewed (recipient, subject and
 * message all come from a form — nothing auto-sends), From is the operating
 * company over the commercial sending address, and Brendan + ops are the
 * Reply-To and a silent BCC so a GC's reply reaches someone.
 *
 * Read-only: unlike an invoice send, this changes no record state. A statement
 * is a summary of what already exists, so re-sending is always safe.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Same internal copy list as invoices + proposals. Env-overridable. */
const STATEMENT_COPY_EMAILS = (
  process.env.COMMERCIAL_INVOICE_COPY_EMAILS ||
  process.env.COMMERCIAL_PROPOSAL_COPY_EMAILS ||
  "brendan@tomcopainting.com,developer@precisionpaintingplus.net"
)
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter((e) => EMAIL_RE.test(e));

export type EmailStatementInput = {
  account_id: string;
  actor_user_id: string;
  to_email: string;
  cc_email?: string | null;
  subject: string;
  message: string;
};

export type EmailStatementResult =
  | { ok: true; to_email: string }
  | { ok: false; error: string };

export async function emailStatementToGc(
  input: EmailStatementInput
): Promise<EmailStatementResult> {
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

  const account = await getCommercialAccount(input.account_id);
  if (!account) return { ok: false, error: "That GC no longer exists." };

  const statement = await getOpenInvoiceStatementForAccount(input.account_id);
  // Nothing due AND nothing held back = there is no statement to send, and
  // emailing a GC a $0 demand is a good way to look disorganised.
  if (statement.totalOutstandingCents <= 0 && statement.retainageHeldCents <= 0) {
    return { ok: false, error: "Nothing is outstanding for this GC — there's no statement to send." };
  }

  const billTo = [
    account.billing_street,
    account.billing_street2,
    [account.billing_city, account.billing_state, account.billing_zip]
      .filter(Boolean)
      .join(", ")
      .replace(/, ([^,]+)$/, " $1"),
  ].filter((l): l is string => !!l && l.trim().length > 0);

  const oc = await getOperatingCompany();

  let pdf: Buffer;
  try {
    const { renderARStatementPdf } = await import("./statement-pdf");
    const { getBrandLogoBuffer } = await import("@/lib/commercial/operating-company/assets");
    pdf = await renderARStatementPdf({
      statement,
      accountName: account.company_name,
      billTo,
      company: { name: oc.name, phone: oc.phone, website: oc.website },
      logo: await getBrandLogoBuffer(),
    });
  } catch (err) {
    console.error("[emailStatementToGc] render failed:", err);
    return { ok: false, error: "The statement PDF couldn't be generated, so nothing was sent." };
  }

  const safeName = account.company_name.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40) || "Account";
  const fromAddr =
    process.env.COMMERCIAL_RESEND_FROM_ADDRESS || process.env.RESEND_FROM_ADDRESS;
  const from = fromAddr ? `${oc.name} <${fromAddr}>` : undefined;
  const replyTo = STATEMENT_COPY_EMAILS.length > 0 ? STATEMENT_COPY_EMAILS : oc.email || undefined;
  const bcc = STATEMENT_COPY_EMAILS.filter((e) => e !== toEmail && e !== ccEmail);

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
    attachments: [{ filename: `${safeName}_Statement.pdf`, content: pdf }],
    tags: [
      { name: "kind", value: "ar_statement" },
      { name: "account", value: input.account_id },
    ],
  });
  if (!r.ok) return { ok: false, error: `The statement didn't go out: ${r.error}` };

  return { ok: true, to_email: toEmail };
}

/**
 * The default message body. Retainage gets its own sentence when there is any:
 * the total says what's payable now, and a GC reading "you owe $0" on a job
 * where we're holding out for $40k of retainage would reasonably think the
 * platform had lost track of it.
 */
export function defaultStatementMessage(input: {
  companyName: string;
  totalOutstandingCents: number;
  retainageHeldCents: number;
  invoiceCount: number;
}): string {
  const lines = [
    "Hello,",
    "",
    input.totalOutstandingCents > 0
      ? `Attached is a current statement of account for ${input.companyName}. The balance currently due is ${formatCentsFull(input.totalOutstandingCents)} across ${input.invoiceCount} open item${input.invoiceCount === 1 ? "" : "s"}.`
      : `Attached is a current statement of account for ${input.companyName}. Nothing is currently due.`,
  ];
  if (input.retainageHeldCents > 0) {
    lines.push(
      "",
      `This does not include ${formatCentsFull(input.retainageHeldCents)} of retainage, which is released at close-out.`
    );
  }
  lines.push("", "Please reply with any questions.", "", "Thank you.");
  return lines.join("\n");
}
