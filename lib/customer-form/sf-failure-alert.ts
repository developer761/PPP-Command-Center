import "server-only";

import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/resend";

/**
 * "Salesforce rejected this — here's exactly what you entered."
 *
 * Kate round-3 #30: "When Salesforce rejects a write, nothing surfaces it — the
 * Command Center looks like it worked."
 *
 * Three obligations, and the middle one is the point:
 *   1. the person saving is told at the moment it fails (that's the API
 *      response + the form UI, not this file),
 *   2. they get their submission emailed back so the work isn't lost and they
 *      can re-enter it without starting from scratch,
 *   3. Kate and Katie are told it happened.
 *
 * Everything here is best-effort and never throws into the caller: a failed
 * alert must not turn a partial save into a 500 on top of it.
 */

export type EnteredSurface = { surface: string; color: string | null; finish: string | null };
export type EnteredRoom = { room: string; surfaces: EnteredSurface[]; notes?: string | null };

export type SfFailureAlertInput = {
  workOrderId: string;
  workOrderNumber: string | null;
  customerName: string | null;
  /** Who was saving. Null for an anonymous customer submission — then only the
   *  ops recipients are told (we never send a customer a Salesforce error). */
  saverUserId: string | null;
  /** What they entered, so the email is a usable record to re-enter from. */
  entered: EnteredRoom[];
  globalNotes?: string | null;
  attemptedCount: number;
  failedCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  /** "colors" (customer form / internal entry) or "order" (supplier order). */
  kind: "colors" | "order";
};

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

/**
 * Who to tell when a write fails, beyond the person who was saving.
 *
 * Env-driven so PPP can change it without a deploy. Kate asked for herself and
 * Katie; Karan sets PPP_SF_FAILURE_ALERT_EMAILS in Vercel. Empty = nobody, and
 * the alert still reaches the saver.
 */
export function opsAlertRecipients(): string[] {
  return (process.env.PPP_SF_FAILURE_ALERT_EMAILS ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s));
}

