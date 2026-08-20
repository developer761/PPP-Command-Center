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

/**
 * A byte-order mark.
 *
 * Excel on Windows opens a .csv in the system ANSI codepage unless the file
 * starts with one — so every `·`, `—`, `≥` and accented name in our exports
 * arrives as mojibake ("Â·", "â€""). Our job names, references and reason
 * labels are full of exactly those characters, which means every export the
 * platform has ever produced has looked broken on the machine most likely to
 * open it. Three bytes fixes all of them.
 *
 * Harmless everywhere else: Sheets, Numbers, LibreOffice and every CSV parser
 * worth using strip it.
 */
export const CSV_BOM = "\uFEFF";

/** A CSV download response with consistent headers, and a BOM so Excel reads
 *  it as UTF-8. Use this rather than building the response by hand. */
export function csvResponse(body: string, filename: string): NextResponse {
  return new NextResponse(body.startsWith(CSV_BOM) ? body : CSV_BOM + body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
