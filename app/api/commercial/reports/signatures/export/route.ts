import type { NextRequest } from "next/server";
import { csvEscape as csv } from "@/lib/commercial/csv";
import { listSignatureRequestsForReport } from "@/lib/commercial/esign/db";
import { SIGNATURE_STATUS_LABEL } from "@/lib/commercial/esign/constants";
import { summarizeSignatures } from "@/lib/commercial/esign/report";
import { proposalLabel } from "@/lib/commercial/proposals/constants";
import { SIGNATURE_DEFAULT, SIGNATURE_PRESETS, resolvePreset, signatureRange } from "@/lib/commercial/reports/presets";
import { guardExport, csvResponse } from "@/lib/commercial/reports/export-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Signatures — one row per signing link, same window as the report page. */
export async function GET(req: NextRequest) {
  const guard = await guardExport({ report: "signatures" });
  if (!guard.ok) return guard.response;

  const preset = resolvePreset(req.nextUrl.searchParams.get("preset") ?? undefined, SIGNATURE_PRESETS, SIGNATURE_DEFAULT);
  const range = signatureRange(preset);
  const rows = await listSignatureRequestsForReport(range);
  const s = summarizeSignatures(rows);

  const L: string[] = [];
  const row = (...cells: (string | number | null | undefined)[]) => L.push(cells.map((c) => csv(c ?? "")).join(","));

  row("Signatures", range.label, `${range.fromYmd} to ${range.toYmd}`);
  row("");
  row("Proposals sent for signature", s.proposalsSent);
  row("Signed by the customer", s.proposalsSigned);
  row("Fully signed", s.fullySigned);
  row("Waiting on the customer", s.awaitingCustomer);
  row("Waiting on a countersignature", s.awaitingCountersign);
  row("Declined", s.declined);
  row("Median hours to sign", s.medianHoursToSign ?? "");
  row("Median hours to countersign", s.medianHoursToCountersign ?? "");
  row("");
  row(
    "Request ID", "GC", "Project", "Proposal", "Status", "Signer email", "Signer name", "Signer title", "Signer company",
    "Link sent (UTC)", "Customer signed (UTC)", "Customer IP", "Countersigned by", "Countersigned (UTC)",
    "Declined reason", "Void reason", "Proposal SHA-256", "Signed document SHA-256"
  );
  for (const r of rows) {
    const p = r.proposal;
    row(
      r.id,
      r.account_name,
      p?.header_json.project_name ?? p?.opportunity_title,
      p ? proposalLabel(p) : "",
      SIGNATURE_STATUS_LABEL[r.status],
      r.signer_email,
      r.customer_name ?? r.signer_name,
      r.customer_title,
      r.customer_company,
      r.created_at,
      r.customer_signed_at,
      r.customer_ip,
      r.countersigner_name,
      r.countersigned_at,
      r.decline_reason,
      r.void_reason,
      r.document_sha256,
      r.signed_sha256
    );
  }

  return csvResponse(L.join("\r\n") + "\r\n", `Signatures_${range.fromYmd}_to_${range.toYmd}.csv`, "Signatures", range.label);
}
