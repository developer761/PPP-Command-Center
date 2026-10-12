import Link from "next/link";
import { redirect } from "next/navigation";
import { formatCents } from "@/lib/payments/schedule";
import { DEMO_TERMS } from "@/lib/payments/demo";
import { SIM_NOTE, SIM_WO, parsePaid, simCharge } from "@/lib/payments/demo-sim";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pay by bank · Demo", robots: { index: false } };

/**
 * Simulated demo — stands in for Stripe's own hosted bank-payment page, which
 * is where a real ACH payment happens (the customer signs in to their bank
 * there). Deliberately Stripe-plain, not PPP-branded, so the hand-off reads
 * the way it will for a customer.
 */
export default async function DemoBankPage({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const paid = parsePaid((await searchParams).p);
  const p = paid.join("");
  const term = paid.length;
  if (term >= DEMO_TERMS.length) redirect(`/demo/payments/invoice?p=${p}`);
  const charge = simCharge(term, "b");

  return (
    <div className="min-h-screen bg-white">
      <div className="bg-ppp-orange-50 border-b border-ppp-orange-100 text-ppp-orange-700 text-[12px] sm:text-[13px] px-4 py-2 text-center">
        {SIM_NOTE} This screen stands in for Stripe&rsquo;s own bank page.
      </div>
      <main className="mx-auto max-w-md px-4 py-8 space-y-6">
        <Link href={`/demo/payments/invoice?p=${p}`} className="text-sm text-ppp-charcoal-600 underline underline-offset-4">
          ← Precision Painting Plus
        </Link>
        <div>
          <div className="text-[14px] text-ppp-charcoal-600">
            Invoice {SIM_WO.number} · {DEMO_TERMS[term].type}
          </div>
          <div className="mt-1 text-3xl font-bold text-ppp-charcoal tabular-nums">{formatCents(charge.totalCents)}</div>
        </div>
        <div className="space-y-3">
          <div className="text-[13px] font-semibold text-ppp-charcoal">US bank account</div>
          <div className="rounded-lg border border-ppp-charcoal-200 p-4">
            <div className="text-[14px] font-semibold text-ppp-charcoal">Test Institution</div>
            <div className="text-[13px] text-ppp-charcoal-600">Checking •••• 6789 — connected</div>
          </div>
          <p className="text-[12px] leading-relaxed text-ppp-charcoal-600">
            A real customer picks their bank and signs in to it here. Bank transfers take about 4 business days to clear,
            and there&rsquo;s no fee.
          </p>
        </div>
        <Link
          href={`/demo/payments/thanks?p=${p}b`}
          className="flex w-full items-center justify-center rounded-lg bg-ppp-navy text-white px-4 font-semibold min-h-[48px] hover:bg-ppp-navy-900"
        >
          Pay {formatCents(charge.totalCents)}
        </Link>
      </main>
    </div>
  );
}
