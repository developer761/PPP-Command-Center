import { NextResponse } from "next/server";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { getWorkOrder, buildWorkOrderContent } from "@/lib/commercial/work-orders/db";
import { derivedOppName } from "@/lib/commercial/opportunities/db";
import { workOrderRecordId } from "@/lib/commercial/record-ids";

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
  if ((await apiAccessDenied(auth?.user?.id, prof))) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const wo = await getWorkOrder(id);
  if (!wo || wo.voided_at) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // A sent WO serves the FROZEN copy filed at send time — not a live re-render,
  // which could diverge from what the crew actually received if the proposal or
  // finishes changed afterward. Redirect to the snapshot document.
  if (wo.status === "sent" && wo.snapshot_document_id) {
    return NextResponse.redirect(new URL(`/api/commercial/documents/${wo.snapshot_document_id}/download`, _req.url));
  }

  const { data: oppRow } = await sb
    .from("commercial_opportunities")
    .select("title, title_override, client_name, property_street, property_city, property_state, project_number, account_id, status, sub_status, deleted_at")
    .eq("id", wo.opportunity_id)
    .maybeSingle();
  const { data: acctRow } = await sb.from("commercial_accounts").select("company_name, deleted_at").eq("id", wo.account_id).maybeSingle();
  // Don't serve a work order whose parent deal or account was soft-deleted — a
  // stale link would leak deleted-deal data (audit R3 #14).
  if (!oppRow || (oppRow as { deleted_at: string | null }).deleted_at) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!acctRow || (acctRow as { deleted_at: string | null }).deleted_at) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const account = { company_name: (acctRow as { company_name?: string | null } | null)?.company_name ?? "" };
  const opp = (oppRow ?? {}) as {
    title: string | null; client_name: string | null;
    property_street: string | null; property_city: string | null; property_state: string | null;
    project_number: string | null;
  };
  const dealName = oppRow ? derivedOppName(oppRow as never, account.company_name) : "Project";
  // This sheet's own scope selection (migration 123) — a downloaded PDF must
  // show exactly what the crew holding it was given, not the whole proposal.
  const [content, allScope] = await Promise.all([
    buildWorkOrderContent(wo.opportunity_id, wo.scope_line_item_ids),
    // Unfiltered, so the partial-scope banner can say "4 of 8" — the
    // downloaded PDF must carry the same warning as the one that was sent.
    buildWorkOrderContent(wo.opportunity_id, null),
  ]);
  // Base inclusions only — alternates are optional add-ons nobody has bought,
  // and counting them made a sheet covering ALL the real work print
  // "PARTIAL SCOPE — covers 5 of 7" with no other work order in existence.
  const sheetScopeLines = content.inclusions.length;
  const totalScopeLines = allScope.inclusions.length;

  const addr = [opp.property_street, [opp.property_city, opp.property_state].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" · ");

  let pdf: Buffer;
  try {
    const { renderFitToOnePage } = await import("@/lib/commercial/proposals/fit-one-page");
    const { renderWorkOrderPdf } = await import("@/lib/commercial/work-orders/pdf");
    const { getBrandLogoBuffer, getBrandSignatureBuffer } = await import("@/lib/commercial/operating-company/assets");
    const oc = await getOperatingCompany();
    const [logo, signature] = await Promise.all([getBrandLogoBuffer(), getBrandSignatureBuffer()]);
    const __args = {
      content,
      header: {
        dealName,
        // WO-2026-0020 · Level 3 — the whole point of the area tag is telling
        // three sheets for one project apart, and a crew holding the DOWNLOADED
        // pdf had no identifier at all because this route hand-built its header
        // instead of using workOrderHeader().
        recordId:
          [workOrderRecordId(opp?.project_number), wo.area_label?.trim()]
            .filter(Boolean)
            .join(" · ") || null,
        partialScopeNote:
          totalScopeLines > 0 && sheetScopeLines > 0 && sheetScopeLines < totalScopeLines
            ? `PARTIAL SCOPE — this sheet covers ${sheetScopeLines} of ${totalScopeLines} items on this project. Work ONLY the items listed below; the rest are on separate work orders.`
            : null,
        gcCompany: account.company_name,
        projectAddress: addr || null,
        assignedTo: wo.assigned_to,
        scheduledStartDate: wo.scheduled_start_date,
        scheduledEndDate: wo.scheduled_end_date,
        workNotes: wo.work_notes,
        dateIso: wo.sent_at ?? wo.created_at,
      },
      company: { name: oc.name, phone: oc.phone, website: oc.website, signature_name: oc.signature_name, signature_title: oc.signature_title },
      logo,
      signature,
    };
    // Karan 2026-08-26: "everything is supposed to have one page for the
    // PDF." Laid out on a taller sheet until it flows onto one page, then
    // scaled back to Letter — see lib/commercial/proposals/fit-one-page.
    const __fit = await renderFitToOnePage((pageHeightScale) =>
      renderWorkOrderPdf({ ...__args, pageHeightScale })
    );
    pdf = __fit.bytes;
    if (!__fit.fitted) console.warn("[work-order-pdf] too long to fit one readable page — sent at natural length");
  } catch (err) {
    console.error("[work-order-pdf] render failed:", err);
    return NextResponse.json({ error: "pdf_render_failed" }, { status: 500 });
  }
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="Work_Order.pdf"`,
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
    },
  });
}
