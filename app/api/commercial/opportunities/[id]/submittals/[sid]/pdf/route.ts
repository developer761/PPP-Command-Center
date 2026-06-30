import { NextResponse } from "next/server";

import { PPP_BRAND } from "@/lib/brand";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { getOpportunitySubmittal } from "@/lib/commercial/opportunities/submittals";

/**
 * GET /api/commercial/opportunities/[id]/submittals/[sid]/pdf
 *
 * Renders the Letter of Transmittal PDF for a single submittal + items.
 *
 * Auth pattern mirrors /api/commercial/accounts/[id]/documents/[docId]/download:
 *   1. createClient → supabase.auth.getUser → 401 if missing
 *   2. UUID regex on both params
 *   3. has_new_platform_access check on profiles → 403
 *   4. Chain-of-trust: lib already verifies opp.deleted_at + account.deleted_at
 *      before returning the submittal
 *   5. Render PDF → return with content-disposition (inline for new-tab open)
 *
 * Runtime: nodejs (React-PDF needs Buffer + fs for fonts).
 * maxDuration: 30s — PDF render is fast for typical submittals (~100-500ms)
 * but pdfkit cold-start adds ~300-500ms on first call per instance.
 * Dynamic import keeps @react-pdf/renderer out of every other route's bundle
 * (it's ~3-4 MB unminified).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; sid: string }> }
) {
  const { id: opportunity_id, sid: submittal_id } = await ctx.params;

  if (!UUID_RE.test(opportunity_id) || !UUID_RE.test(submittal_id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Gate on Commercial CC access (same pattern as account doc download).
  const sb = commercialDb();
  const { data: prof } = await sb
    .from("profiles")
    .select("has_new_platform_access")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (!prof || !(prof as { has_new_platform_access: boolean }).has_new_platform_access) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Load the submittal — lib does chain-of-trust on opp + account deleted_at.
  const loaded = await getOpportunitySubmittal(opportunity_id, submittal_id);
  if (!loaded) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const { submittal, items } = loaded;

  // Pull the opp's title + ppp_job_number for the cover. Already verified
  // via getOpportunitySubmittal (chain-of-trust), so a thin re-fetch is safe.
  const { data: oppRow } = await sb
    .from("commercial_opportunities")
    .select("title, ppp_job_number")
    .eq("id", opportunity_id)
    .maybeSingle();
  const opp = (oppRow as { title: string; ppp_job_number: string | null } | null) ?? {
    title: "(opportunity not found)",
    ppp_job_number: null,
  };

  // Dynamic import keeps @react-pdf/renderer out of the shared bundle —
  // only this route pays the ~3-4 MB load (and only on cold start).
  let pdfBuffer: Buffer;
  try {
    const { renderLetterOfTransmittalPdf } = await import(
      "@/lib/commercial/opportunities/submittal-pdf"
    );
    pdfBuffer = await renderLetterOfTransmittalPdf({
      submittal,
      items,
      opp,
      // PPP entity name — sourced from lib/brand.ts (single source of
      // truth, audit backend M2). Strip the ® for PDF rendering so it
      // doesn't show as a fallback glyph in Helvetica.
      fromCompany: PPP_BRAND.name.replace("®", "").trim(),
    });
  } catch (err) {
    console.error("[submittal-pdf] render failed:", err);
    return NextResponse.json(
      { error: "pdf_render_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  const submittalNumber = `SUB-${String(submittal.submittal_number).padStart(3, "0")}${
    submittal.revision_number > 0 ? `-R${submittal.revision_number}` : ""
  }`;
  const filename = `${submittalNumber}_Letter_of_Transmittal.pdf`;

  // Convert Buffer to Uint8Array for Web Response (Next 16 / Edge compat).
  const body = new Uint8Array(pdfBuffer);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      // `inline` so click opens in a new tab; users can save from the
      // browser PDF viewer if they want. Use `attachment` here if Alex
      // ever asks for force-download instead.
      "Content-Disposition": `inline; filename="${filename}"`,
      // No long-lived caching — submittals are mutable until terminal,
      // and we always want the freshest PDF for sent submittals too
      // (a user could re-render after editing a draft).
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    },
  });
}
