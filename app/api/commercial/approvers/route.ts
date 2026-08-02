import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rawAccessDenied } from "@/lib/commercial/auth";
import { isAdminEmail, normalizeEmail } from "@/lib/auth/admin";
import { getCommercialRoles } from "@/lib/commercial/rbac";
import {
  getOperatingCompany,
  updateOperatingCompany,
} from "@/lib/commercial/operating-company/db";

/**
 * POST /api/commercial/approvers  — toggle who (besides admins) can approve
 * proposals. Admin-only. Body: { email: string, make: boolean }.
 *
 * The approver list lives on the operating-company singleton
 * (`approver_emails`); admins can always approve regardless of the list, so
 * the UI never lets you toggle an admin off. Returns the updated list.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Admin gate — same signal as the approver check itself: env/bootstrap admin
  // OR the Commercial "admin" role. Non-admins can't change who approves.
  const email = auth.user.email ?? null;
  let isAdmin = !!(email && isAdminEmail(email));
  if (!isAdmin) {
    try {
      const roles = await getCommercialRoles(auth.user.id);
      isAdmin = roles.hasAdminRole;
    } catch {
      /* fall through — treated as non-admin */
    }
  }
  // Also require live Commercial access (mirrors every other commercial route).
  const { data: prof } = await supabase
    .from("profiles")
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (rawAccessDenied(prof) || !isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { email?: string; make?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const targetEmail = normalizeEmail(body.email);
  if (!targetEmail) {
    return NextResponse.json({ error: "missing_email" }, { status: 400 });
  }
  const make = body.make === true;

  const oc = await getOperatingCompany();
  const current = new Set((oc.approver_emails ?? []).map((e) => normalizeEmail(e)));
  if (make) current.add(targetEmail);
  else current.delete(targetEmail);

  const res = await updateOperatingCompany(
    { approver_emails: Array.from(current) },
    auth.user.id
  );
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, approver_emails: Array.from(current) });
}
