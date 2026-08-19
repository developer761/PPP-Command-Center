import { NextResponse } from "next/server";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { listChangeOrders } from "@/lib/commercial/change-orders/db";
import { getEffectiveContractBaseCents } from "@/lib/commercial/aia/db";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import {
  getCommercialOpportunity,
  derivedOppName,
  formatOpportunityNumber,
} from "@/lib/commercial/opportunities/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { getBrandLogoBuffer } from "@/lib/commercial/operating-company/assets";

/**
 * GET /api/commercial/opportunities/[id]/change-orders/pdf
 *
 * The CHANGE ORDERS register — every CO on the job with its status, plus the
 * summary that reconciles the original contract to the updated one. Brendan's
 * format, sent by Stephanie 2026-08-19.
 *
 * The per-CO document (…/change-orders/[id]/pdf) is unchanged and remains the
 * one that goes out for signature. This is the running log.
 */
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
  const { data: prof } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (await apiAccessDenied(auth?.user?.id, prof)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const opp = await getCommercialOpportunity(id);
  if (!opp) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Chain of trust: both loaders hard-filter deleted_at, so without this a
  // bookmarked URL keeps streaming a letterheaded document for a removed deal.
  const account = await getCommercialAccount(opp.account_id);
  if (!account) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [rows, baseContract, company, logo] = await Promise.all([
    listChangeOrders(id),
    getEffectiveContractBaseCents(id),
    getOperatingCompany(),
    getBrandLogoBuffer().catch(() => null),
  ]);

  const addressParts = [
    opp.property_street,
    [opp.property_city, opp.property_state].filter(Boolean).join(", "),
  ].filter((s): s is string => !!s && s.trim().length > 0);

  let pdf: Buffer;
  try {
    const { renderChangeOrderRegisterPdf, changeOrderRegisterDocNumber } = await import(
      "@/lib/commercial/change-orders/register-pdf"
    );
    pdf = await renderChangeOrderRegisterPdf({
      projectName: derivedOppName(opp, account.company_name ?? null),
      jobNumber: opp.deal_number ?? formatOpportunityNumber(opp.project_number) ?? null,
      address: addressParts.join(", ") || null,
      clientName: opp.client_name?.trim() || account.company_name || "Customer",
      documentNumber: changeOrderRegisterDocNumber(opp.project_number ?? null),
      rows: rows.map((c) => ({
        coNumber: c.co_number,
        title: c.title,
        description: c.description,
        amountCents: c.amount_cents,
        status: c.status,
        raisedIso: c.created_at ?? null,
        decidedIso: c.decided_at ?? null,
      })),
      originalContractCents: baseContract > 0 ? baseContract : null,
      company: { name: company.name, phone: company.phone, website: company.website },
      logo,
    });
  } catch (err) {
    console.error("[change-orders-register-pdf] render failed:", err);
    return NextResponse.json({ error: "pdf_render_failed" }, { status: 500 });
  }

  const safe = (derivedOppName(opp, account.company_name ?? null) || "Project")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .slice(0, 40);
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="ChangeOrders_${safe}.pdf"`,
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    },
  });
}
