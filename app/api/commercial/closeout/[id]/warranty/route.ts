import { NextResponse } from "next/server";
import { PPP_BRAND } from "@/lib/brand";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { getCloseoutPackage } from "@/lib/commercial/closeout/db";
import { derivedOppName } from "@/lib/commercial/opportunities/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = commercialDb();
  const { data: prof } = await sb.from("profiles").select("has_new_platform_access").eq("user_id", auth.user.id).maybeSingle();
  if (!prof || !(prof as { has_new_platform_access: boolean }).has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const pkg = await getCloseoutPackage(id);
  if (!pkg) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (pkg.voided_at) return NextResponse.json({ error: "not_found" }, { status: 404 }); // soft-deleted → not downloadable

  const { data: oppRow } = await sb
    .from("commercial_opportunities")
    .select("title, title_override, client_name, property_street, account_id")
    .eq("id", pkg.opportunity_id)
    .maybeSingle();
  const { data: acctRow } = await sb.from("commercial_accounts").select("company_name").eq("id", pkg.account_id).maybeSingle();
  const accountName = (acctRow as { company_name?: string | null } | null)?.company_name ?? null;
  const dealName = oppRow ? derivedOppName(oppRow as never, accountName) : "Project";

  let pdf: Buffer;
  try {
    const { renderWarrantyLetterPdf } = await import("@/lib/commercial/closeout/pdf");
    const oc = await getOperatingCompany();
    pdf = await renderWarrantyLetterPdf({ pkg, dealName, company: { name: oc.name, phone: oc.phone, website: oc.website } });
  } catch (err) {
    console.error("[closeout-warranty-pdf] render failed:", err);
    return NextResponse.json({ error: "pdf_render_failed" }, { status: 500 });
  }
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Warranty_Letter.pdf"`,
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    },
  });
}
