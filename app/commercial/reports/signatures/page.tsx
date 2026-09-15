import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getProfileByUserId, platformAccess } from "@/lib/auth/profile";
import { listAwaitingCountersign, listSignatureRequestsForReport, type SignatureReportRow } from "@/lib/commercial/esign/db";
import { formatSignedAt, SIGNATURE_STATUS_LABEL, SIGNATURE_STATUS_TONE } from "@/lib/commercial/esign/constants";
import { formatDuration, summarizeSignatures } from "@/lib/commercial/esign/report";
import { proposalLabel } from "@/lib/commercial/proposals/constants";
import { SIGNATURE_DEFAULT, SIGNATURE_PRESETS, resolvePreset, signatureRange } from "@/lib/commercial/reports/presets";
import { ExportCsvLink } from "@/components/commercial/export-csv-link";

/**
 * Signatures — every proposal sent for e-signature, where each one stands, and
 * the audit trail for each. Karan 2026-09-15: "we need [the audit trail] for
 * every time a customer signs … under Reports … saved as a PDF."
 *
 * The audit-trail link renders the certificate from the event log on demand,
 * so it is always complete. A filed copy of it, and of the signed contract,
 * also lives on each deal's Files tab.
 */

export const dynamic = "force-dynamic";

const CHIP: Record<"green" | "amber" | "grey" | "red", string> = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  grey: "bg-ppp-charcoal-50 text-ppp-charcoal-700 ring-ppp-charcoal-200",
  red: "bg-rose-50 text-rose-800 ring-rose-200",
};

