import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { isSignatureTokenShaped } from "@/lib/commercial/esign/constants";
import { downloadDocumentBytes, lookupSignatureLink, readRequestDocument } from "@/lib/commercial/esign/db";
import { clientMeta } from "@/lib/commercial/esign/request-meta";
import { sanitizeFileName } from "@/lib/commercial/accounts/documents";

/**
 * GET /api/sign/[token]/document — the PDF behind a signing link.
 *
 * While the link is open this is the proposal exactly as it was sent (the
 * stored snapshot, never a re-render). Once the contract is fully signed it is
 * the signed copy, so the GC's link doubles as their way back to the contract.
 * A voided or expired link serves nothing: the proposal it pointed at is no
 * longer the offer.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isSignatureTokenShaped(token)) return new NextResponse("Not found", { status: 404 });
  const meta = clientMeta(request.headers);
  if (!checkRateLimit(`esign-doc:${token}:${meta.ip ?? "?"}`, { max: 30, windowMs: 60_000 }).ok) {
    return new NextResponse("Too many requests", { status: 429 });
  }

  const lookup = await lookupSignatureLink(token);
  if (!lookup.found) return new NextResponse(lookup.reason === "unavailable" ? "Unavailable" : "Not found", { status: lookup.reason === "unavailable" ? 503 : 404 });
  const { request: req, proposal, state } = lookup;

  let bytes: Buffer | null = null;
  let suffix = "";
  if (state.kind === "sign" || (state.kind === "signed" && state.status === "awaiting_countersign")) {
    bytes = await readRequestDocument(req);
  } else if (state.kind === "signed" && state.status === "completed" && req.signed_document_id) {
    bytes = await downloadDocumentBytes(req.signed_document_id);
    suffix = "-signed";
  }
  if (!bytes) return new NextResponse("This document isn't available from this link.", { status: 410 });

  const project = proposal.header_json.project_name?.trim() || "proposal";
  const name = `${sanitizeFileName(`proposal-${project}`)}${suffix}.pdf`;
  const download = new URL(request.url).searchParams.get("download") === "1";
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
