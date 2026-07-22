import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId } from "@/lib/auth/profile";
import { isAdminEmail } from "@/lib/auth/admin";
import { capabilitiesFor, normalizeRole } from "@/lib/auth/roles";
import { createToken } from "@/lib/customer-form/tokens";
import { loadFormRenderData } from "@/lib/customer-form/render-data";

/**
 * Admin "Preview Color Form" handler.
 *
 *   POST /api/admin/customer-form/preview
 *   body: { workOrderId: string }
 *
 * Creates a kind="preview" token so admin can open the form WITHOUT
 * sending an email to the customer or polluting Mail Hub stats. The
 * preview token:
 *   - Doesn't get an invite email
 *   - Doesn't show up in Mail Hub Sent (filtered by kind)
 *   - Skips SF writeback on submit (the customer form view also
 *     refuses to actually submit in preview mode)
 *   - Expires in 24 hours
 *   - Can be visited / "submitted" multiple times — the preview lets
 *     admin click around without consequences
 *
 * Returns { ok, token, formUrl } so the caller can open the URL.
 *
 * Admin-only.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const profile = await getProfileByUserId(data.user.id);
  // Admins + Account Managers can enter/preview customer colors.
  const role = normalizeRole(profile?.role, profile?.is_admin ?? isAdminEmail(data.user.email));
  if (!capabilitiesFor(role).canEnterColors) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { workOrderId?: string; internal?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const workOrderId = body.workOrderId?.trim();
  if (!workOrderId || !/^0WO/.test(workOrderId)) {
    return NextResponse.json({ error: "invalid_work_order_id" }, { status: 400 });
  }

  // Internal Entry (Kate #4): staff enter colors on the customer's behalf and
  // it SAVES (unlike a preview, which no-ops). Same form, different token kind.
  const isInternal = body.internal === true;

  // Confirm the WO exists in SF (so admin doesn't get a 404 page on open).
  const wo = await loadFormRenderData(workOrderId);
  if (!wo) {
    return NextResponse.json({ error: "wo_not_found_in_sf" }, { status: 404 });
  }

  // Use the admin's own email as customer_email so the token row is well-
  // formed (NOT NULL constraint) without leaking a real customer's address.
  // Customer name shows the admin's own name + "[Preview]" marker so it's
  // obvious in the audit log this isn't a real send.
  const tokenResult = await createToken({
    work_order_id: workOrderId,
    work_order_number: wo.workOrderNumber,
    customer_email: (data.user.email ?? "preview@precisionpaintingplus.com").toLowerCase(),
    customer_name: `[${isInternal ? "Internal Entry" : "Preview"}] ${data.user.email ?? "admin"}`,
    created_by_user_id: data.user.id,
    // Internal entries get a longer window (staff may come back to finish);
    // previews are throwaway QA links.
    expiresAt: new Date(
      Date.now() + (isInternal ? 7 * 24 : 24) * 60 * 60 * 1000
    ).toISOString(),
    kind: isInternal ? "internal" : "preview",
  });
  if ("error" in tokenResult) {
    return NextResponse.json({ error: "token_create_failed", message: tokenResult.error }, { status: 500 });
  }
  const token = tokenResult.token;

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    new URL(request.url).origin;
  const formUrl = `${baseUrl}/select/${token}`;

  return NextResponse.json({
    ok: true,
    token,
    formUrl,
    workOrderNumber: wo.workOrderNumber,
    expiresIn: "24 hours",
  });
}
