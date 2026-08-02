import { NextResponse } from "next/server";
import { rawAccessDenied } from "@/lib/commercial/auth";
import { getOperatingCompany } from "@/lib/commercial/operating-company/db";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { UUID_RE } from "@/lib/commercial/uuid";
import { getWorkOrder, buildWorkOrderContent } from "@/lib/commercial/work-orders/db";
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
  const { data: prof } = await sb
    .from("profiles")
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (rawAccessDenied(prof)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

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
    .select("title, title_override, client_name, property_street, property_city, property_state, account_id, status, sub_status")
    .eq("id", wo.opportunity_id)
    .maybeSingle();
  const { data: acctRow } = await sb.from("commercial_accounts").select("company_name").eq("id", wo.account_id).maybeSingle();
  const account = { company_name: (acctRow as { company_name?: string | null } | null)?.company_name ?? "" };
  const opp = (oppRow ?? {}) as {
    title: string | null; client_name: string | null;
    property_street: string | null; property_city: string | null; property_state: string | null;
  };
  const dealName = oppRow ? derivedOppName(oppRow as never, account.company_name) : "Project";
  const content = await buildWorkOrderContent(wo.opportunity_id);

  const addr = [opp.property_street, [opp.property_city, opp.property_state].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" · ");

  let pdf: Buffer;
  try {
    const { renderWorkOrderPdf } = await import("@/lib/commercial/work-orders/pdf");
    const { getBrandLogoBuffer, getBrandSignatureBuffer } = await import("@/lib/commercial/operating-company/assets");
    const oc = await getOperatingCompany();
    const [logo, signature] = await Promise.all([getBrandLogoBuffer(), getBrandSignatureBuffer()]);
    pdf = await renderWorkOrderPdf({
      content,
      header: {
        dealName,
        gcCompany: account.company_name,
        projectAddress: addr || null,
        assignedTo: wo.assigned_to,
        scheduledStartDate: wo.scheduled_start_date,
        scheduledEndDate: wo.scheduled_end_date,
        workNotes: wo.work_notes,
        dateIso: wo.sent_at ?? wo.created_at,
      },
      company: { name: oc.name, phone: oc.phone, website: oc.website },
      logo,
      signature,
    });
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
