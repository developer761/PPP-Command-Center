import Link from "next/link";
import { formatCentsFull } from "@/lib/commercial/invoices/format";
import { DepositCheckbox } from "@/components/commercial/deposit-checkbox";
import type { TransactionsReport, TxnRow } from "@/lib/commercial/reports/transactions";

/**
 * The ledger, laid out the way Alex's Salesforce report reads.
 *
 * Month header with its record count · rows · a subtotal line under each month
 * · a grand total at the top. That structure is not decoration: it is how he
 * closes a month, and changing it would mean he has to learn a second thing
 * that does the same job.
 *
 * What his report can't do, and this does: money OUT in the same list, so each
 * month shows a NET; and the Deposited tick is a control rather than a
 * read-only checkbox, because ticking it here is the point.
 */

const KIND_CLS: Record<string, string> = {
  in: "bg-emerald-50 text-emerald-800 border-emerald-200",
  out: "bg-amber-50 text-amber-800 border-amber-200",
};

export function TransactionsLedger({
  report,
  emptyMessage,
  backHref,
}: {
  report: TransactionsReport;
  emptyMessage?: string;
  /** Where the invoice page's Back button should return to — see the same
   *  prop on ReceivablesTable. `/commercial/invoices` has no sidebar entry. */
  backHref?: string;
}) {
  if (report.months.length === 0) {
    return (
      <div className="bg-surface border border-ppp-charcoal-100 rounded-xl">
        <p className="px-4 py-10 text-center text-[13px] text-ppp-charcoal-500 max-w-md mx-auto">
          {emptyMessage ?? "No money has moved yet — no payments received and no purchases logged."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {report.months.map((m) => (
        <div key={m.key} className="bg-surface border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          {/* Month header — his grouping, with the record count he relies on
              to know a month is complete. */}
          <div className="flex items-baseline justify-between gap-3 flex-wrap px-3.5 py-2.5 bg-ppp-charcoal-50/60 border-b border-ppp-charcoal-100">
            <h3 className="text-[13.5px] font-bold text-ppp-charcoal">
              {m.label}{" "}
              <span className="font-normal text-ppp-charcoal-500">
                ({m.rows.length} record{m.rows.length === 1 ? "" : "s"})
              </span>
            </h3>
            <div className="flex items-center gap-3 text-[12px] tabular-nums">
              {m.inCents > 0 && <span className="text-emerald-700 font-semibold">+{formatCentsFull(m.inCents)}</span>}
              {m.outCents > 0 && <span className="text-amber-700 font-semibold">−{formatCentsFull(m.outCents)}</span>}
              {m.inCents > 0 && m.outCents > 0 && (
                // The number none of his three separate reports can show.
                <span className={`font-bold ${m.netCents < 0 ? "text-rose-700" : "text-ppp-charcoal"}`}>
                  net {formatCentsFull(m.netCents)}
                </span>
              )}
            </div>
          </div>

          {/* Phone: cards. */}
          <ul className="sm:hidden divide-y divide-ppp-charcoal-100">
            {m.rows.map((r) => (
              <li key={r.id} className="px-3.5 py-3">
                <div className="flex items-start justify-between gap-2">
                  <NameCell r={r} backHref={backHref} />
                  <span className={`text-[14px] font-bold tabular-nums shrink-0 ${r.direction === "in" ? "text-emerald-700" : "text-amber-700"}`}>
                    {r.direction === "in" ? "+" : "−"}
                    {formatCentsFull(r.amountCents)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap mt-1">
                  <TypePill r={r} />
                  <span className="text-[11px] text-ppp-charcoal-500">{fmtDay(r.dateYmd)}</span>
                  {r.reference && <span className="text-[11px] text-ppp-charcoal-400 truncate">· {r.reference}</span>}
                </div>
                {r.depositable && (
                  <div className="mt-1.5">
                    <DepositToggle r={r} />
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-[12.5px] min-w-[860px]">
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-wider text-ppp-charcoal-500 text-left">
                  <th className="px-3 py-2 w-[92px]">Date</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2 w-[130px]">Record type</th>
                  <th className="px-3 py-2 text-right w-[120px]">Amount</th>
                  <th className="px-3 py-2 w-[124px]">Deposited</th>
                  <th className="px-3 py-2 w-[180px]">Reference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ppp-charcoal-100">
                {m.rows.map((r) => (
                  <tr key={r.id} className="hover:bg-cc-brand-50/30 align-top">
                    <td className="px-3 py-2.5 tabular-nums text-ppp-charcoal-600">{fmtDay(r.dateYmd)}</td>
                    <td className="px-3 py-2.5"><NameCell r={r} backHref={backHref} /></td>
                    <td className="px-3 py-2.5"><TypePill r={r} /></td>
                    <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${r.direction === "in" ? "text-emerald-700" : "text-amber-700"}`}>
                      {r.direction === "in" ? "+" : "−"}
                      {formatCentsFull(r.amountCents)}
                    </td>
                    <td className="px-3 py-2.5">
                      {r.depositable ? (
                        <DepositToggle r={r} />
                      ) : (
                        // A purchase has nothing to clear. An empty box would
                        // read as "not deposited yet", which is a different and
                        // wrong statement.
                        <span className="text-ppp-charcoal-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-ppp-charcoal-500 truncate max-w-[180px]">{r.reference ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
              {/* His subtotal line, in his position: under the month. */}
              <tfoot>
                <tr className="border-t-2 border-ppp-charcoal-200 bg-ppp-charcoal-50/60 font-bold">
                  <td className="px-3 py-2.5" colSpan={3}>Subtotal</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${m.netCents < 0 ? "text-rose-700" : ""}`}>
                    {formatCentsFull(m.inCents > 0 && m.outCents > 0 ? m.netCents : m.inCents || -m.outCents)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function fmtDay(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}`;
}

function NameCell({ r, backHref }: { r: TxnRow; backHref?: string }) {
  const href =
    r.href && backHref && r.href.startsWith("/commercial/invoices/")
      ? `${r.href}?from=${encodeURIComponent(backHref)}`
      : r.href;
  const inner = (
    <>
      <span className="text-[13px] font-semibold text-ppp-charcoal leading-snug">{r.name}</span>
      {r.accountName && r.accountName !== r.name && (
        <span className="block text-[10.5px] text-ppp-charcoal-400">{r.accountName}</span>
      )}
    </>
  );
  // Never a dead end: every figure opens the record behind it, and comes back.
  return href ? (
    <Link href={href} className="min-w-0 hover:text-cc-brand-700 block">
      {inner}
    </Link>
  ) : (
    <span className="min-w-0 block">{inner}</span>
  );
}

function TypePill({ r }: { r: TxnRow }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9.5px] font-bold uppercase tracking-wide ${KIND_CLS[r.direction]}`}>
      {r.recordType}
    </span>
  );
}

/**
 * The Deposited control — the SAME control the Deposits tab uses.
 *
 * It used to be a form posting a server action, which is the thing Karan
 * called out on 2026-09-17: "just make it simple checkboxes that are quick —
 * this Deposited button takes so long to load." Every tick called
 * `revalidatePath`, so it re-ran the whole Accounting page — receivables, the
 * cost breakdown, the project rollups and 112 ledger rows — before the tick
 * appeared.
 *
 * That was fixed on Deposits and left standing here, so the one page had two
 * controls for one action: a tick that is instant on one tab and a button that
 * rebuilds the page on the other, under two different names. Mary reconciles
 * from whichever tab the money is easiest to find in, and her handbook had to
 * teach both. One control, one name, one speed.
 *
 * Still untickable — a deposit that bounced has to be reversible, and an
 * irreversible tick is one nobody dares use.
 */
function DepositToggle({ r }: { r: TxnRow }) {
  return (
    <DepositCheckbox
      paymentId={r.id.replace(/^pay:/, "")}
      initial={!!r.depositedAtIso}
    />
  );
}
