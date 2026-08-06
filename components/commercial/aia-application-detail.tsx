/**
 * AIA application detail (Phase H2) — the computed G702 certificate summary +
 * the editable G703 schedule of values. Reusable server component; the host
 * page passes the resolved G702, the line items, and the server actions.
 */
import Link from "next/link";
import { formatCentsFull } from "@/lib/commercial/invoices/format";
import { INPUT_CLS } from "@/lib/commercial/form-classnames";
import { AIA_STATUS_META, type AiaG702, type AiaApplicationStatus } from "@/lib/commercial/aia/constants";
import { lineCompletedStoredCents } from "@/lib/commercial/aia/constants";
import type { AiaApplication, AiaLineItem } from "@/lib/commercial/aia/db";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import { AiaLineRow, type AiaLineSaveResult } from "@/components/commercial/aia-line-row";

type Action = (fd: FormData) => void | Promise<void>;
type SaveAction = (fd: FormData) => Promise<AiaLineSaveResult>;

function StatusPill({ status }: { status: AiaApplicationStatus }) {
  const m = AIA_STATUS_META[status];
  const cls =
    m.tone === "emerald"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : m.tone === "ppp-blue"
      ? "bg-ppp-blue-50 text-ppp-blue-700 border-ppp-blue-200"
      : "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold ${cls}`}>
      {m.label}
    </span>
  );
}

