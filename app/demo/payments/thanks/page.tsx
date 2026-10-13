import Link from "next/link";
import { PayMessage, PayShell } from "@/components/pay/pay-shell";
import { formatCents } from "@/lib/payments/schedule";
import { DEMO_TERMS } from "@/lib/payments/demo";
import { SIM_METHOD_LABEL, SIM_NOTE, SIM_WO, parsePaid, simCharge } from "@/lib/payments/demo-sim";

export const dynamic = "force-dynamic";
export const metadata = { title: "Thank you · Demo · Precision Painting Plus", robots: { index: false } };

/**
 * Simulated demo — the thank-you page, plus a "behind the scenes" card that a
 * real customer never sees: what the office and Salesforce get from this
 * payment. That's the half of the story the demo is for.
 */
export default async function DemoThanksPage({ searchParams }: { searchParams: Promise<{ p?: string }> }) {
  const paid = parsePaid((await searchParams).p);
  const p = paid.join("");
  const i = paid.length - 1;
  const back = `/demo/payments/invoice?p=${p}`;
  if (i < 0) {
    return (
      <PayShell previewNote={SIM_NOTE}>
        <PayMessage tone="warn" heading="Nothing was paid" body={<Link href={back}>Back to the invoice</Link>} />
      </PayShell>
    );
  }
  const method = paid[i];
  const label = DEMO_TERMS[i].type ?? "Payment";
  const charge = simCharge(i, method);
  const bank = method === "b";

  return (
    <PayShell previewNote={SIM_NOTE}>
      <div className="space-y-5">
        <PayMessage
          tone="ok"
          heading={bank ? "Bank payment started" : "Payment received — thank you!"}
          body={
            bank
              ? `Your ${formatCents(charge.totalCents)} ${label.toLowerCase()} payment is on its way from your bank. It takes about 4 business days to clear; you don't need to do anything else.`
              : `We've received ${formatCents(charge.totalCents)} for your ${label.toLowerCase()} on invoice ${SIM_WO.number}. A receipt is on its way to your email.`
          }
        />

        <Link
          href={back}
          className="flex w-full items-center justify-center rounded-xl bg-ppp-navy text-white px-4 py-3 font-semibold min-h-[48px] hover:bg-ppp-navy-900"
        >
          Back to your invoice
        </Link>

        <section className="rounded-2xl border border-dashed border-ppp-charcoal-300 bg-white p-5 sm:p-6">
          <div className="text-[11px] font-condensed uppercase tracking-[0.16em] text-ppp-orange-700">
            Demo only · behind the scenes
          </div>
          <h2 className="mt-1 text-base font-bold text-ppp-navy">What the office gets — automatically</h2>
          <dl className="mt-3 divide-y divide-ppp-charcoal-100 text-[13px]">
            <Line k="Paid with" v={SIM_METHOD_LABEL[method]} />
            <Line k="Toward the job" v={formatCents(charge.baseCents)} />
            <Line k="Card fee (kept separate)" v={charge.feeCents ? formatCents(charge.feeCents) : "None"} />
            <Line k="Customer paid in total" v={formatCents(charge.totalCents)} />
          </dl>
          <ul className="mt-4 space-y-2 text-[13px] leading-relaxed text-ppp-charcoal-700">
            <li>
              <strong className="text-ppp-navy">Command Center:</strong> shows up straight away on the Payments tab, under
              this job, with the fee in its own column — and in the next morning&rsquo;s email with the Excel file.
            </li>
            <li>
              <strong className="text-ppp-navy">Salesforce:</strong> when Stripe deposits the money{bank ? " (after the transfer clears)" : " (1–2 days)"}, a
              Payment In of {formatCents(charge.baseCents)} — never the fee — is added to the Work Order, and the{" "}
              {label} Payment Term is marked paid. Nobody types anything in.
            </li>
          </ul>
        </section>
      </div>
    </PayShell>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 py-2">
      <dt className="text-ppp-charcoal-600">{k}</dt>
      <dd className="font-semibold tabular-nums text-ppp-navy">{v}</dd>
    </div>
  );
}
