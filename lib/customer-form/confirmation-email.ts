import {
  receiptSurfaceText,
  receiptColorText,
  receiptColorCode,
  receiptFinishText,
  type ReceiptRoom,
} from "@/lib/customer-form/receipt-lines";
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

/**
 * A customer's note, with its line breaks intact.
 *
 * Kate FU.8 (2026-10-15): "the text isn't easily skimmable by the customer,
 * needs breaks between rooms."
 *
 * On a multi-room line the customer answers into a template —
 *
 *     Living Room:
 *     Walls: Carter Plum CW-355
 *
 *     Dining Room:
 *     Walls: 01 White
 *
 * — and this went through escapeHtml alone, so HTML collapsed every newline
 * and the email showed one unreadable run-on: "Living Room: Walls: Carter
 * Plum CW-355 Dining Room: Walls: 01 White". The plain-text half of the same
 * email was fine, which is why it was easy to miss.
 *
 * Escape FIRST, then add the markup, so the breaks cannot be forged by a
 * customer typing tags into the box.
 */
function noteHtml(note: string): string {
  return escapeHtml(note)
    .replace(/\r\n/g, "\n")
    // A blank line between rooms becomes real vertical space; a single
    // newline inside a room becomes a plain line break.
    .replace(/\n{2,}/g, '</div><div style="margin-top:7px;">')
    .replace(/\n/g, "<br />")
    .replace(/^/, '<div>')
    .replace(/$/, "</div>");
}

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
  /**
   * Marks the email as a staff preview rather than a real receipt.
   *
   * Rendered as a strip across the top, NOT woven into the content. The first
   * version of the admin preview tagged the sample ROOM names instead
   * ("[TEST 12:40 PM] Interior Painting · Bathroom"), and the moment Karan
   * forwarded one to Katie her first question was what that text was — which
   * is the right question to ask about a receipt, and exactly the wrong thing
   * for a sample to make somebody wonder. A preview should look like the real
   * document everywhere except where it says it is a preview.
   */
  previewNotice?: string | null;
  /** Overrides the templated subject — used to prefix "[TEST]" on previews. */
  subjectOverride?: string | null;
}): ConfirmationEmail {
  const { templates, vars, render, rooms } = input;

  const firstName = (vars.customer_name ?? "").trim().split(/\s+/)[0] ?? "";
  const greeting = firstName ? `Hi ${firstName},` : "Hi there,";
  const subject = input.subjectOverride ?? render(templates.confirm_subject, vars);
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
    // Kate FU.8 — a multi-room line never showed the customer a surface
    // picker, so every surface on it reads "No color chosen yet". Printing a
    // question nobody was asked is what made this unskimmable; their own
    // note below is the actual answer.
    if (!room.multiRoom) {
      for (const s of room.surfaces) textRooms.push(`  ${s.surface}: ${receiptSurfaceText(s)}`);
    }
    if (room.notes) textRooms.push(`  Your note: ${room.notes}`);
    textRooms.push("");
  }
  const previewNotice = (input.previewNotice ?? "").trim() || null;
  const text = [
    ...(previewNotice ? [previewNotice.toUpperCase(), ""] : []),
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
  // ONE itemised table for the whole job, the way a receipt is laid out: a
  // shaded room band, then Surface / Color / Finish in fixed columns. Built
  // from <table> and inline styles only — Outlook and Gmail both ignore
  // flexbox and most <style> blocks, so a "nicer" layout is a broken one.
  const COL = {
    surface: "padding:7px 10px; font-size:9.5pt; color:#555; vertical-align:top; width:28%; border-bottom:1px solid #eee;",
    color: "padding:7px 10px; font-size:10pt; vertical-align:top; border-bottom:1px solid #eee;",
    finish: "padding:7px 10px; font-size:10pt; vertical-align:top; width:24%; white-space:nowrap; border-bottom:1px solid #eee;",
  };

  const roomBlocks = rooms
    .map((room) => {
      // Kate FU.8 — see the plain-text branch above. Same rule, so the two
      // halves of the same email cannot disagree about what the customer
      // was asked.
      const surfaceRows = (room.multiRoom ? [] : room.surfaces)
        .map((s) => {
          const unanswered = s.skipped || !s.colorName;
          const colorText = escapeHtml(receiptColorText(s));
          const code = receiptColorCode(s);
          const finish = receiptFinishText(s);
          // Gray italic for anything nobody answered, so one glance down the
          // column separates chosen from not-chosen.
          const colorCell = unanswered
            ? `<span style="color:#888; font-style:italic;">${colorText}</span>`
            : `${colorText}${code ? `<span style="color:#888;"> ${escapeHtml(code)}</span>` : ""}`;
          const finishCell = !finish
            ? ""
            : finish === "Not chosen"
              ? `<span style="color:#b55b1e; font-style:italic;">Not chosen</span>`
              : escapeHtml(finish);
          return `<tr>
                <td style="${COL.surface}">${escapeHtml(s.surface)}</td>
                <td style="${COL.color}">${colorCell}</td>
                <td style="${COL.finish}">${finishCell}</td>
              </tr>`;
        })
        .join("\n");
      const noteRow = room.notes
        ? `<tr><td colspan="3" style="padding:6px 10px 8px 10px; font-size:9pt; color:#666; border-bottom:1px solid #eee;"><em>Note: ${noteHtml(room.notes)}</em></td></tr>`
        : "";
      return `<tr><td colspan="3" style="padding:9px 10px 8px 10px; font-size:9.5pt; font-weight:bold; color:#333; background:#f5f5f5; border-bottom:1px solid #e0e0e0;">${escapeHtml(room.room)}</td></tr>
          ${surfaceRows}
          ${noteRow}`;
    })
    .join("\n");

  // A notes-only submission has no color rows, and this used to render the
  // table anyway: three column headings — SURFACE / COLOR / FINISH — over
  // nothing, beneath a green "Color selections received". Both halves were
  // wrong at once, and the reader is a customer who had just told us they
  // were not ready to pick yet.
  const hasAnyColors = rooms.some((r) => r.surfaces.some((s) => s.colorName || s.skipped));
  /**
   * Anything worth printing — a color, a deliberate skip, OR a note.
   *
   * The table used to be gated on `hasAnyColors` alone, and the per-room
   * notes live inside it. On a multi-room job the customer answers ENTIRELY
   * in notes and picks no surface colors at all, so the whole table was
   * dropped and the HTML receipt arrived with none of their answers in it.
   * The plain-text half had them the whole time, which is why nobody saw it:
   * mail clients show the HTML.
   *
   * Found while implementing Kate's FU.8, which is about this same email.
   * The LABEL still keys off real colors — "Notes received" is the honest
   * heading when that is what we got.
   */
  const hasAnythingToShow =
    hasAnyColors || rooms.some((r) => (r.notes ?? "").trim().length > 0);

  const roomsHtml = !hasAnythingToShow ? "" : `<table border="0" cellpadding="0" cellspacing="0" style="width:100%; border:1px solid #e0e0e0; border-collapse:collapse;">
        <tbody>
          <tr>
            <th align="left" style="padding:6px 10px; font-size:8pt; letter-spacing:0.06em; text-transform:uppercase; color:#888; font-weight:bold; border-bottom:1px solid #e0e0e0;">Surface</th>
            <th align="left" style="padding:6px 10px; font-size:8pt; letter-spacing:0.06em; text-transform:uppercase; color:#888; font-weight:bold; border-bottom:1px solid #e0e0e0;">Color</th>
            <th align="left" style="padding:6px 10px; font-size:8pt; letter-spacing:0.06em; text-transform:uppercase; color:#888; font-weight:bold; border-bottom:1px solid #e0e0e0;">Finish</th>
          </tr>
          ${roomBlocks}
        </tbody>
      </table>`;

  const notesBlock = globalNotes
    ? `<tr><td style="padding:14px 20px 0 20px;"><p style="margin:0 0 3px 0; font-size:8pt; letter-spacing:0.06em; text-transform:uppercase; color:#888; font-weight:bold;">Your notes for the team</p><p style="margin:0; font-size:10pt; color:#333;">${escapeHtml(globalNotes)}</p></td></tr>`
    : "";
  const escWo = (vars.wo_number ?? "").trim() ? escapeHtml(vars.wo_number) : "";
  // One line, not a two-line box. The old version repeated "Work Order" and
  // "Status" as a stacked block that competed with the table underneath it.
  // Say what actually arrived. "Color selections received" over a notes-only
  // submission tells the customer we have something we do not have.
  const receivedLabel = hasAnyColors ? "Color selections received" : "Notes received";
  const woBlock = escWo
    ? `Work Order <strong>#${escWo}</strong> &nbsp;·&nbsp; <span style="color:#27772f; font-weight:bold;">${receivedLabel}</span>`
    : `<span style="color:#27772f; font-weight:bold;">${receivedLabel}</span>`;

  const html = `<table border="0" cellpadding="0" cellspacing="0" style="width:600px; font-family:tahoma,geneva,sans-serif; font-size:10pt; line-height:1.5; color:#333;">
  <tbody>
    <tr>
      <td style="padding:20px 20px 10px 20px; text-align:center;">
        <img alt="Precision Painting Plus" src="https://precisionplus.file.force.com/servlet/servlet.ImageServer?id=0156g000003hGa2AAE&amp;oid=00D6g000001XvD9EAK" width="200" height="55" />
      </td>
    </tr>
    ${previewNotice ? `<tr>
      <td style="padding:0 20px 10px 20px;">
        <table border="0" cellpadding="8" cellspacing="0" style="width:100%; background:#fff6e5; border:1px solid #f0d9a8;">
          <tbody><tr><td style="font-size:9pt; color:#8a5a00;"><strong>Preview.</strong> ${escapeHtml(previewNotice)}</td></tr></tbody>
        </table>
      </td>
    </tr>` : ""}
    <tr>
      <td style="padding:15px 20px 5px 20px;">
        <p style="margin:0 0 12px 0;">Hi ${escName},</p>
        <p style="margin:0 0 12px 0;">${escapeHtml(intro)}</p>
        ${updatedLine ? `<p style="margin:0 0 12px 0; font-size:9pt; color:#777;"><em>${escapeHtml(updatedLine)}</em></p>` : ""}
      </td>
    </tr>
    <tr>
      <td style="padding:0 20px 12px 20px; font-size:9pt; color:#555;">
        ${woBlock}
      </td>
    </tr>
    <tr>
      <td style="padding:0 20px;">
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
