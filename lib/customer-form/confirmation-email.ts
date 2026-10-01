import { receiptSurfaceText, type ReceiptRoom } from "@/lib/customer-form/receipt-lines";
import type { Templates } from "@/lib/customer-form/templates";

/**
 * The customer's receipt email, as a document.
 *
 * Separated from the sending (lib/email/resend.ts) on purpose: that module is
 * `server-only` and talks to Resend, so nothing in it can be rendered by the
 * suite. This file is pure — templates and data in, `{subject, text, html}`
 * out — which is the only way to test the thing that actually reaches the
 * customer rather than the code that builds it. The repo has been bitten
 * before by green tests over an unrendered document.
 *
 * House style is PPP's standard transactional shell (Tahoma 10pt, orange
 * #d35400, the Salesforce-hosted logo), matching the invite email so the
 * receipt doesn't look like it came from somewhere else.
 */

/** Values here cross our boundary into a third-party email body, so escape
 *  defensively even though they originate in Salesforce. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type ConfirmationEmail = { subject: string; text: string; html: string };

export function buildConfirmationEmail(input: {
  templates: Pick<Templates, "confirm_subject" | "confirm_intro" | "confirm_outro" | "email_signoff">;
  /** Already-rendered variable map from buildVars(). */
  vars: Record<string, string>;
  render: (template: string, vars: Record<string, string | null | undefined>) => string;
  rooms: ReadonlyArray<ReceiptRoom>;
  globalNotes?: string | null;
  isReedit?: boolean;
  formUrl: string;
  senderName?: string | null;
}): ConfirmationEmail {
  const { templates, vars, render, rooms } = input;

  const firstName = (vars.customer_name ?? "").trim().split(/\s+/)[0] ?? "";
  const greeting = firstName ? `Hi ${firstName},` : "Hi there,";
  const subject = render(templates.confirm_subject, vars);
  const intro = render(templates.confirm_intro, vars);
  const outro = render(templates.confirm_outro, vars);
  const signoff = render(templates.email_signoff, vars);
  const updatedLine = input.isReedit
    ? "This replaces what you sent us before — these are your current selections."
    : null;
  const globalNotes = (input.globalNotes ?? "").trim() || null;

  // ── plain text ────────────────────────────────────────────────────────────
  const textRooms: string[] = [];
  for (const room of rooms) {
    textRooms.push(room.room.toUpperCase());
    for (const s of room.surfaces) textRooms.push(`  ${s.surface}: ${receiptSurfaceText(s)}`);
    if (room.notes) textRooms.push(`  Your note: ${room.notes}`);
    textRooms.push("");
  }
  const text = [
    greeting,
    "",
    intro,
    ...(updatedLine ? ["", updatedLine] : []),
    "",
    ...textRooms,
    ...(globalNotes ? [`Your notes for the team: ${globalNotes}`, ""] : []),
    "Review or update your colors:",
    input.formUrl,
    "",
    outro,
    "",
    signoff,
  ].join("\n");

  // ── html ──────────────────────────────────────────────────────────────────
  const escName = firstName ? escapeHtml(firstName) : "there";
  const escUrl = encodeURI(input.formUrl);
  const roomsHtml = rooms
    .map((room) => {
      const surfaceRows = room.surfaces
        .map((s) => {
          const value = escapeHtml(receiptSurfaceText(s));
          // Greyed + italic when there is nothing chosen, so a glance down the
          // column separates answered from unanswered without reading it all.
          const muted = s.skipped || !s.colorName;
          const valueStyle = muted ? "color:#777; font-style:italic;" : "color:#333;";
          return `<tr>
              <td style="padding:4px 10px 4px 0; font-size:9pt; color:#777; white-space:nowrap; vertical-align:top;">${escapeHtml(s.surface)}</td>
              <td style="padding:4px 0; font-size:10pt; ${valueStyle}">${value}</td>
            </tr>`;
        })
        .join("\n");
      const noteRow = room.notes
        ? `<tr><td colspan="2" style="padding:6px 0 0 0; font-size:9pt; color:#555;"><em>Your note: ${escapeHtml(room.notes)}</em></td></tr>`
        : "";
      return `<table border="0" cellpadding="0" cellspacing="0" style="width:100%; margin:0 0 14px 0;">
        <tbody>
          <tr><td colspan="2" style="padding:0 0 4px 0; font-size:10pt; font-weight:bold; color:#333; border-bottom:1px solid #ddd;">${escapeHtml(room.room)}</td></tr>
          ${surfaceRows}
          ${noteRow}
        </tbody>
      </table>`;
    })
    .join("\n");

  const notesBlock = globalNotes
    ? `<tr><td style="padding:0 20px 10px 20px;"><p style="margin:0 0 4px 0; font-size:9pt; color:#777;">Your notes for the team</p><p style="margin:0; font-size:10pt; color:#333;">${escapeHtml(globalNotes)}</p></td></tr>`
    : "";
  const escWo = (vars.wo_number ?? "").trim() ? escapeHtml(vars.wo_number) : "";
  const woBlock = escWo
    ? `<strong>Work Order:</strong> #${escWo}<br/>\n                <strong>Status:</strong> <span style="color:#27772f;">Color selections received</span>`
    : `<strong>Status:</strong> <span style="color:#27772f;">Color selections received</span>`;

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
        <p style="margin:0 0 12px 0;">${escapeHtml(intro)}</p>
        ${updatedLine ? `<p style="margin:0 0 12px 0; font-size:9pt; color:#777;"><em>${escapeHtml(updatedLine)}</em></p>` : ""}
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
      <td style="padding:15px 20px 0 20px;">
        ${roomsHtml}
      </td>
    </tr>
    ${notesBlock}
    <tr>
      <td style="padding:10px 20px 10px 20px; text-align:center;">
        <a href="${escUrl}" target="_blank" style="display:inline-block; padding:12px 28px; background-color:#d35400; color:#ffffff; text-decoration:none; font-weight:bold; font-size:11pt; border-radius:4px;">Review or Update Your Colors</a>
      </td>
    </tr>
    <tr>
      <td style="padding:10px 20px;">
        ${outro
          .split(/\n{2,}/)
          .map((p) => `<p style="margin:0 0 12px 0;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
          .join("\n        ")}
      </td>
    </tr>
    <tr>
      <td style="padding:10px 20px 20px 20px; border-top:1px solid #ddd;">
        <p style="margin:0 0 4px 0;">Thank you,</p>
        ${input.senderName ? `<p style="margin:0 0 2px 0; font-weight:bold; color:#333;">${escapeHtml(input.senderName)}</p>` : ""}
        <p style="margin:0; font-weight:bold; color:#d35400;">Precision Painting Plus</p>
        <p style="margin:8px 0 0 0; font-size:9pt; color:#777;">
          825 East Gate Blvd, Ste 310, Garden City, NY 11530<br/>
          <a href="https://www.precisionpaintingplus.com" style="color:#d35400; text-decoration:none;">precisionpaintingplus.com</a>
        </p>
      </td>
    </tr>
  </tbody>
</table>`;

  return { subject, text, html };
}
