import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { commercialDb } from "@/lib/commercial/db";
import { apiAccessDenied } from "@/lib/commercial/auth";
import { UUID_RE } from "@/lib/commercial/uuid";
import { downloadDocumentBytes, getProposalForSigning, getSignatureRequest } from "@/lib/commercial/esign/db";
import { buildAuditTrailPdf } from "@/lib/commercial/esign/workflow";
import { sanitizeFileName } from "@/lib/commercial/accounts/documents";
import { proposalLabel } from "@/lib/commercial/proposals/constants";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/commercial/signatures/[id]/audit  — the audit trail certificate
 * GET /api/commercial/signatures/[id]/signed — the signed contract
 *
 * The audit trail is rendered from the event rows on every request, so it is
 * never staler than the record — including events after the last filed copy
 * (a void, say). The filed versions stay on the deal's Files tab as the
 * point-in-time record.
 *
 * Staff only: signed in, Commercial access, not a crew login. Add
 * `?download=1` for an attachment instead of an inline view.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: profile } = await commercialDb()
    .from("profiles")
    .select("has_new_platform_access, is_active")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (await apiAccessDenied(auth.user.id, profile)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { id, file } = await params;
  if (!UUID_RE.test(id) || (file !== "audit" && file !== "signed")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let bytes: Buffer | null = null;
  let name = "";
  if (file === "audit") {
    const built = await buildAuditTrailPdf(id);
    if (!built) return NextResponse.json({ error: "not_found" }, { status: 404 });
    bytes = built.bytes;
    name = `${sanitizeFileName(`${proposalLabel(built.proposal)} ${built.proposal.header_json.project_name ?? ""}`)}-audit-trail.pdf`;
  } else {
    const req = await getSignatureRequest(id);
    if (!req?.signed_document_id) return NextResponse.json({ error: "not_signed_yet" }, { status: 404 });
    const proposal = await getProposalForSigning(req.proposal_id);
    bytes = await downloadDocumentBytes(req.signed_document_id);
    name = `${sanitizeFileName(`${proposal ? proposalLabel(proposal) : "proposal"} ${proposal?.header_json.project_name ?? ""}`)}-signed.pdf`;
  }
  if (!bytes) return NextResponse.json({ error: "file_unavailable" }, { status: 410 });

  const download = new URL(request.url).searchParams.get("download") === "1";
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
