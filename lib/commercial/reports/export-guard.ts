import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { normalizeRole } from "@/lib/auth/roles";
import { isAdminEmail } from "@/lib/auth/admin";

/**
 * The ONE auth preamble for a report export route.
 *
 * Was copy-pasted into every export route — four near-identical blocks, one of
 * which is the difference between a sales rep downloading the labour cost of
 * every crew member and not. Centralising it means a new export can't ship with
 * a subtly weaker check than the last one.
 *
 * `people: true` additionally requires admin / account manager, matching the
 * gate the labour and estimator PAGES already enforce — otherwise the export
 * URL is a way around the page's own redirect.
 */
export type ExportGuardResult =
  | { ok: true; userId: string }
  | { ok: false; response: NextResponse };

export async function guardExport(
  opts: { people?: boolean } = {}
): Promise<ExportGuardResult> {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  const sb = commercialDb();
  const { data: prof } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active, role, is_admin")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (await apiAccessDenied(auth.user.id, prof)) {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  if (opts.people) {
    const p = prof as { role?: string | null; is_admin?: boolean | null } | null;
    const role = normalizeRole(p?.role, p?.is_admin ?? isAdminEmail(auth.user.email));
    if (role !== "admin" && role !== "account_manager") {
      return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
    }
  }
  return { ok: true, userId: auth.user.id };
}

/** A CSV download response with consistent headers. */
export function csvResponse(body: string, filename: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
