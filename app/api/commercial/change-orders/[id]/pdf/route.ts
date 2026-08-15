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

  const co = await getChangeOrder(id);
  if (!co) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [account, opp, base, netApproved, company, logo, signature] = await Promise.all([
    getCommercialAccount(co.account_id),
    getCommercialOpportunity(co.opportunity_id),
    getEffectiveContractBaseCents(co.opportunity_id),
    netApprovedChangeOrderCents(co.opportunity_id),
    getOperatingCompany(),
    getBrandLogoBuffer().catch(() => null),
    getBrandSignatureBuffer().catch(() => null),
  ]);

  // Chain of trust, same as the transmittal / warranty / work-order routes. Both
  // loaders hard-filter `deleted_at`, so a deleted parent came back null and the
  // route happily streamed a full letterhead change order addressed to
  // "Customer" with no bill-to — reachable from any bookmarked URL long after
  // the deal was removed.
  if (!account || !opp) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Contract adjustment — shown only when a contract sum is known AND this CO
  // could actually move it (pending = proposed, approved = applied). A DECLINED
  // CO never adjusts the contract, so printing a "revised contract sum" for it
  // would be a number that will never happen (Phase D catch).
  // `netApproved` already includes THIS CO when it's approved, so back it out to
  // get the "prior" sum, then add it once to get "revised" (pending + approved).
  const contractToDate = base + netApproved;
  const thisApproved = co.status === "approved";
  const showAdjustment = base > 0 && co.status !== "declined";
  const priorContractCents = showAdjustment ? contractToDate - (thisApproved ? co.amount_cents : 0) : null;
  const revisedContractCents = priorContractCents != null ? priorContractCents + co.amount_cents : null;

  const billTo: string[] = [];
  const street = [account?.billing_street, account?.billing_street2].map((s) => s?.trim()).filter(Boolean) as string[];
  billTo.push(...street);
  const cityLine = [
    [account?.billing_city?.trim(), account?.billing_state?.trim()].filter(Boolean).join(", "),
    account?.billing_zip?.trim(),
  ]
    .filter(Boolean)
    .join(" ");
  if (cityLine) billTo.push(cityLine);

  let pdfBuffer: Buffer;
  try {
    const { renderChangeOrderPdf } = await import("@/lib/commercial/change-orders/pdf");
    pdfBuffer = await renderChangeOrderPdf({
      coNumber: formatChangeOrderNumber(co.co_number),
      title: co.title,
      description: co.description,
      amountCents: co.amount_cents,
      isDeduct: co.amount_cents < 0,
      status: CHANGE_ORDER_STATUS_META[co.status]?.label ?? co.status,
      dateIso: co.decided_at ?? co.created_at ?? null,
      accountName: account?.company_name ?? "Customer",
      billTo,
      dealName: opp ? derivedOppName(opp, account?.company_name ?? null) : null,
      priorContractCents,
      revisedContractCents,
      company: {
        name: company.name,
        phone: company.phone,
        website: company.website,
        signature_name: company.signature_name,
        signature_title: company.signature_title,
      },
      logo,
      signature,
    });
  } catch (err) {
    console.error("[change-order-pdf] render failed:", err);
    return NextResponse.json(
      { error: "pdf_render_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  const safeName = formatChangeOrderNumber(co.co_number).replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40);
  return new NextResponse(new Uint8Array(pdfBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="ChangeOrder_${safeName}.pdf"`,
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    },
  });
}
