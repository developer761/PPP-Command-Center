import { NextResponse } from "next/server";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { getChangeOrder, netApprovedChangeOrderCents } from "@/lib/commercial/change-orders/db";
import { getEffectiveContractBaseCents } from "@/lib/commercial/aia/db";
import { formatChangeOrderNumber, CHANGE_ORDER_STATUS_META } from "@/lib/commercial/change-orders/constants";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { getBrandLogoBuffer, getBrandSignatureBuffer } from "@/lib/commercial/operating-company/assets";

/**
 * GET /api/commercial/change-orders/[id]/pdf
 *
 * Standalone Change Order document for the GC to authorize — the change, the
 * dollar impact, the contract adjustment (prior → revised), and an acceptance
 * signature block. Same auth + render pattern as the invoice/statement routes.
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

  // One shared builder, used by this route AND by the email path, so both
  // render the same document with the same contract adjustment (2026-08-18).
  const { buildChangeOrderPdfInput } = await import("@/lib/commercial/change-orders/pdf-data");
  const built = await buildChangeOrderPdfInput(id);
  if (!built.ok) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let pdfBuffer: Buffer;
  try {
    const { renderChangeOrderPdf } = await import("@/lib/commercial/change-orders/pdf");
    pdfBuffer = await renderChangeOrderPdf(built.input);
  } catch (err) {
    console.error("[change-order-pdf] render failed:", err);
    return NextResponse.json(
      { error: "pdf_render_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  const safeName = built.fileBase;
  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="ChangeOrder_${safeName}.pdf"`,
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    },
  });
}
