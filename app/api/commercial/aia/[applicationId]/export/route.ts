import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertCommercialAccess } from "@/lib/commercial/auth";
import { UUID_RE } from "@/lib/commercial/uuid";
import { getCommercialAccount } from "@/lib/commercial/accounts/db";
import { getCommercialOpportunity, derivedOppName } from "@/lib/commercial/opportunities/db";
import { getAiaApplication, listAiaLineItems, resolveG702 } from "@/lib/commercial/aia/db";
import { buildAiaWorkbookBuffer } from "@/lib/commercial/aia/export";

/**
 * GET /api/commercial/aia/<applicationId>/export
 * Streams the AIA G702/G703 payment application as an .xlsx matching Katie's
 * template layout. Access-gated (has_new_platform_access) + ownership-checked.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ applicationId: string }> }
) {
  const { applicationId } = await params;
  if (!UUID_RE.test(applicationId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await assertCommercialAccess(user.id);

  const application = await getAiaApplication(applicationId);
  if (!application) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const [opp, lines, g702] = await Promise.all([
    getCommercialOpportunity(application.opportunity_id),
    listAiaLineItems(applicationId),
    resolveG702(applicationId),
  ]);
  if (!opp || !g702) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const account = await getCommercialAccount(opp.account_id);
  if (!account) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const dealName = derivedOppName(opp, account.company_name);
  const projectLabel = [dealName, opp.property_street].filter(Boolean).join(" · ");

  const buf = await buildAiaWorkbookBuffer({
    application,
    lines,
    g702,
    projectLabel,
    ownerLabel: account.company_name,
    // PPP is the contractor submitting the application.
    contractorLabel: "Precision Painting Plus",
  });

  const safeName = `AIA_App_${application.application_number}_${dealName}`
    .replace(/[^\w\-]+/g, "_")
    .slice(0, 80);

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${safeName}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
