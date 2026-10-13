import Link from "next/link";
import { PayMessage, PayShell } from "@/components/pay/pay-shell";
import { formatCents, type Milestone } from "@/lib/payments/schedule";
import { SIM_NOTE, SIM_WO, parsePaid, simSchedule, type SimMethod } from "@/lib/payments/demo-sim";
import { cardFeeCents } from "@/lib/payments/schedule";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pay your invoice · Demo · Precision Painting Plus", robots: { index: false } };

/**
 * Simulated demo — the customer's invoice page, laid out exactly like
 * /pay/<token>, for a made-up job. See lib/payments/demo-sim.ts.
 */

const STATUS_CHIP: Record<Milestone["status"], { label: string; cls: string }> = {
  paid: { label: "Paid", cls: "bg-ppp-green-50 text-ppp-green-700 border-ppp-green-100" },
  processing: { label: "Processing", cls: "bg-ppp-blue-50 text-ppp-blue-800 border-ppp-blue-200" },
  due: { label: "Due now", cls: "bg-ppp-orange-50 text-ppp-orange-700 border-ppp-orange-100" },
  upcoming: { label: "Upcoming", cls: "bg-ppp-charcoal-50 text-ppp-charcoal-700 border-ppp-charcoal-200" },
};

export default async function DemoInvoicePage({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const paid = parsePaid((await searchParams).p);
  const schedule = simSchedule(paid);
  const nothingOwed = schedule.payableBalanceCents <= 0;
  const p = paid.join("");

  return (
    <PayShell previewNote={SIM_NOTE}>
      <div className="space-y-5">
        <section className="bg-white border border-ppp-charcoal-100 rounded-2xl p-5 sm:p-6">
          <div className="text-[11px] font-condensed uppercase tracking-[0.16em] text-ppp-charcoal-500">
            Invoice {SIM_WO.number}
          </div>
          <h1 className="mt-1 text-xl sm:text-2xl font-bold text-ppp-navy">{SIM_WO.contactName}</h1>
          <p className="text-[13px] text-ppp-charcoal-600 mt-0.5">{SIM_WO.address}</p>
          <div className="mt-4 flex items-baseline justify-between gap-3 border-t border-ppp-charcoal-100 pt-4">
            <span className="text-sm text-ppp-charcoal-600">Remaining balance</span>
            <span className="text-2xl font-condensed font-bold text-ppp-navy tabular-nums">
              {formatCents(schedule.payableBalanceCents)}
            </span>
          </div>
          {schedule.inFlightCents > 0 && (
            <p className="mt-2 text-[12px] text-ppp-charcoal-600">
              You&rsquo;ve already paid {formatCents(schedule.inFlightCents)} online that&rsquo;s still being processed —
              it&rsquo;s been taken off the balance above.
            </p>
          )}
        </section>

        {nothingOwed ? (
          <PayMessage tone="ok" heading="You're all paid up" body="Thank you — there's nothing left to pay on this invoice." />
        ) : (
          <section className="bg-white border border-ppp-charcoal-100 rounded-2xl divide-y divide-ppp-charcoal-100">
            <div className="px-5 sm:px-6 py-4">
              <h2 className="text-sm font-bold text-ppp-navy">Payment schedule</h2>
              <p className="text-[12px] text-ppp-charcoal-600 mt-0.5">30% deposit · 40% progress · 30% final</p>
            </div>
            {schedule.milestones.map((m, i) => (
              <Row key={m.key} m={m} index={i} paid={paid} p={p} />
            ))}
          </section>
        )}

        {!nothingOwed && (
          <p className="text-[12px] leading-relaxed text-ppp-charcoal-600 px-1">
            Credit card payments include a 3.00% service fee, which does not exceed our cost of accepting the card. Debit
            card and bank transfer (ACH) payments have no fee.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[13px]">
          <Link href="/demo/payments" className="font-semibold text-ppp-navy underline underline-offset-4">
            ← Demo guide
          </Link>
          {paid.length > 0 && (
            <Link href="/demo/payments/invoice" className="font-semibold text-ppp-navy underline underline-offset-4">
              Start over
            </Link>
          )}
        </div>
      </div>
    </PayShell>
  );
}

function Row({ m, index, paid, p }: { m: Milestone; index: number; paid: SimMethod[]; p: string }) {
  const chip = STATUS_CHIP[m.status];
  const how = paid[index];
  return (
    <div className="px-5 sm:px-6 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-ppp-navy">{m.label}</div>
          {m.percent != null && <div className="text-[12px] text-ppp-charcoal-600">{m.percent}% of the job</div>}
          {how && (
            <div className="text-[12px] text-ppp-charcoal-600">
              Paid online by {how === "c" ? "credit card" : how === "d" ? "debit card" : "bank transfer"}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-condensed font-bold text-ppp-navy tabular-nums">{formatCents(m.amountCents)}</span>
          <span className={`text-[11px] font-semibold border rounded-full px-2 py-0.5 ${chip.cls}`}>{chip.label}</span>
        </div>
      </div>
      {m.status === "due" && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Link
            href={`/demo/payments/bank?p=${p}`}
            className="rounded-xl bg-ppp-navy text-white px-4 py-3 text-left hover:bg-ppp-navy-900"
          >
            <span className="block text-[12px] opacity-90">Pay by bank (ACH) · no fee</span>
            <span className="block text-lg font-condensed font-bold tabular-nums">{formatCents(m.remainingCents)}</span>
          </Link>
          <Link
            href={`/demo/payments/card?p=${p}`}
            className="rounded-xl border border-ppp-charcoal-300 bg-white text-ppp-navy px-4 py-3 text-left hover:bg-ppp-charcoal-50"
          >
            <span className="block text-[12px] text-ppp-charcoal-600">Pay by card</span>
            <span className="block text-[13px] text-ppp-navy tabular-nums">
              Debit <span className="font-condensed font-bold text-lg">{formatCents(m.remainingCents)}</span>
            </span>
            <span className="block text-[12px] text-ppp-charcoal-600 tabular-nums">
              Credit {formatCents(m.remainingCents + cardFeeCents(m.remainingCents))} (incl. 3%)
            </span>
          </Link>
        </div>
      )}
    </div>
  );
}