async function resolveUserEmail(userId: string): Promise<string | null> {
  try {
    const sb = adminClient();
    const { data } = await sb.from("profiles").select("email").eq("user_id", userId).maybeSingle();
    const fromProfile = (data?.email as string | null)?.toLowerCase() ?? null;
    if (fromProfile) return fromProfile;
    const { data: authUser } = await sb.auth.admin.getUserById(userId);
    return authUser?.user?.email?.toLowerCase() ?? null;
  } catch (err) {
    console.warn("[sf-failure-alert] email lookup failed:", err);
    return null;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The submission, rendered so it can be read and re-typed from the email. */
function renderEntered(rooms: EnteredRoom[], globalNotes?: string | null): string {
  const blocks: string[] = [];
  for (const r of rooms) {
    const rows = r.surfaces
      .filter((s) => s.color || s.finish)
      .map(
        (s) =>
          `<tr><td style="padding:2px 10px 2px 0;color:#5b6b7c">${esc(s.surface)}</td>` +
          `<td style="padding:2px 0;color:#172B4D">${esc(s.color ?? "—")}${
            s.finish ? ` <span style="color:#5b6b7c">· ${esc(s.finish)}</span>` : ""
          }</td></tr>`
      )
      .join("");
    if (!rows && !r.notes) continue;
    blocks.push(
      `<div style="margin:0 0 14px 0"><div style="font-weight:600;color:#172B4D">${esc(r.room)}</div>` +
        (rows ? `<table style="border-collapse:collapse;font-size:13px;margin-top:4px">${rows}</table>` : "") +
        (r.notes ? `<div style="font-size:13px;color:#5b6b7c;margin-top:4px">Notes: ${esc(r.notes)}</div>` : "") +
        `</div>`
    );
  }
  if (globalNotes?.trim()) {
    blocks.push(
      `<div style="margin:0 0 14px 0"><div style="font-weight:600;color:#172B4D">Project notes</div>` +
        `<div style="font-size:13px;color:#5b6b7c;margin-top:4px">${esc(globalNotes.trim())}</div></div>`
    );
  }
  return blocks.join("") || `<div style="font-size:13px;color:#5b6b7c">(nothing recorded)</div>`;
}

export async function alertSalesforceWriteFailure(input: SfFailureAlertInput): Promise<void> {
  try {
    const saverEmail = input.saverUserId ? await resolveUserEmail(input.saverUserId) : null;
    const ops = opsAlertRecipients();
    const to = [...new Set([saverEmail, ...ops].filter((e): e is string => !!e))];
    if (to.length === 0) {
      console.warn(
        "[sf-failure-alert] nobody to tell — set PPP_SF_FAILURE_ALERT_EMAILS so Salesforce rejections don't go unnoticed"
      );
      return;
    }

    const woLabel = input.workOrderNumber ? `WO #${input.workOrderNumber}` : input.workOrderId.slice(-6);
    const customer = input.customerName?.trim() || "this customer";
    const noun = input.kind === "order" ? "materials order" : "colors";
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "https://hub.precisionpaintingplus.net";
    const woUrl = `${baseUrl}/dashboard/materials/${encodeURIComponent(input.workOrderId)}`;

    const html = `
<div style="font-family:Roboto,Helvetica,Arial,sans-serif;max-width:640px;color:#172B4D">
  <div style="background:#FDECE6;border:1px solid #F5C2AE;border-radius:10px;padding:14px 16px;margin-bottom:18px">
    <div style="font-weight:700;color:#B8420F">Salesforce didn&rsquo;t accept this ${esc(noun)} entry</div>
    <div style="font-size:13px;color:#B8420F;margin-top:4px">
      ${input.failedCount} of ${input.attemptedCount} write${input.attemptedCount === 1 ? "" : "s"} were rejected for ${esc(customer)} (${esc(woLabel)}).
      It is saved in the Command Center, but Salesforce does not have it.
    </div>
  </div>

  <p style="font-size:14px;line-height:1.5">
    Everything that was entered is below so nothing is lost — you can re-enter it
    without starting from scratch.
  </p>

  <div style="border:1px solid #E3E8EE;border-radius:10px;padding:14px 16px;margin:16px 0">
    ${renderEntered(input.entered, input.globalNotes)}
  </div>

  <div style="font-size:12px;color:#5b6b7c;border-top:1px solid #E3E8EE;padding-top:12px">
    <div><strong>What Salesforce said:</strong> ${esc(input.errorCode ?? "UNKNOWN")} — ${esc(input.errorMessage ?? "(no message)")}</div>
    <div style="margin-top:6px">
      Common causes: the integration user is missing Edit permission, Field Service Lightning
      has the record locked, or a validation rule is blocking the update.
    </div>
  </div>

  <p style="margin-top:18px">
    <a href="${woUrl}" style="background:#2BAAE1;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600;font-size:14px;display:inline-block">
      Open the work order
    </a>
  </p>
</div>`.trim();

    const text = [
      `Salesforce didn't accept this ${noun} entry.`,
      `${input.failedCount} of ${input.attemptedCount} writes rejected — ${customer} (${woLabel}).`,
      `Saved in the Command Center, but NOT in Salesforce.`,
      ``,
      `What Salesforce said: ${input.errorCode ?? "UNKNOWN"} — ${input.errorMessage ?? "(no message)"}`,
      ``,
      `What was entered:`,
      ...input.entered.flatMap((r) => [
        `  ${r.room}`,
        ...r.surfaces
          .filter((s) => s.color || s.finish)
          .map((s) => `    ${s.surface}: ${s.color ?? "—"}${s.finish ? ` · ${s.finish}` : ""}`),
        ...(r.notes ? [`    Notes: ${r.notes}`] : []),
      ]),
      ...(input.globalNotes?.trim() ? [``, `Project notes: ${input.globalNotes.trim()}`] : []),
      ``,
      woUrl,
    ].join("\n");

    await sendEmail({
      to,
      subject: `⚠ Salesforce rejected ${noun} for ${customer} — ${woLabel}`,
      html,
      text,
    });
  } catch (err) {
    // Never let the alert break the request that triggered it.
    console.error("[sf-failure-alert] could not send:", err);
  }
}
