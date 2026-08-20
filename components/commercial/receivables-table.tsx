import Link from "next/link";
import { formatCentsFull, formatCentsCompact } from "@/lib/commercial/invoices/format";
import { PendingSubmitButton } from "@/components/commercial/pending-submit-button";
import type { ReceivableRow } from "@/lib/commercial/reports/receivables";

/**
 * The receivables list — Mary's chase table.
 *
 * ONE implementation, rendered on both the Receivables report and the
 * Accounting page's Receivables view. Two copies of a table people type notes
 * into is two places for the note to be saved differently.
 *
 * The save action is a prop rather than an import because each host has to
 * revalidate its OWN path after a write — the report and the Accounting page
 * are different routes, and revalidating the wrong one leaves a saved note
 * invisible until a hard refresh.
 */

const KIND_META: Record<ReceivableRow["kind"], { label: string; cls: string }> = {
  invoice: { label: "Invoice", cls: "bg-ppp-blue-50 text-ppp-blue-800 border-ppp-blue-200" },
  aia: { label: "AIA", cls: "bg-cc-brand-50 text-cc-brand-700 border-cc-brand-200" },
  // Grey, never red: retention isn't late, it's held to close-out. Colouring it
  // like an overdue invoice would make every progress-billed job look sick.
  retainage: { label: "Retention", cls: "bg-ppp-charcoal-100 text-ppp-charcoal-600 border-ppp-charcoal-200" },
};

export function ReceivablesTable({
  rows,
  totalOpenCents,
  saveNoteAction,
}: {
  rows: ReceivableRow[];
  totalOpenCents: number;
  saveNoteAction: (formData: FormData) => Promise<void>;
}) {
  if (rows.length === 0) {
    return (
      <div className="bg-surface border border-ppp-charcoal-100 rounded-xl">
        <p className="px-4 py-10 text-center text-[13px] text-ppp-charcoal-500">
          Nothing outstanding. Every invoice is paid and no retention is being held.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
      {/* ── Phone: cards. "What's owed and what's happening" gets asked away
             from a desk more often than at one. ── */}
      <ul className="sm:hidden divide-y divide-ppp-charcoal-100">
        {rows.map((r) => (
          <li key={r.key} className="px-3.5 py-3">
            <div className="flex items-start justify-between gap-2">
              <Link
                href={r.billingHref ?? r.href}
                className="text-[13.5px] font-semibold text-ppp-charcoal leading-snug min-w-0 hover:text-cc-brand-700"
              >
                {r.jobName}
              </Link>
              <span className="text-[14px] font-bold tabular-nums shrink-0">
                {formatCentsCompact(r.openCents)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap mt-1">
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wide ${KIND_META[r.kind].cls}`}>
                {KIND_META[r.kind].label}
              </span>
              <Link
                href={r.href}
                className="text-[11px] text-ppp-charcoal-500 hover:text-cc-brand-700 underline decoration-dotted underline-offset-2"
              >
                {r.reference}
              </Link>
              {r.daysOut !== null && r.daysOut > 0 && (
                <span className="text-[11px] font-semibold text-rose-700">{r.daysOut}d late</span>
              )}
            </div>
            <NoteForm rowKey={r.key} note={r.note} action={saveNoteAction} />
          </li>
        ))}
      </ul>

      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-[12.5px] min-w-[820px]">
          <thead>
            <tr className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 bg-ppp-charcoal-50/60 text-left">
              <th className="px-3 py-2.5">Job</th>
              <th className="px-3 py-2.5">Reference</th>
              <th className="px-3 py-2.5 text-right">Billed / open</th>
              <th className="px-3 py-2.5 text-right">Age</th>
              <th className="px-3 py-2.5 w-[34%]">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ppp-charcoal-100">
            {rows.map((r) => (
              <tr key={r.key} className="hover:bg-cc-brand-50/30 align-top">
                {/* Two destinations on purpose. On a chase call the question is
                    "what has this JOB been billed and what's been paid", which
                    the single document can't answer — so the job name opens the
                    job's billing and the reference opens the document. */}
                <td className="px-3 py-2.5">
                  <Link
                    href={r.billingHref ?? r.href}
                    className="font-semibold text-ppp-charcoal hover:text-cc-brand-700 hover:underline"
                  >
                    {r.jobName}
                  </Link>
                  <Link
                    href={`/commercial/accounts/${r.accountId}`}
                    className="block text-[10.5px] text-ppp-charcoal-400 hover:text-cc-brand-700 hover:underline w-fit"
                  >
                    {r.accountName}
                  </Link>
                </td>
                <td className="px-3 py-2.5">
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9.5px] font-bold uppercase tracking-wide mr-1.5 ${KIND_META[r.kind].cls}`}>
                    {KIND_META[r.kind].label}
                  </span>
                  <Link href={r.href} className="text-ppp-charcoal-600 hover:text-cc-brand-700 hover:underline">
                    {r.reference}
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-ppp-charcoal">
                  {formatCentsFull(r.openCents)}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  {r.daysOut === null ? (
                    <span className="text-ppp-charcoal-300">—</span>
                  ) : r.daysOut > 0 ? (
                    <span className="text-rose-700 font-semibold">{r.daysOut}d late</span>
                  ) : (
                    <span className="text-ppp-charcoal-500">current</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <NoteForm rowKey={r.key} note={r.note} action={saveNoteAction} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-ppp-charcoal-200 bg-ppp-charcoal-50/60 font-bold">
              <td className="px-3 py-2.5" colSpan={2}>Total outstanding</td>
              <td className="px-3 py-2.5 text-right tabular-nums">{formatCentsFull(totalOpenCents)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/** Inline note — save-on-submit, no modal. A chase note is ten seconds of
 *  typing after a phone call; anything heavier and it doesn't get written. */
function NoteForm({
  rowKey,
  note,
  action,
}: {
  rowKey: string;
  note: string | null;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action} className="flex items-center gap-1.5 mt-1.5 sm:mt-0">
      <input type="hidden" name="row_key" value={rowKey} />
      <input
        name="note"
        defaultValue={note ?? ""}
        maxLength={500}
        placeholder="e.g. 8/19 asked for update"
        aria-label="Collection note"
        className="flex-1 min-w-0 px-2 py-1.5 text-base sm:text-[12px] bg-surface border border-ppp-charcoal-200 rounded-md focus:outline-none focus:ring-2 focus:ring-cc-brand-600/30 focus:border-cc-brand-600 min-h-[44px] sm:min-h-[32px]"
      />
      <PendingSubmitButton
        pendingLabel="…"
        className="shrink-0 px-2.5 py-1.5 rounded-md border border-ppp-charcoal-200 text-[11.5px] font-semibold text-ppp-charcoal-600 hover:bg-ppp-charcoal-50 min-h-[44px] sm:min-h-[32px] inline-flex items-center"
      >
        Save
      </PendingSubmitButton>
    </form>
  );
}
