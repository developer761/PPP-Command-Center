import { NextResponse } from "next/server";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";

/**
 * GET /api/commercial/guide/pdf
 *
 * "Running Commercial Work" — the handbook, branded and generated on demand.
 *
 * Generated rather than a file somebody uploaded, for the reason every printed
 * process document eventually fails: the page it names gets renamed and the
 * document carries on confidently sending people somewhere that is not there.
 * This one is built from `lib/commercial/guide/content.ts`, which the test
 * suite walks to check every route in it still resolves.
 *
 * Deliberately NOT one page — the one-page rule is for customer documents
 * (proposal, invoice, warranty), which are read on a phone and must never
 * spill. This is an internal handbook meant to be printed and put in a drawer.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
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
  if (await apiAccessDenied(auth.user.id, prof)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let pdfBuffer: Buffer;
  let filename = "Running_Commercial_Work.pdf";
  try {
    const { getOperatingCompany } = await import("@/lib/commercial/operating-company/db");
    const { getBrandLogoBuffer } = await import("@/lib/commercial/operating-company/assets");
    const { renderGuidePdf } = await import("@/lib/commercial/guide/pdf");
    const [company, logo] = await Promise.all([getOperatingCompany(), getBrandLogoBuffer()]);
    pdfBuffer = await renderGuidePdf({ company: company.name, logo });
    filename = `${company.name.replace(/[^A-Za-z0-9]+/g, "_")}_Running_Commercial_Work.pdf`;
  } catch (err) {
    console.error("[guide-pdf] render failed:", err);
    return NextResponse.json(
      { error: "pdf_render_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      "content-type": "application/pdf",
      // `inline` so it opens in the browser's viewer first — most people want
      // to read it, and the viewer's own download button is right there for
      // the ones who want the file.
      "content-disposition": `inline; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
