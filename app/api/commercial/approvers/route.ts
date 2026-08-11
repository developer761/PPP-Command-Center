import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { isAdminEmail, normalizeEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
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

  // Admin gate — MATCHES the Settings → Access page gate (an admin manages
  // access, and on Commercial everyone with access is an admin). Admin =
  // profile role/is_admin resolves to "admin" (env-admin email counts too).
  // Also require live Commercial access, like every other commercial route.
  //
  // IMPORTANT: read the profile with the SERVICE client (commercialDb), NOT the
  // user-scoped SSR client — RLS on `profiles` restricts what a self-read
  // returns (role/is_admin can come back null), which would make this gate
  // wrongly 403 a real admin. Every other commercial API route reads the
  // profile this way for the same reason.
  const email = auth.user.email ?? null;
  const sb = commercialDb();
  const { data: prof } = await sb
    .from("profiles")
    .select("role, is_admin, has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  const p = prof as
    | { role?: string | null; is_admin?: boolean | null }
    | null;
  const isAdmin =
    normalizeRole(p?.role ?? null, p?.is_admin === true || isAdminEmail(email)) ===
    "admin";
  if ((await apiAccessDenied(auth?.user?.id, prof)) || !isAdmin) {
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
  const beforeList = (oc.approver_emails ?? []).map((e) => normalizeEmail(e));

  // Atomic path (migration 105): the RPC mutates the array in a single UPDATE
  // based on the CURRENT db state, so two admins toggling different emails at
  // once can't drop each other's change (the read-modify-write below could).
  // Falls back to the read-modify-write if the RPC isn't applied yet, so this
  // route works before AND after the migration is pasted.
  const { data: rpcData, error: rpcErr } = await sb.rpc(
    "commercial_set_proposal_approver",
    { p_email: targetEmail, p_make: make }
  );
  if (!rpcErr && Array.isArray(rpcData)) {
    const newList = rpcData as string[];
    try {
      const { logUpdate } = await import("@/lib/commercial/audit-log");
      await logUpdate(
        "commercial_operating_company",
        "singleton",
        { approver_emails: beforeList },
        { approver_emails: newList },
        auth.user.id
      );
    } catch {
      /* audit is best-effort — the write already committed */
    }
    return NextResponse.json({ ok: true, approver_emails: newList });
  }

  // Fallback — RPC not present yet. Read-modify-write via updateOperatingCompany
  // (also audited). Small race window, but self-heals on the next toggle.
  const current = new Set(beforeList);
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
