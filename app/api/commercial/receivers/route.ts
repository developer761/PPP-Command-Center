import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { rawAccessDenied } from "@/lib/commercial/auth";
import { isAdminEmail, normalizeEmail } from "@/lib/auth/admin";
import { normalizeRole } from "@/lib/auth/roles";
import {
  getOperatingCompany,
  updateOperatingCompany,
} from "@/lib/commercial/operating-company/db";

/**
 * POST /api/commercial/receivers — toggle who gets pinged when a proposal is
 * approved or sent back with changes. Admin-only. Body: { email, make }.
 *
 * Mirror of /api/commercial/approvers: the list lives on the operating-company
 * singleton (`receiver_emails`); receivers are independent of approvers/admin.
 * Returns the updated list.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Admin gate — read the profile with the SERVICE client (RLS on a self-read
  // can null out role/is_admin and wrongly 403 a real admin), same as every
  // other commercial API route.
  const email = auth.user.email ?? null;
  const sb = commercialDb();
  const { data: prof } = await sb
    .from("profiles")
    .select("role, is_admin, has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  const p = prof as { role?: string | null; is_admin?: boolean | null } | null;
  const isAdmin =
    normalizeRole(p?.role ?? null, p?.is_admin === true || isAdminEmail(email)) === "admin";
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
  const beforeList = (oc.receiver_emails ?? []).map((e) => normalizeEmail(e));

  // Atomic path (migration 108) — a single UPDATE that mutates the array based
  // on current db state so concurrent toggles can't drop each other. Falls back
  // to read-modify-write if the RPC isn't applied yet.
  const { data: rpcData, error: rpcErr } = await sb.rpc(
    "commercial_set_proposal_receiver",
    { p_email: targetEmail, p_make: make }
  );
  if (!rpcErr && Array.isArray(rpcData)) {
    const newList = rpcData as string[];
    try {
      const { logUpdate } = await import("@/lib/commercial/audit-log");
      await logUpdate(
        "commercial_operating_company",
        "singleton",
        { receiver_emails: beforeList },
        { receiver_emails: newList },
        auth.user.id
      );
    } catch {
      /* audit is best-effort — the write already committed */
    }
    return NextResponse.json({ ok: true, receiver_emails: newList });
  }

  // Fallback — RPC not present yet.
  const current = new Set(beforeList);
  if (make) current.add(targetEmail);
  else current.delete(targetEmail);
  const res = await updateOperatingCompany(
    { receiver_emails: Array.from(current) },
    auth.user.id
  );
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, receiver_emails: Array.from(current) });
}