export default async function SignaturesReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/");
  const profile = await getProfileByUserId(user.id);
  if (!platformAccess(profile).hasNewPlatform) redirect("/commercial");

  const sp = await searchParams;
  const preset = resolvePreset(sp.preset, SIGNATURE_PRESETS, SIGNATURE_DEFAULT);
  const range = signatureRange(preset);
  const rows = await listSignatureRequestsForReport(range);
  const s = summarizeSignatures(rows);
  // Waiting on US is the one line here that is somebody's job today, so it is
  // counted across all time — a signature from last quarter still waiting on a
  // countersignature is the most urgent case, and a date filter must not hide it.
  const allTimeWaiting =
    preset === "all" ? rows.filter((r) => r.status === "awaiting_countersign") : await listAwaitingCountersign();

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 pb-8 sm:px-6">
      <div>
        <h2 className="text-lg font-bold text-ppp-charcoal">Signatures</h2>
        <p className="mt-0.5 max-w-2xl text-[12px] text-ppp-charcoal-500">
          Proposals sent for e-signature, counted from when the link went out. Each has an audit trail — who signed,
          when, from which device, and the signed document&rsquo;s fingerprint.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {SIGNATURE_PRESETS.map((p) => (
          <Link
            key={p.key}
            href={`/commercial/reports/signatures?preset=${p.key}`}
            aria-current={p.key === preset ? "page" : undefined}
            className={`inline-flex min-h-[44px] items-center rounded-lg border px-3 text-[12px] font-semibold transition-colors sm:min-h-[34px] ${
              p.key === preset
                ? "border-cc-brand-600 bg-cc-brand-600 text-white"
                : "border-ppp-charcoal-200 bg-surface text-ppp-charcoal-600 hover:bg-ppp-charcoal-50"
            }`}
          >
            {p.label}
          </Link>
        ))}
        <span className="ml-auto">
          <ExportCsvLink href="/api/commercial/reports/signatures/export" preset={preset} disabled={rows.length === 0} />
        </span>
      </div>

      {allTimeWaiting.length > 0 && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3.5">
          <p className="text-[13.5px] font-bold text-amber-900">
            {allTimeWaiting.length} signed proposal{allTimeWaiting.length === 1 ? " is" : "s are"} waiting on a countersignature.
          </p>
          <ul className="mt-1.5 space-y-1">
            {allTimeWaiting.slice(0, 6).map((r) => (
              <li key={r.id} className="text-[12.5px] text-amber-900">
                <ProposalLink row={r} className="font-semibold underline-offset-2 hover:underline" />
                <span className="text-amber-800"> · signed by {r.customer_name} {formatSignedAt(r.customer_signed_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-ppp-charcoal-100 bg-surface p-6 text-center">
          <p className="text-[13px] font-semibold text-ppp-charcoal">No proposals sent for signature in {range.label}.</p>
          <p className="mt-1 text-[12px] text-ppp-charcoal-500">
            When you send a proposal, leave &ldquo;Ask the GC to sign online&rdquo; ticked and it shows up here.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Sent for signature" value={String(s.proposalsSent)} sub={`${s.awaitingCustomer} still with the customer`} />
            <Kpi
              label="Signed"
              value={String(s.proposalsSigned)}
              sub={s.signRatePct === null ? undefined : `${s.signRatePct}% of sent · ${s.fullySigned} fully signed`}
              tone="good"
            />
            <Kpi label="Time to sign" value={formatDuration(s.medianHoursToSign)} sub="median, link → customer" />
            <Kpi
              label="Time to countersign"
              value={formatDuration(s.medianHoursToCountersign)}
              sub="median, customer → us"
              tone={s.medianHoursToCountersign !== null && s.medianHoursToCountersign > 48 ? "warn" : undefined}
            />
          </div>

          {/* Phone: cards. A seven-column table is unreadable at 400px. */}
          <ul className="space-y-2 sm:hidden">
            {rows.map((r) => (
              <li key={r.id} className="rounded-xl border border-ppp-charcoal-100 bg-surface p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <ProposalLink row={r} className="min-w-0 break-words text-[13.5px] font-semibold text-ppp-charcoal" />
                  <StatusChip row={r} />
                </div>
                <p className="mt-1 break-words text-[12px] text-ppp-charcoal-600">
                  {r.account_name ? `${r.account_name} · ` : ""}{r.customer_name ?? r.signer_email}
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px]">
                  <dt className="text-ppp-charcoal-500">Sent</dt>
                  <dd className="text-right text-ppp-charcoal-700">{formatSignedAt(r.created_at)}</dd>
                  <dt className="text-ppp-charcoal-500">Customer signed</dt>
                  <dd className="text-right text-ppp-charcoal-700">{formatSignedAt(r.customer_signed_at)}</dd>
                  <dt className="text-ppp-charcoal-500">Countersigned</dt>
                  <dd className="text-right text-ppp-charcoal-700">{formatSignedAt(r.countersigned_at)}</dd>
                </dl>
                <DocLinks row={r} />
              </li>
            ))}
          </ul>

          <div className="hidden overflow-hidden rounded-xl border border-ppp-charcoal-100 bg-surface sm:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-[12.5px]">
                <thead>
                  <tr className="bg-ppp-charcoal-50/60 text-left text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500">
                    <th className="px-4 py-2">Proposal</th>
                    <th className="px-4 py-2">Signer</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Sent</th>
                    <th className="px-4 py-2">Customer signed</th>
                    <th className="px-4 py-2">Countersigned</th>
                    <th className="px-4 py-2 text-right">Documents</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ppp-charcoal-100">
                  {rows.map((r) => (
                    <tr key={r.id} className="align-top hover:bg-ppp-charcoal-50/60">
                      <td className="px-4 py-2.5">
                        <ProposalLink row={r} className="font-semibold text-ppp-charcoal hover:text-cc-brand-700 hover:underline" />
                        {r.account_name ? <div className="text-[11.5px] text-ppp-charcoal-500">{r.account_name}</div> : null}
                      </td>
                      <td className="px-4 py-2.5 text-ppp-charcoal-700">
                        <div>{r.customer_name ?? r.signer_name ?? "—"}</div>
                        <div className="text-[11.5px] text-ppp-charcoal-500">{r.signer_email}</div>
                      </td>
                      <td className="px-4 py-2.5"><StatusChip row={r} /></td>
                      <td className="px-4 py-2.5 text-ppp-charcoal-700">{formatSignedAt(r.created_at)}</td>
                      <td className="px-4 py-2.5 text-ppp-charcoal-700">{formatSignedAt(r.customer_signed_at)}</td>
                      <td className="px-4 py-2.5 text-ppp-charcoal-700">{formatSignedAt(r.countersigned_at)}</td>
                      <td className="px-4 py-2.5 text-right"><DocLinks row={r} align="end" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function proposalHref(r: SignatureReportRow): string | null {
  const p = r.proposal;
  if (!p?.account_id) return null;
  return `/commercial/accounts/${p.account_id}/deals/${p.opportunity_id}/proposal/${p.id}#signature`;
}

function ProposalLink({ row, className }: { row: SignatureReportRow; className?: string }) {
  const p = row.proposal;
  const label = p
    ? `${p.header_json.project_name?.trim() || p.opportunity_title || "Proposal"} · ${proposalLabel(p)}`
    : "Deleted proposal";
  const href = proposalHref(row);
  return href && !p?.deleted_at ? (
    <Link href={href} className={className}>{label}</Link>
  ) : (
    <span className={className}>{label}</span>
  );
}

function StatusChip({ row }: { row: SignatureReportRow }) {
  return (
    <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${CHIP[SIGNATURE_STATUS_TONE[row.status]]}`}>
      {SIGNATURE_STATUS_LABEL[row.status]}
    </span>
  );
}

function DocLinks({ row, align = "start" }: { row: SignatureReportRow; align?: "start" | "end" }) {
  return (
    <div className={`mt-2 flex flex-wrap gap-2 sm:mt-0 ${align === "end" ? "sm:justify-end" : ""}`}>
      <a
        href={`/api/commercial/signatures/${row.id}/audit`}
        target="_blank"
        rel="noopener"
        className="inline-flex min-h-[44px] items-center rounded-lg border border-ppp-charcoal-200 px-2.5 text-[12px] font-semibold text-ppp-charcoal-700 hover:bg-ppp-charcoal-50 sm:min-h-[32px]"
      >
        Audit trail
      </a>
      {row.signed_document_id ? (
        <a
          href={`/api/commercial/signatures/${row.id}/signed`}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-[44px] items-center rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 text-[12px] font-semibold text-emerald-800 hover:bg-emerald-100 sm:min-h-[32px]"
        >
          Signed copy
        </a>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" }) {
  return (
    <div className="rounded-xl border border-ppp-charcoal-100 bg-surface px-3.5 py-3">
      <div className="text-[9.5px] font-bold uppercase tracking-wider text-ppp-charcoal-500">{label}</div>
      <div
        className={`mt-0.5 font-condensed text-[20px] font-black leading-tight tabular-nums ${
          tone === "good" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : "text-ppp-charcoal"
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[10.5px] text-ppp-charcoal-500">{sub}</div>}
    </div>
  );
}
