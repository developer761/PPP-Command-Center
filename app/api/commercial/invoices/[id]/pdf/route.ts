import { NextResponse } from "next/server";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { buildInvoicePdfInput } from "@/lib/commercial/invoices/invoice-pdf-data";

/**
 * GET /api/commercial/invoices/[id]/pdf
 *
 * Renders the branded invoice PDF for one invoice — the exact document that gets
 * emailed to the GC, so the team can preview/print/download the same bytes.
 * Same auth + render pattern as the AR statement + submittal LoT routes.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
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
  if (await apiAccessDenied(auth?.user?.id, prof)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const input = await buildInvoicePdfInput(id);
  if (!input) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let pdfBuffer: Buffer;
  try {
    const { renderInvoicePdf } = await import("@/lib/commercial/invoices/invoice-pdf");
    pdfBuffer = await renderInvoicePdf(input);
  } catch (err) {
    console.error("[invoice-pdf] render failed:", err);
    return NextResponse.json(
      { error: "pdf_render_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  const safeName = input.invoiceNumber.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40);
  const body = new Uint8Array(pdfBuffer);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Invoice_${safeName}.pdf"`,
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    },
  });
}
