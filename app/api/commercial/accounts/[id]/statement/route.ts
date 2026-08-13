import { NextResponse } from "next/server";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getOpenInvoiceStatementForAccount } from "@/lib/commercial/invoices/statement";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";

/**
 * GET /api/commercial/accounts/[id]/statement
 *
 * Renders the branded open-invoice AR statement PDF for one GC/account — every
 * unpaid/partial/overdue invoice + balances + total outstanding + 5-bucket
 * aging. Same auth + render pattern as the submittal Letter-of-Transmittal PDF.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id: account_id } = await ctx.params;
  if (!UUID_RE.test(account_id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const sb = commercialDb();
  const { data: prof } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if ((await apiAccessDenied(auth?.user?.id, prof))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const account = await getCommercialAccount(account_id);
  if (!account) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const billTo = [
    account.billing_street,
    account.billing_street2,
    [account.billing_city, account.billing_state, account.billing_zip].filter(Boolean).join(", ").replace(/, ([^,]+)$/, " $1"),
  ].filter((l): l is string => !!l && l.trim().length > 0);

  const statement = await getOpenInvoiceStatementForAccount(account_id);

  let pdfBuffer: Buffer;
  try {
    const { renderARStatementPdf } = await import("@/lib/commercial/invoices/statement-pdf");
    const { getBrandLogoBuffer } = await import("@/lib/commercial/operating-company/assets");
    const oc = await getOperatingCompany();
    pdfBuffer = await renderARStatementPdf({
      statement,
      accountName: account.company_name,
      billTo,
      company: { name: oc.name, phone: oc.phone, website: oc.website },
      logo: await getBrandLogoBuffer(),
    });
  } catch (err) {
    console.error("[account-statement-pdf] render failed:", err);
    return NextResponse.json(
      { error: "pdf_render_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  const safeName = account.company_name.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40);
  const body = new Uint8Array(pdfBuffer);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Statement_${safeName}.pdf"`,
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    },
  });
}