/** One G702 summary line. */
function G702Line({
  n,
  label,
  cents,
  emphasize,
  muted,
}: {
  n: string;
  label: string;
  cents: number;
  emphasize?: boolean;
  muted?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-1.5 ${emphasize ? "border-t border-ppp-charcoal-200 mt-1 pt-2" : ""}`}>
      <span className={`text-[12px] ${emphasize ? "font-bold text-ppp-charcoal" : muted ? "text-ppp-charcoal-500" : "text-ppp-charcoal-700"}`}>
        <span className="tabular-nums text-ppp-charcoal-400 mr-1.5">{n}</span>
        {label}
      </span>
      <span className={`tabular-nums shrink-0 ${emphasize ? "text-base font-bold text-cc-brand-700" : muted ? "text-[12px] text-ppp-charcoal-500" : "text-[13px] font-semibold text-ppp-charcoal"}`}>
        {cents < 0 ? `(${formatCentsFull(Math.abs(cents))})` : formatCentsFull(cents)}
      </span>
    </div>
  );
}

export function AiaApplicationDetail({
  application,
  accountId,
  dealId,
  back = "",
  origin = "",
  lines,
  g702,
  basePath,
  exportHref,
  editable,
  upsertLineAction,
  saveLineAutosaveAction,
  deleteLineAction,
  setStatusAction,
  errorMessage,
}: {
  application: AiaApplication;
  accountId: string;
  dealId: string;
  /** ?back= sidebar-tool origin, carried through every form action. */
  back?: string;
  /** inline/route origin so an action returns you to WHERE you are (not the
   *  inline deal Project tab by default). */
  origin?: string;
  lines: AiaLineItem[];
  g702: AiaG702;
  basePath: string; // list URL (drop ?app)
  exportHref: string;
  /** Only a Draft is editable — an issued (submitted/paid) certificate is
   *  locked (it's been sent to the GC + may be carried forward). */
  editable: boolean;
  upsertLineAction: Action;
  saveLineAutosaveAction: SaveAction;
  deleteLineAction: Action;
  setStatusAction: Action;
  errorMessage?: string | null;
}) {
  // basePath may already carry a query (the deal Project sub-tab), so append
  // with the right separator instead of a bare `?`.
  const selfHref = `${basePath}${basePath.includes("?") ? "&" : "?"}app=${application.id}`;
  const pct = g702.percentCompleteBps != null ? (g702.percentCompleteBps / 100).toFixed(1) : null;
  // Every form carries the account + deal ids the server actions redirect with.
  const Ctx = () => (
    <>
      <input type="hidden" name="account_id" value={accountId} />
      <input type="hidden" name="opp_id" value={dealId} />
      <input type="hidden" name="back" value={back} />
      <input type="hidden" name="origin" value={origin} />
    </>
  );

  // The G703 scheduled-value column should foot to the G702 Contract Sum to Date
  // (line 3). If it drifts — a change order approved AFTER this application was
  // seeded, or a legacy app seeded before the reconciliation fix — warn the
  // estimator (draft only) so the two sheets don't leave matching to chance.
  const sovTotalCents = lines.reduce((s, l) => s + Math.max(0, Math.round(l.scheduled_value_cents)), 0);
  const sovDriftCents = g702.contractSumToDateCents - sovTotalCents;
  const showSovDrift = editable && Math.abs(sovDriftCents) > 1;

  return (
    <div className="space-y-3">
      {errorMessage && (
        <div className="rounded-lg px-4 py-3 text-sm bg-rose-50 border border-rose-200 text-rose-700 flex items-start justify-between gap-3">
          <span>{errorMessage}</span>
          <Link href={selfHref} className="text-[12px] underline shrink-0 min-h-[44px] inline-flex items-center">Dismiss</Link>
        </div>
      )}

      {showSovDrift && (
        <div className="rounded-lg px-4 py-3 text-[12.5px] bg-amber-50 border border-amber-200 text-amber-800">
          <span className="font-semibold">Schedule of values is off by {formatCentsFull(Math.abs(sovDriftCents))}.</span>{" "}
          The scheduled-value total doesn't match the Contract Sum to Date (contract + approved change orders) — likely a change order approved after this application was created. Add a line for it below so the G702 and G703 foot to the same number before you send.
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link href={basePath} className="inline-flex items-center gap-1 text-[12px] text-ppp-charcoal-500 hover:text-cc-brand-700 min-h-[44px] sm:min-h-[36px]">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 12H5 M12 19l-7-7 7-7" /></svg>
          All applications
        </Link>
        <div className="flex items-center gap-2">
          <StatusPill status={application.status} />
          <a
            href={exportHref}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cc-brand-200 bg-surface text-[12px] font-semibold text-cc-brand-700 hover:bg-cc-brand-50 min-h-[44px]"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3" /></svg>
            Export to Excel
          </a>
        </div>
      </div>

      {/* ── G702 summary ── */}
      <section className="bg-gradient-to-br from-cc-brand-50/40 to-surface border border-cc-brand-100 rounded-xl p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h2 className="text-sm font-bold text-ppp-charcoal">Application No. {application.application_number} — Certificate (G702)</h2>
          {pct != null && <span className="text-[11px] font-semibold text-ppp-charcoal-500">{pct}% complete</span>}
        </div>
        <div className="grid sm:grid-cols-2 sm:gap-x-8">
          <div>
            <G702Line n="1" label="Original Contract Sum" cents={g702.originalContractCents} />
            <G702Line n="2" label="Net change by Change Orders" cents={g702.netChangeOrdersCents} />
            <G702Line n="3" label="Contract Sum to Date" cents={g702.contractSumToDateCents} emphasize />
            <G702Line n="4" label="Total Completed & Stored" cents={g702.totalCompletedStoredCents} />
            <G702Line n="5" label={`Retainage (${Number(application.retainage_pct)}%)`} cents={g702.retainageCents} muted />
          </div>
          <div>
            <G702Line n="6" label="Total Earned Less Retainage" cents={g702.totalEarnedLessRetainageCents} />
            <G702Line n="7" label="Less Previous Certificates" cents={g702.previousCertificatesCents} muted />
            <G702Line n="8" label="Current Payment Due" cents={g702.currentPaymentDueCents} emphasize />
            <G702Line n="9" label="Balance to Finish (incl. retainage)" cents={g702.balanceToFinishCents} />
          </div>
        </div>
        {/* Status controls */}
        <div className="mt-3 pt-3 border-t border-cc-brand-100 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-ppp-charcoal-500">Mark as:</span>
          {(["draft", "submitted", "paid"] as AiaApplicationStatus[]).map((s) => (
            <form action={setStatusAction} key={s}>
              <input type="hidden" name="app_id" value={application.id} />
                <Ctx />
              <input type="hidden" name="status" value={s} />
              <PendingSubmitButton
                pendingLabel="…"
                className={`px-3 py-1.5 rounded-lg border text-[12px] font-semibold min-h-[44px] sm:min-h-[36px] ${application.status === s ? "bg-cc-brand-600 text-white border-cc-brand-600" : "bg-surface text-ppp-charcoal-700 border-ppp-charcoal-200 hover:bg-ppp-charcoal-50"}`}
              >
                {AIA_STATUS_META[s].label}
              </PendingSubmitButton>
            </form>
          ))}
        </div>
      </section>

      {/* ── G703 schedule of values ── */}
      <section className="bg-surface border border-ppp-charcoal-100 rounded-xl p-4 sm:p-5">
        <h2 className="text-sm font-bold text-ppp-charcoal mb-1">Schedule of Values (G703)</h2>
        {editable ? (
          <p className="text-[11px] text-ppp-charcoal-500 mb-3">
            One row per line of work. Enter the scheduled value + what&rsquo;s completed from previous periods, this period, and materials stored. <span className="text-ppp-charcoal-400">Changes save automatically as you move off a row.</span>
          </p>
        ) : (
          <div className="mb-3 rounded-lg bg-ppp-charcoal-50 border border-ppp-charcoal-200 px-3 py-2 text-[11.5px] text-ppp-charcoal-600 flex items-center gap-2">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            This application is <strong className="mx-1">{AIA_STATUS_META[application.status].label.toLowerCase()}</strong> and locked. Reopen it to Draft (above) to edit the schedule of values.
          </div>
        )}

        {/* 2026-07-29 rebuild: a real schedule-of-values TABLE — one header
            row + tight aligned rows — instead of stacked cards that repeated
            the column labels on every line. Scrolls horizontally on narrow
            screens (a G703 is inherently wide). */}
        {lines.length === 0 ? (
          <p className="text-[12px] text-ppp-charcoal-500 italic">{editable ? "No line items yet — add the first below." : "No line items."}</p>
        ) : (
          <div className="overflow-x-auto -mx-1 px-1">
            <div className="min-w-[860px]">
              {/* Header row */}
              <div className="grid grid-cols-[46px_minmax(150px,1fr)_92px_92px_92px_92px_96px_104px] gap-2 px-1 pb-1.5 border-b-2 border-ppp-charcoal-200 text-[9px] font-bold uppercase tracking-wide text-ppp-charcoal-500">
                <div>Item</div>
                <div>Description</div>
                <div className="text-right">Scheduled</div>
                <div className="text-right">From prev.</div>
                <div className="text-right">This period</div>
                <div className="text-right">Stored</div>
                <div className="text-right">Balance</div>
                <div className="text-right">{editable ? "" : " "}</div>
              </div>
              <div className="divide-y divide-ppp-charcoal-100">
                {lines.map((li) => {
                  const total = lineCompletedStoredCents(li);
                  const balance = li.scheduled_value_cents - total;
                  if (!editable) {
                    return (
                      <div key={li.id} className="grid grid-cols-[46px_minmax(150px,1fr)_92px_92px_92px_92px_96px_104px] gap-2 px-1 py-2 items-center text-[12px] tabular-nums text-ppp-charcoal-700">
                        <div className="text-ppp-charcoal-400">{li.item_no ?? ""}</div>
                        <div className="font-medium text-ppp-charcoal truncate whitespace-normal" title={li.description}>{li.description || "—"}</div>
                        <div className="text-right">{formatCentsFull(li.scheduled_value_cents)}</div>
                        <div className="text-right">{formatCentsFull(li.from_previous_cents)}</div>
                        <div className="text-right">{formatCentsFull(li.this_period_cents)}</div>
                        <div className="text-right">{formatCentsFull(li.materials_stored_cents)}</div>
                        <div className="text-right font-semibold text-ppp-charcoal">{formatCentsFull(balance)}</div>
                        <div aria-hidden>&nbsp;</div>
                      </div>
                    );
                  }
                  return (
                    <AiaLineRow
                      key={li.id}
                      line={li}
                      appId={application.id}
                      accountId={accountId}
                      dealId={dealId}
                      back={back}
                      origin={origin}
                      gridCls="grid grid-cols-[46px_minmax(150px,1fr)_92px_92px_92px_92px_96px_104px] gap-2 px-1 py-1.5 items-center"
                      saveAction={saveLineAutosaveAction}
                      deleteAction={deleteLineAction}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Add line (draft only) */}
        {editable && (
        <form action={upsertLineAction} className="mt-3 rounded-lg border border-dashed border-cc-brand-200 p-3">
          <input type="hidden" name="app_id" value={application.id} />
                <Ctx />
          <div className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end">
            <label className="sm:col-span-1 block">
              <span className="block text-[9px] font-bold uppercase tracking-wide text-ppp-charcoal-400">Item</span>
              <input name="item_no" className={`${INPUT_CLS} !py-1.5 text-[12px]`} placeholder="1" />
            </label>
            <label className="col-span-2 sm:col-span-5 block">
              <span className="block text-[9px] font-bold uppercase tracking-wide text-ppp-charcoal-400">Description</span>
              <input name="description" maxLength={500} className={`${INPUT_CLS} !py-1.5 text-[12px]`} placeholder="Line of work" />
            </label>
            <label className="block">
              <span className="block text-[9px] font-bold uppercase tracking-wide text-ppp-charcoal-400">Scheduled</span>
              <input name="scheduled" inputMode="decimal" className={`${INPUT_CLS} !py-1.5 text-[12px] tabular-nums`} placeholder="0.00" />
            </label>
            <label className="block">
              <span className="block text-[9px] font-bold uppercase tracking-wide text-ppp-charcoal-400">This period</span>
              <input name="this_period" inputMode="decimal" className={`${INPUT_CLS} !py-1.5 text-[12px] tabular-nums`} placeholder="0.00" />
            </label>
            <div className="sm:col-span-3 flex justify-end">
              <PendingSubmitButton pendingLabel="Adding…" className="px-3.5 py-2 rounded-lg bg-cc-brand-600 text-white text-[12px] font-semibold hover:bg-cc-brand-700 min-h-[44px]">Add line</PendingSubmitButton>
            </div>
          </div>
        </form>
        )}
      </section>
    </div>
  );
}
